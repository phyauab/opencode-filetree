import { createEffect, onCleanup, createSignal, untrack, Show, type Component } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { readDirSync, watch, getGitStatusSync } from "./fileSystem"
import { computeVisibleNodes, type VisibleNode } from "./treeLogic"
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

  const reload = () => {
    state.setEntries([])
    state.setChildrenMap(new Map())
    state.setFailures(new Map())
    // A refresh has to re-arm the root read, or the next mount would keep
    // showing what it already had and `r` would do nothing.
    state.setRootLoaded(false)
    setReloadToken((n) => n + 1)
  }
  state.setReload(reload)

  // Git status is read synchronously; see fileSystem.ts for why.
  const refreshGitStatus = (dir: string) => {
    state.setGitStatusMap(getGitStatusSync(dir))
  }

  /**
   * Reads the project root into the tree, and marks it loaded on success only.
   *
   * A failed read deliberately leaves the root marked as needing one. Marking it
   * loaded anyway made the panel report "no files" for a directory that has
   * them, and nothing could recover it: `watch` on a path that does not exist
   * returns a no-op, so no event would ever prompt another read.
   */
  const readRoot = (dir: string) => {
    const result = loadDirSync(readDirSync, dir)
    if (!result.ok) {
      setEmpty({ kind: "unreadable", reason: result.reason })
      return
    }
    state.setEntries(result.entries)
    setEmpty({ kind: "empty" })
    refreshGitStatus(dir)
    state.setRootLoaded(true)
  }

  // The directory is read in the component body, synchronously. The host's
  // plugin runtime does not reliably run promise continuations, so an await here
  // would leave the tree stuck on its loading state.
  //
  // Only the first successful read costs anything. This state outlives the tree
  // component, so a remount -- reopening the panel, or a hot reload -- reuses the
  // rows it already has. Re-reading each time put a directory walk and a forked
  // `git status` on the path that reopens the panel, and blanked the tree
  // whenever the root was briefly unreadable.
  const directory = resolveDirectory(context)
  if (!directory) {
    setEmpty({ kind: "no-location" })
  } else if (state.needsRootLoad()) {
    readRoot(directory)
  } else {
    setEmpty({ kind: "empty" })
  }

  // Durable layout: which folders were open, per project root.
  const [expandedLayout, setExpandedLayout] = context.storage.memory(
    layoutKey(untrack(() => resolveDirectory(context)) ?? ""),
    { initial: { expanded: [] as string[] } },
  )

  // Restore the previous session's expansion once the root has been read, and
  // only on the first mount. Every panel open remounts this component, and
  // restoring on each of those overwrote the user's own changes with the stored
  // layout -- so a folder collapsed during the session kept springing back open.
  createEffect(() => {
    const entries = state.entries()
    // Wait for the root so the decision is made against a real tree, and make it
    // exactly once per session -- whether or not anything actually gets restored.
    // Skipping the mark when there was nothing to restore left the effect armed,
    // so the next remount re-applied a layout the user had since changed.
    if (!state.needsLayoutRestore() || entries.length === 0) return
    state.markLayoutRestored()

    if (!shouldRestore(expandedLayout, state.expanded(), true)) return

    const root = untrack(() => resolveDirectory(context))
    if (!root) return

    // Only restore directories that exist in this project's root. Anything
    // else is stale or belongs to a different tree.
    const restorable = restorablePaths(restorePaths(expandedLayout), entries, root)
    state.setExpanded(new Set(restorable))
  })

  // Persist every expansion change, including collapsing everything.
  createEffect(() => {
    // Wait for the root to be read: until then the restore effect above has not
    // run, and writing here would overwrite the stored layout with an empty one.
    // The wait used to be `expanded.size > 0`, which meant "collapse the last
    // folder" was never recorded -- so the next panel open restored it and the one
    // folder the user had closed kept springing open.
    if (state.entries().length === 0) return
    const expanded = state.expanded()
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

    const reloadEntries = () => readRoot(dir)

    // A remount keeps the rows it already has; only a refresh re-reads here.
    if (state.needsRootLoad()) reloadEntries()

    // Coalesce bursts: a checkout or build fires thousands of events, and each
    // one would otherwise fork `git status` and `readDir`.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onChange = () => {
      if (timer) clearTimeout(timer)
      // Git status rides along with the row refresh. Only the first mount reads the
      // root, so without this a staged or committed file keeps its old badge
      // until the user presses `r`.
      timer = setTimeout(() => {
        reloadEntries()
        refreshGitStatus(dir)
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

  /*
   * The repaint. OpenTUI's renderer is demand-driven: it paints a frame when
   * something asks it to, and nothing in a plugin's state change does that on its
   * own. So the state moved, Solid updated the rows, and no frame was ever
   * scheduled -- the panel sat there showing exactly what it showed before, while
   * the tree underneath it was already correct. Reopening the panel showed the
   * right thing, which is what made this look like a state bug for so long.
   *
   * Asking the renderer for a frame is the documented way to get that repaint:
   * `requestRender()` schedules a one-shot frame and coalesces repeat calls, so a
   * burst of changes costs one frame and nothing is torn down.
   *
   * Reading every signal that changes what is visible turns all the ways the tree
   * can change -- keys, clicks, the file watcher, lazy folder loads -- into one
   * effect, so none of them can be forgotten again.
   */
  createEffect(() => {
    state.entries()
    state.childrenMap()
    state.expanded()
    state.cursor()
    state.failures()
    state.gitStatusMap()
    state.viewportHeight()
    empty()
    context.renderer.requestRender()
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

  /**
 * A fresh object whenever anything visible changes, used as the key for the row
 * list. Reading the signals here is what makes the memo recompute.
 */
  const snapshot = () => {
    const current = rows()
    return {
      slice: current.slice,
      failures: current.failures,
      expanded: state.expanded(),
      gitStatus: state.gitStatusMap(),
      total: current.total,
      view: current.view,
    }
  }

  /**
   * Handles a click anywhere in the tree: selects the clicked row, and expands
   * or collapses a folder.
   *
   * The row is derived from the click's Y rather than from a handler per row.
   * Per-row handlers on inner boxes received nothing: only the root box is in the
   * host's hit grid, which is why clicking it always worked. MouseEvent.y is
   * relative to the renderable it was dispatched on, so rows start at y 0.
   */
  const onClick = (event: { y: number }) => {
    const view = state.viewport()
    const index = view.start + Math.max(0, event.y)
    const nodes = state.visibleNodes()
    // Bound by the rows actually rendered, not by the whole tree: the
    // "N more below" and unreadable-folder hints are drawn inside this same box,
    // so a click on one of those lines must not select the tree entry sitting at
    // that index.
    if (index < view.start || index >= Math.min(view.end, nodes.length)) return
    const node = nodes[index]
    if (!node) return

    state.setCursor(index)
    if (node.entry.isDirectory) {
      state.setExpanded((prev) => toggleExpand(node.entry.path, prev))
    }
    state.clampCursor()
  }

  return (
    <box focusable onMouseDown={onClick}>
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
        {/* The repaint mechanism. `snapshot()` reads every signal that changes what is
            on screen -- cursor, expansion, git status, window, emptiness -- and
            returns a fresh object, so a `keyed` Show rebuilds the rows whenever
            anything visible moves. That is what makes a change land on screen.

            The panel itself is deliberately left alone. Closing and reopening it
            also forces a repaint, and it is what the user saw as a flash: the
            whole screen torn down and rebuilt to move a marker one row. The
            frame is requested by the repaint effect above instead. */}
        <Show when={snapshot()} keyed>
          {(snap) => (
            <TreeRows
              rows={snap.slice}
              failures={snap.failures}
              expanded={snap.expanded}
              gitStatus={snap.gitStatus}
              total={snap.total}
              view={snap.view}
            />
          )}
        </Show>
      </Show>
    </box>
  )
}

/** The rows, isolated so they can be remounted as a unit. */
const TreeRows: Component<{
  rows: { node: VisibleNode; selected: boolean }[]
  failures: Map<string, string>
  expanded: Set<string>
  gitStatus: Map<string, string>
  total: number
  view: { start: number; end: number }
}> = (props) => (
  <>
    {props.rows.map(({ node, selected }) => (
      <TreeNode
        entry={node.entry}
        depth={node.depth}
        isSelected={selected}
        isExpanded={props.expanded.has(node.entry.path)}
        gitStatus={props.gitStatus.get(node.entry.path)}
      />
    ))}
    <Show when={props.failures.size > 0}>
      <text fg="dim"> {props.failures.size} folder(s) unreadable</text>
    </Show>
    <Show when={props.view.start > 0}>
      <text fg="dim"> {props.view.start} more above</text>
    </Show>
    <Show when={props.view.end < props.total}>
      <text fg="dim"> {props.total - props.view.end} more below</text>
    </Show>
  </>
)
