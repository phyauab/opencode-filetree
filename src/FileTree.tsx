import { createEffect, onCleanup, createSignal, For, Show, type Component } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { readDir, watch, isGitRepo, getGitStatus } from "./fileSystem"
import { computeVisibleNodes } from "./treeLogic"
import { loadDir, applyResult } from "./loader"
import { heightForTerminal, DEFAULT_TERMINAL_HEIGHT } from "./viewport"
import { layoutKey } from "./persist"
import { restorePaths, persistPaths, shouldRestore, isRestorable } from "./layoutSync"
import { TreeNode } from "./TreeNode"
import type { TreeState } from "./store"

// Pure navigation logic lives in treeLogic.ts, which imports no JSX, so it
// stays testable without OpenCode's runtime.

export { computeVisibleNodes }

// --- Component ---

/** Milliseconds of filesystem quiet before the tree re-reads. */
const REFRESH_DEBOUNCE = 250

// Row budgeting lives in viewport.ts, which imports no TUI code.

type FileTreeProps = {
  state: TreeState
  /**
   * The plugin context, passed down by the plugin entry rather than read with
   * `usePlugin()`. Importing `usePlugin` from our own copy of
   * `@opencode/plugin/tui` yields a different Solid context object than the
   * one the host provides, so it always throws "PluginContextProvider is
   * missing". A type-only import is erased at build time and cannot do that.
   */
  context: Context
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const context = props.context
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
    void setExpandedLayout((draft: { expanded: string[] }) => {
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

  // The window is sized from the renderer on the plugin context, since the
  // sidebar slot reports no dimensions of its own. Reading the renderer
  // directly avoids `useTerminalDimensions`, which resolves a Solid context
  // from this package's own copy of @opentui/solid rather than the host's.
  // Leaving room for the sidebar's other content and the "more above/below"
  // hints keeps the last tree row visible.
  const [terminalHeight, setTerminalHeight] = createSignal(
    context.renderer?.height ?? DEFAULT_TERMINAL_HEIGHT,
  )

  createEffect(() => {
    const renderer = context.renderer
    if (!renderer) return

    const measure = () => {
      const next = renderer.height
      if (typeof next === "number" && next > 0) setTerminalHeight(next)
    }
    measure()

    renderer.on?.("resize", measure)
    onCleanup(() => renderer.off?.("resize", measure))

    state.setViewportHeight(heightForTerminal(terminalHeight()))
  })

  createEffect(() => {
    state.setViewportHeight(heightForTerminal(terminalHeight()))
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