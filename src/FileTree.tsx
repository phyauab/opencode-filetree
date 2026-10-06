import { createEffect, onCleanup, createSignal, For, Show, type Component } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { usePlugin } from "@opencode/plugin/tui"
import { readDir, watch, isGitRepo, getGitStatus, type DirEntry } from "./fileSystem"
import { loadDir, applyResult } from "./loader"
import { layoutKey } from "./persist"
import { restorePaths, persistPaths, shouldRestore, isRestorable } from "./layoutSync"
import { TreeNode } from "./TreeNode"
import type { TreeState } from "./store"

// --- Pure navigation logic (exported for testing) ---

export type VisibleNode = {
  entry: DirEntry
  depth: number
}

export function computeVisibleNodes(
  rootEntries: DirEntry[],
  expanded: Set<string>,
  childrenMap?: Map<string, DirEntry[]>,
  depth: number = 0,
  result: VisibleNode[] = [],
): VisibleNode[] {
  for (const entry of rootEntries) {
    result.push({ entry, depth })
    if (entry.isDirectory && expanded.has(entry.path) && childrenMap?.has(entry.path)) {
      computeVisibleNodes(childrenMap.get(entry.path)!, expanded, childrenMap, depth + 1, result)
    }
  }
  return result
}

export function moveCursor(current: number, delta: number, max: number): number {
  return Math.max(0, Math.min(max - 1, current + delta))
}

export function toggleExpand(path: string, expanded: Set<string>): Set<string> {
  const next = new Set(expanded)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

// --- Component ---

/** Milliseconds of filesystem quiet before the tree re-reads. */
const REFRESH_DEBOUNCE = 250

/** Rows reserved for the sidebar's own content, prompts, and the tree's hints. */
const SIDEBAR_CHROME_ROWS = 14

/** Fraction of the free terminal height the tree may use. */
const SIDEBAR_HEIGHT_SHARE = 0.6

type FileTreeProps = {
  state: TreeState
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const context = usePlugin()
  const state = props.state

  /** Bumped by a refresh to trigger a full re-read of the root. */
  const [reloadToken, setReloadToken] = createSignal(0)
  const reload = () => {
    state.setEntries([])
    state.setChildrenMap(new Map())
    state.setFailures(new Map())
    setReloadToken((n) => n + 1)
  }
  props.state.setReload(reload)

  // Git status is re-read on demand rather than on every filesystem event.
  const refreshGitStatus = async (dir: string) => {
    if (await isGitRepo(dir)) state.setGitStatusMap(await getGitStatus(dir))
    else state.setGitStatusMap(new Map())
  }

  // Durable layout: which folders were open, per project root.
  const layout = context.storage.memory(layoutKey(context.location?.directory ?? ""), {
    initial: { expanded: [] as string[] },
  })
  const [expandedLayout, setExpandedLayout] = layout

  // Restore the previous session's expansion once the root has been read.
  // Paths that no longer resolve to a directory are dropped rather than
  // restored, so a stale layout cannot expand a folder that was deleted.
  createEffect(() => {
    const entries = state.entries()
    if (!shouldRestore(expandedLayout, state.expanded(), entries.length > 0)) return

    const restorable = restorePaths(expandedLayout).filter((path) => isRestorable(path, entries))
    state.setExpanded(new Set(restorable))
  })

  // Persist every expansion change.
  createEffect(() => {
    const expanded = state.expanded()
    if (expanded.size === 0) return
    void setExpandedLayout((draft) => {
      draft.expanded = persistPaths(expanded)
    })
  })

  createEffect(() => {
    const dir = context.location?.directory
    if (!dir) return

    reloadToken()
    void loadDir(readDir, dir).then((result) => {
      state.setEntries(result.ok ? result.entries : [])
    })
    void refreshGitStatus(dir)

    // Coalesce bursts: a checkout or build fires thousands of events, and each
    // one would otherwise fork `git status` and `readDir`.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void loadDir(readDir, dir).then((result) => {
          if (result.ok) state.setEntries(result.entries)
        })
        void refreshGitStatus(dir)
      }, REFRESH_DEBOUNCE)
    }

    const unwatch = watch(dir, onChange)
    onCleanup(() => {
      if (timer) clearTimeout(timer)
      unwatch()
    })
  })

  // Lazy-load children of expanded folders that are not loaded yet.
  createEffect(() => {
    reloadToken()
    const children = state.childrenMap()
    const failures = state.failures()

    for (const path of state.expanded()) {
      // The root itself is never an entry in the tree, so skip it.
      if (path === context.location?.directory) continue
      if (children.has(path) || failures.has(path)) continue

      void loadDir(readDir, path).then((result) => {
        setTimeout(() => {
          state.setChildrenMap((prev) => applyResult(prev, state.failures(), path, result).children)
          state.setFailures((prev) => applyResult(children, prev, path, result).failures)
        }, 0)
      })
    }
  })

  // The tree can shrink under the cursor (collapse, or deleted files).
  createEffect(() => {
    state.visibleNodes().length
    state.cursor()
    state.clampCursor()
  })

  // The window is sized from the terminal, since the sidebar slot reports no
  // dimensions of its own. Leaving room for the sidebar's other content and the
  // "more above/below" hints keeps the last tree row visible.
  const dimensions = useTerminalDimensions()
  createEffect(() => {
    const available = dimensions().height - SIDEBAR_CHROME_ROWS
    state.setViewportHeight(Math.max(1, Math.floor(available * SIDEBAR_HEIGHT_SHARE)))
  })

  // Rows are windowed to the panel height, so a tree with thousands of entries
  // costs the same per frame as one with a dozen.
  const rows = () => {
    const nodes = state.visibleNodes()
    const view = state.viewport()
    const failures = state.failures()
    const slice: { node: (typeof nodes)[number]; index: number }[] = []
    for (let i = view.start; i < Math.min(view.end, nodes.length); i++) {
      slice.push({ node: nodes[i], index: i })
    }
    return { slice, failures, total: nodes.length, view }
  }

  return (
    <box>
      <Show when={rows().total > 0} fallback={<text fg="dim">no files</text>}>
        <For each={rows().slice}>
          {({ node, index }) => (
            <>
              <TreeNode
                entry={node.entry}
                depth={node.depth}
                isSelected={index === state.cursor()}
                isExpanded={state.expanded().has(node.entry.path)}
                gitStatus={state.gitStatusMap().get(node.entry.path)}
              />
              <Show when={rows().failures.get(node.entry.path)}>
                {(reason) => (
                  <text fg="yellow">
                    {"  ".repeat(node.depth + 1)}└ {reason()}
                  </text>
                )}
              </Show>
            </>
          )}
        </For>
        <Show when={rows().view.start > 0}>
          <text fg="dim"> ↑ {rows().view.start} more above</text>
        </Show>
        <Show when={rows().view.end < rows().total}>
          <text fg="dim"> ↓ {rows().total - rows().view.end} more below</text>
        </Show>
      </Show>
    </box>
  )
}