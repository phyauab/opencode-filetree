import { createSignal, type Setter } from "solid-js"
import type { DirEntry } from "./fileSystem"
import { computeVisibleNodes, type VisibleNode } from "./FileTree"
import type { ChildrenMap, FailuresMap } from "./loader"

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
}

export function createTreeState(): TreeState {
  const [entries, setEntries] = createSignal<DirEntry[]>([])
  const [childrenMap, setChildrenMap] = createSignal<ChildrenMap>(new Map())
  const [failures, setFailures] = createSignal<FailuresMap>(new Map())
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [cursor, setCursor] = createSignal(0)
  const [gitStatusMap, setGitStatusMap] = createSignal<Map<string, string>>(new Map())
  let reloadFn: (() => void) | undefined

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
  }
}