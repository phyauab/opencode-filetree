import type { DirEntry } from "./fileSystem"
import { computeVisibleNodes, type VisibleNode } from "./treeLogic"
import type { ChildrenMap, FailuresMap } from "./loader"
import { computeViewport, type Viewport } from "./viewport"

/**
 * The small, frequently-changing part of the tree's state.
 *
 * The plugin entry puts this in `context.storage.memory`, a live Solid store:
 * "old and new generations share the same live store", updates are synchronous,
 * and values need not be JSON-serializable. Reading these properties inside a
 * Solid computation is reactive, which is what makes the host's own sidebar
 * sections update live.
 *
 * The plugin's own `createSignal` state was not reactive in that way:
 * diagnostics showed the cursor moving, folders expanding and every click
 * landing, with nothing drawn. Only unmounting and remounting the panel forced a
 * repaint, which is the flash.
 */
export type LiveTreeState = {
  cursor: number
  expanded: string[]
  viewportHeight: number
}

export type TreeState = {
  entries: () => DirEntry[]
  setEntries: (next: DirEntry[] | ((prev: DirEntry[]) => DirEntry[])) => void
  childrenMap: () => ChildrenMap
  setChildrenMap: (next: ChildrenMap | ((prev: ChildrenMap) => ChildrenMap)) => void
  failures: () => FailuresMap
  setFailures: (next: FailuresMap | ((prev: FailuresMap) => FailuresMap)) => void
  gitStatusMap: () => Map<string, string>
  setGitStatusMap: (next: Map<string, string> | ((prev: Map<string, string>) => Map<string, string>)) => void
  visibleNodes: () => VisibleNode[]
  currentEntry: () => DirEntry | undefined
  cursor: () => number
  setCursor: (next: number | ((prev: number) => number)) => void
  expanded: () => Set<string>
  setExpanded: (next: Set<string> | ((prev: Set<string>) => Set<string>)) => void
  viewportHeight: () => number
  setViewportHeight: (next: number | ((prev: number) => number)) => void
  /** Moves the cursor back inside the tree after it shrinks. */
  clampCursor: () => void
  /** Re-reads the project root. Installed by the FileTree component. */
  setReload: (fn: () => void) => void
  reload: () => void
  /** The live store, for reactive reads in the component. */
  live: LiveTreeState
  /** Rows that fit the panel; the component sets this from the layout. */
  setViewport: (next: Viewport | ((prev: Viewport) => Viewport)) => void
  viewport: () => Viewport
  /** Top row of the current window, carried between renders. */
  scroll: () => number
  setScroll: (next: number) => void
}

/** Builds the tree state around a live store. */
export function createTreeState(
  live: LiveTreeState = { cursor: 0, expanded: [], viewportHeight: 0 },
): TreeState {
  let entriesValue: DirEntry[] = []
  let childrenValue: ChildrenMap = new Map()
  let failuresValue: FailuresMap = new Map()
  let gitStatusValue: Map<string, string> = new Map()
  let reloadFn: () => void = () => {}
  let scroll = 0

  const entries = () => entriesValue
  const childrenMap = () => childrenValue
  const failures = () => failuresValue
  const gitStatusMap = () => gitStatusValue

  const visibleNodes = () =>
    computeVisibleNodes(entriesValue, new Set(live.expanded), childrenValue)
  const currentEntry = () => visibleNodes()[live.cursor]?.entry

  const state: TreeState = {
    entries,
    setEntries: (next) => {
      entriesValue = typeof next === "function" ? next(entriesValue) : next
    },
    childrenMap,
    setChildrenMap: (next) => {
      childrenValue = typeof next === "function" ? next(childrenValue) : next
    },
    failures,
    setFailures: (next) => {
      failuresValue = typeof next === "function" ? next(failuresValue) : next
    },
    gitStatusMap,
    setGitStatusMap: (next) => {
      gitStatusValue = typeof next === "function" ? next(gitStatusValue) : next
    },
    visibleNodes,
    currentEntry,
    cursor: () => live.cursor,
    setCursor: (next) => {
      live.cursor = typeof next === "function" ? next(live.cursor) : next
    },
    expanded: () => new Set(live.expanded),
    setExpanded: (next) => {
      const value = typeof next === "function" ? next(new Set(live.expanded)) : next
      live.expanded = [...value]
    },
    viewportHeight: () => live.viewportHeight,
    setViewportHeight: (next) => {
      live.viewportHeight = typeof next === "function" ? next(live.viewportHeight) : next
    },
    clampCursor: () => {
      const max = visibleNodes().length
      if (live.cursor >= max) live.cursor = Math.max(0, max - 1)
      if (live.cursor < 0) live.cursor = 0
    },
    setReload: (fn) => {
      reloadFn = fn
    },
    reload: () => reloadFn(),
    live,
    viewport: () => computeViewportState(state),
    setViewport: () => {},
    scroll: () => scroll,
    setScroll: (next: number) => {
      scroll = next
    },
  }

  return state
}

/**
 * Recomputes the windowed viewport.
 *
 * Delegates to computeViewport so the view keeps its documented behaviour: it
 * stays still while the cursor moves within it, and only scrolls as far as
 * needed to keep the cursor on screen. The scroll offset is carried between
 * calls so successive renders advance rather than jump.
 */
export function computeViewportState(state: TreeState): Viewport {
  const total = state.visibleNodes().length
  const view = computeViewport(total, state.cursor(), state.viewportHeight(), state.scroll())
  state.setScroll(view.start)
  return view
}
