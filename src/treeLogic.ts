import type { DirEntry } from "./fileSystem"

/** A row of the tree, with its nesting depth. */
export type VisibleNode = {
  entry: DirEntry
  depth: number
}

/**
 * Flattens the tree into the rows currently visible, recursing into folders the
 * user has expanded. Lives apart from the component so it can be tested without
 * OpenCode's JSX runtime.
 */
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

/** Moves the cursor by `delta`, clamped to the tree's bounds. */
export function moveCursor(current: number, delta: number, max: number): number {
  return Math.max(0, Math.min(max - 1, current + delta))
}

/** A new set with `path` added or removed. Never mutates the input. */
export function toggleExpand(path: string, expanded: Set<string>): Set<string> {
  const next = new Set(expanded)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}