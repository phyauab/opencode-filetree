import { createSignal, type Setter } from "solid-js"
import type { DirEntry } from "./fileSystem"
import { computeVisibleNodes, type VisibleNode } from "./treeLogic"
import type { ChildrenMap, FailuresMap } from "./loader"
import { computeViewport, viewportHeight, type Viewport } from "./viewport"

export type TreeState = {
  entries: () => DirEntry[]
  setEntries: Setter<DirEntry[]>
  childrenMap: () => ChildrenMap
  setChildrenMap: Setter<ChildrenMap>
  failures: () => FailuresMap
  setFailures: Setter<FailuresMap>
  expanded: () => Set<string>
  setExpanded: Setter<Set<string>>
  cursor: () => number
  setCursor: Setter<number>
  gitStatusMap: () => Map<string, string>
  setGitStatusMap: Setter<Map<string, string>>
  visibleNodes: () => VisibleNode[]
  currentEntry: () => DirEntry | undefined
  /** Moves the cursor back inside the tree after it shrinks. */
  clampCursor: () => void
  /** Re-reads the project root. Installed by the FileTree component. */
  setReload: (fn: () => void) => void
  reload: () => void
  /** True until the project root has been read. */
  needsRootLoad: () => boolean
  setRootLoaded: (loaded: boolean) => void
  /**
   * True until the stored layout has been restored once. The stored layout is
   * where the session starts, not something to re-apply over the user's own
   * changes: restoring on every mount stomped them, so a folder collapsed during
   * the session sprang back open.
   */
  needsLayoutRestore: () => boolean
  markLayoutRestored: () => void
  /** Rows that fit the panel; the component sets this from the layout. */
  viewportHeight: () => number
  setViewportHeight: Setter<number>
  /** The slice of visible rows currently rendered. */
  viewport: () => Viewport
}

export function createTreeState(): TreeState {
  const [entries, setEntries] = createSignal<DirEntry[]>([])
  const [childrenMap, setChildrenMap] = createSignal<ChildrenMap>(new Map())
  const [failures, setFailures] = createSignal<FailuresMap>(new Map())
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [cursor, setCursor] = createSignal(0)
  const [gitStatusMap, setGitStatusMap] = createSignal<Map<string, string>>(new Map())
  const [height, setHeight] = createSignal(20)
  // A plain variable, not a signal: it is written and read inside the viewport
  // memo below, which already tracks everything it depends on.
  let scroll = 0
  let reloadFn: (() => void) | undefined
  // A plain flag for the same reason. This state outlives the tree component, so
  // the project root only needs reading once unless a refresh asks for it again.
  let rootLoaded = false
  // Same reasoning: the stored layout is a starting point for the session, not
  // something to re-apply over the user's own changes.
  let layoutRestored = false

  const visibleNodes = () => computeVisibleNodes(entries(), expanded(), childrenMap())

  const currentEntry = () => {
    const nodes = visibleNodes()
    const idx = cursor()
    return idx >= 0 && idx < nodes.length ? nodes[idx].entry : undefined
  }

  const clampCursor = () => {
    const max = visibleNodes().length
    if (max === 0) {
      if (cursor() !== 0) setCursor(0)
      return
    }
    if (cursor() > max - 1) setCursor(max - 1)
  }

  // A plain function rather than createMemo: memos outside a reactive root
  // (tests, the plugin's own setup) do not recompute on dependency change.
  const viewport = () => {
    const total = visibleNodes().length
    const view = computeViewport(total, cursor(), height(), scroll)
    scroll = view.start
    return view
  }

  return {
    entries,
    setEntries,
    childrenMap,
    setChildrenMap,
    failures,
    setFailures,
    expanded,
    setExpanded,
    cursor,
    setCursor,
    gitStatusMap,
    setGitStatusMap,
    visibleNodes,
    currentEntry,
    clampCursor,
    setReload: (fn) => {
      reloadFn = fn
    },
    reload: () => reloadFn?.(),
    needsRootLoad: () => !rootLoaded,
    setRootLoaded: (loaded: boolean) => {
      rootLoaded = loaded
    },
    needsLayoutRestore: () => !layoutRestored,
    markLayoutRestored: () => {
      layoutRestored = true
    },
    viewportHeight: () => viewportHeight(height()),
    setViewportHeight: setHeight,
    viewport,
  }
}
