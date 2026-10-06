import type { DirEntry } from "./fileSystem"
import { readLayout, writeLayout } from "./persist"

/**
 * The persistence decisions, kept out of the component so they can be tested
 * without a TUI or a storage backend.
 */

/** Reads the paths a previous session left expanded. */
export function restorePaths(stored: unknown): string[] {
  return readLayout(stored).expanded
}

/** The paths to persist for the current expansion state. */
export function persistPaths(expanded: Set<string>): string[] {
  return writeLayout(expanded).expanded
}

/** True when the restored expansion differs from what the tree shows now. */
export function shouldRestore(
  stored: unknown,
  current: Set<string>,
  rootLoaded: boolean,
): boolean {
  if (!rootLoaded) return false
  const paths = restorePaths(stored)
  if (paths.length === 0) return false
  if (paths.length !== current.size) return true
  for (const path of paths) if (!current.has(path)) return true
  return false
}

/**
 * True when a path in the restored layout is not a directory in the tree's
 * root. Such a path cannot be expanded, so it should not be restored.
 */
export function isRestorable(path: string, rootEntries: DirEntry[]): boolean {
  return rootEntries.some((entry) => entry.path === path && entry.isDirectory)
}