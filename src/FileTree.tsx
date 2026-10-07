import { createEffect, onCleanup, createSignal, untrack, Show, type Component } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { readDirSync, watch, getGitStatusSync } from "./fileSystem"
import { computeVisibleNodes } from "./treeLogic"
import { loadDirSync, applyResult } from "./loader"
import { heightForTerminal, DEFAULT_TERMINAL_HEIGHT } from "./viewport"
import { layoutKey } from "./persist"
import { restorePaths, persistPaths, shouldRestore, restorablePaths } from "./layoutSync"
import { TreeNode } from "./TreeNode"
import type { TreeState } from "./store"
import { describeEmpty, resolveDirectory, type EmptyReason } from "./emptyState"
import { toggleExpand } from "./treeLogic"

// Pure navigation logic lives in treeLogic.ts, which imports no JSX, so it
// stays testable without OpenCode's runtime.

export { computeVisibleNodes }

/** Milliseconds of filesystem quiet before the tree re-reads. */
const REFRESH_DEBOUNCE = 250

type FileTreeProps = {
  state: TreeState
  /**
   * The plugin context, passed down by the plugin entry rather than read with
   * `usePlugin()`. Reading it from our own copy of `@opencode/plugin/tui`
   * yields a different Solid context object than the host's.
   */
  context: Context
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const context = props.context
  const state = props.state

  

  /** Bumped by a refresh to trigger a full re-read of the root. */
  const [reloadToken, setReloadToken] = createSignal(0)
  const [empty, setEmpty] = createSignal<EmptyReason>({ kind: "loading" })

  // The directory is read once, in the component body, rather than in an
  // effect: the host's renderer does not guarantee effect scheduling, and the
  // initial read must not depend on it.
  // (the read itself happens above, synchronously)

  const reload = () => {
    state.setEntries([])
    state.setChildrenMap(new Map())
    state.setFailures(new Map())
    setReloadToken((n) => n + 1)
  }
  state.setReload(reload)

  // Git status is read synchronously; see fileSystem.ts for why.
  const refreshGitStatus = (dir: string) => {
    state.setGitStatusMap(getGitStatusSync(dir))
  }

  // The directory is read once, in the component body, synchronously. The host's
  // plugin runtime does not reliably run promise continuations, so an await here
  // would leave the tree stuck on its loading state.
  const directory = resolveDirectory(context)
  if (!directory) {
    setEmpty({ kind: "no-location" })
  } else {
    const result = loadDirSync(readDirSync, directory)
    if (result.ok) {
      state.setEntries(result.entries)
      setEmpty({ kind: "empty" })
    } else {
      setEmpty({ kind: "unreadable", reason: result.reason })
    }
    refreshGitStatus(directory)
  }

  // Durable layout: which folders were open, per project root.
  const [expandedLayout, setExpandedLayout] = context.storage.memory(
    layoutKey(untrack(() => resolveDirectory(context)) ?? ""),
    { initial: { expanded: [] as string[] } },
  )

  // Restore the previous session's expansion once the root has been read.
  createEffect(() => {
    const entries = state.entries()
    if (!shouldRestore(expandedLayout, state.expanded(), entries.length > 0)) return

    const root = untrack(() => resolveDirectory(context))
    if (!root) return

    // Only restore directories that exist in this project's root. Anything
    // else is stale or belongs to a different tree.
    const restorable = restorablePaths(restorePaths(expandedLayout), entries, root)
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

  // Watch the project root for changes and re-read on demand.
  createEffect(() => {
    reloadToken()

    // Read the directory untracked. `context.data` is a live store that
    // publishes on every session event, so subscribing to it re-runs this
    // effect constantly and the tree never leaves its loading state.
    const dir = untrack(() => resolveDirectory(context))
    if (!dir) return

    const reloadEntries = () => {
      const result = loadDirSync(readDirSync, dir)
      if (result.ok) {
        state.setEntries(result.entries)
        setEmpty({ kind: "empty" })
      } else {
        state.setEntries([])
        setEmpty({ kind: "unreadable", reason: result.reason })
      }
    }

    reloadEntries()
    refreshGitStatus(dir)

    // Coalesce bursts: a checkout or build fires thousands of events, and each
    // one would otherwise fork `git status` and `readDir`.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(reloadEntries, REFRESH_DEBOUNCE)
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
      if (path === resolveDirectory(context)) continue
      if (children.has(path) || failures.has(path)) continue

      const result = loadDirSync(readDirSync, path)
      setTimeout(() => {
        state.setChildrenMap((prev) => applyResult(prev, state.failures(), path, result).children)
        state.setFailures((prev) => applyResult(children, prev, path, result).failures)
      }, 0)
    }
  })

  // The tree can shrink under the cursor (collapse, or deleted files).
  createEffect(() => {
    state.visibleNodes().length
    state.cursor()
    state.clampCursor()
  })

  // The window is sized from the renderer on the plugin context, since the
  // sidebar slot reports no dimensions of its own. Read untracked for the same
  // reason as the directory: the host's stores are live, and subscribing would
  // re-run the effect on every session event.
  const [terminalHeight, setTerminalHeight] = createSignal(
    untrack(() => context.renderer?.height) ?? DEFAULT_TERMINAL_HEIGHT,
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
  })

  createEffect(() => {
    state.setViewportHeight(heightForTerminal(terminalHeight()))
  })

  // Rows are windowed to the panel height, so a tree with thousands of entries
  // costs the same per frame as one with a dozen.
  //
  // cursor is read here so this memo tracks it. <For> builds its own per-item
  // memos, and in this host those did not repaint when the cursor moved: state
  // updated and the surrounding Show did repaint, but the rows did not.
  const rows = () => {
    const cursor = state.cursor()
    const nodes = state.visibleNodes()
    const view = state.viewport()
    const failures = state.failures()
    const slice: { node: (typeof nodes)[number]; index: number; selected: boolean }[] = []
    for (let i = view.start; i < Math.min(view.end, nodes.length); i++) {
      slice.push({ node: nodes[i], index: i, selected: i === cursor })
    }
    return { slice, failures, total: nodes.length, view, reason: empty(), directory }
  }

  /** Selects a row by index, ignoring positions outside the tree. */
  const select = (index: number) => {
    const nodes = state.visibleNodes()
    if (index < 0 || index >= nodes.length) return
    state.setCursor(index)
    state.clampCursor()
  }

  return (
    <box focusable onMouseDown={(event: { y: number }) => {
      const view = state.viewport()
      select(view.start + Math.max(0, event.y))
    }}>
      <Show
        when={rows().total > 0}
        fallback={
          <text fg="dim">
            {describeEmpty(
              rows().reason,
              rows().total,
              state.viewportHeight(),
              rows().directory,
            )}
          </text>
        }
      >
        {rows().slice.map(({ node, selected }) => (
          <TreeNode
            entry={node.entry}
            depth={node.depth}
            isSelected={selected}
            isExpanded={state.expanded().has(node.entry.path)}
            gitStatus={state.gitStatusMap().get(node.entry.path)}
          />
        ))}
        <Show when={rows().view.start > 0}>
          <text fg="dim"> {rows().view.start} more above</text>
        </Show>
        <Show when={rows().view.end < rows().total}>
          <text fg="dim"> {rows().total - rows().view.end} more below</text>
        </Show>
      </Show>
    </box>
  )
}