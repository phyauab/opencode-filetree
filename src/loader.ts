import type { DirEntry } from "./fileSystem"
import { filterVisible, describeReadError } from "./fileTreeData"

/** Result of loading one directory: either entries, or the reason it failed. */
export type LoadResult =
  | { ok: true; entries: DirEntry[] }
  | { ok: false; reason: string }

/**
 * Loads a directory synchronously, converting a failure into a value.
 *
 * The TUI plugin runtime does not reliably run promise continuations, so the
 * tree reads through this rather than the async `loadDir`. A project root is a
 * few milliseconds of blocking work, which is acceptable once at mount.
 */
export function loadDirSync(read: (path: string) => DirEntry[], path: string): LoadResult {
  try {
    return { ok: true, entries: filterVisible(read(path)) }
  } catch (error) {
    return { ok: false, reason: describeReadError(error) }
  }
}

/**
 * Loads a directory, converting a rejection into a value. Callers never see a
 * thrown promise, so an unreadable or vanished directory cannot take down the
 * TUI.
 */
export async function loadDir(read: (path: string) => Promise<DirEntry[]>, path: string): Promise<LoadResult> {
  try {
    return { ok: true, entries: filterVisible(await read(path)) }
  } catch (error) {
    return { ok: false, reason: describeReadError(error) }
  }
}

/** A directory that failed to load, kept so the tree can show why. */
export type LoadFailure = { path: string; reason: string }

export type ChildrenMap = Map<string, DirEntry[]>
export type FailuresMap = Map<string, string>

/** Merges a load result into the children and failures maps, immutably. */
export function applyResult(
  children: ChildrenMap,
  failures: FailuresMap,
  path: string,
  result: LoadResult,
): { children: ChildrenMap; failures: FailuresMap } {
  if (result.ok) {
    const nextChildren = new Map(children)
    nextChildren.set(path, result.entries)
    const nextFailures = new Map(failures)
    nextFailures.delete(path)
    return { children: nextChildren, failures: nextFailures }
  }
  const nextFailures = new Map(failures)
  nextFailures.set(path, result.reason)
  const nextChildren = new Map(children)
  nextChildren.delete(path)
  return { children: nextChildren, failures: nextFailures }
}