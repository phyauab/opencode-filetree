import type { DirEntry } from "./fileSystem"
import { isHidden } from "./icons"

/** Filters entries the tree does not display. */
export function filterVisible(entries: DirEntry[]): DirEntry[] {
  return entries.filter((entry) => !isHidden(entry.name, entry.isDirectory))
}

/** A directory the tree could not read, shown in place of its contents. */
export type FailedEntry = {
  entry: DirEntry
  reason: string
}

/** Human-readable message for a directory read failure. */
export function describeReadError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  if (code === "EACCES" || code === "EPERM") return "permission denied"
  if (code === "ENOENT") return "not found"
  if (code === "ENOTDIR") return "not a directory"
  return "unreadable"
}