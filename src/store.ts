import { createSignal, type Setter } from "solid-js"
import type { DirEntry } from "./fileSystem"
import { computeVisibleNodes, type VisibleNode } from "./FileTree"

export type TreeState = {
  entries: () => DirEntry[]
  setEntries: Setter<DirEntry[]>
  childrenMap: () => Map<string, DirEntry[]>
  setChildrenMap: Setter<Map<string, DirEntry[]>>
  expanded: () => Set<string>
  setExpanded: Setter<Set<string>>
  cursor: () => number
  setCursor: Setter<number>
  gitStatusMap: () => Map<string, string>
  setGitStatusMap: Setter<Map<string, string>>
  visibleNodes: () => VisibleNode[]
  currentEntry: () => DirEntry | undefined
}

export function createTreeState(): TreeState {
  const [entries, setEntries] = createSignal<DirEntry[]>([])
  const [childrenMap, setChildrenMap] = createSignal<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [cursor, setCursor] = createSignal(0)
  const [gitStatusMap, setGitStatusMap] = createSignal<Map<string, string>>(new Map())

  const visibleNodes = () => computeVisibleNodes(entries(), expanded(), childrenMap())

  const currentEntry = () => {
    const nodes = visibleNodes()
    const idx = cursor()
    return idx >= 0 && idx < nodes.length ? nodes[idx].entry : undefined
  }

  return {
    entries,
    setEntries,
    childrenMap,
    setChildrenMap,
    expanded,
    setExpanded,
    cursor,
    setCursor,
    gitStatusMap,
    setGitStatusMap,
    visibleNodes,
    currentEntry,
  }
}
