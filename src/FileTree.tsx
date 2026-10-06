import { createEffect, onCleanup, createSignal, For, Show, type Component } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { readDir, watch, isGitRepo, getGitStatus, type DirEntry } from "./fileSystem"
import { loadDir, applyResult } from "./loader"
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

  return (
    <box>
      <For each={state.visibleNodes()}>
        {(node, index) => (
          <>
            <TreeNode
              entry={node.entry}
              depth={node.depth}
              isSelected={index() === state.cursor()}
              isExpanded={state.expanded().has(node.entry.path)}
              gitStatus={state.gitStatusMap().get(node.entry.path)}
            />
            <Show when={state.failures().get(node.entry.path)}>
              {(reason) => (
                <text fg="yellow">
                  {"  ".repeat(node.depth + 1)}└ {reason()}
                </text>
              )}
            </Show>
          </>
        )}
      </For>
    </box>
  )
}