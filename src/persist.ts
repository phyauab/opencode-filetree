/**
 * Persistence for the tree's layout. Expanded folders are stored per project
 * root, so opening a second project does not inherit the first one's tree.
 */

/** What the plugin remembers between restarts. */
export type Layout = {
  /** Absolute paths of folders the user expanded. */
  expanded: string[]
}

/** Storage key for one project root. */
export function layoutKey(directory: string): string {
  return `filetree:layout:${directory}`
}

/** Reads a stored layout, tolerating absent or corrupt data. */
export function readLayout(value: unknown): Layout {
  if (!value || typeof value !== "object") return { expanded: [] }
  const expanded = (value as { expanded?: unknown }).expanded
  if (!Array.isArray(expanded)) return { expanded: [] }
  return { expanded: expanded.filter((item): item is string => typeof item === "string") }
}

/** Serializes a layout for durable storage. */
export function writeLayout(expanded: Set<string> | string[]): Layout {
  return { expanded: [...expanded] }
}