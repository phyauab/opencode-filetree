/**
 * Why the tree has nothing to show, and where the project directory comes from.
 * Kept apart from the component so it can be tested without OpenCode's runtime.
 */

/** Reason the tree has no rows. */
export type EmptyReason =
  | { kind: "no-location" }
  | { kind: "loading" }
  | { kind: "unreadable"; reason: string }
  | { kind: "empty" }

/** Message shown in place of an empty tree. */
export function describeEmpty(
  reason: EmptyReason,
  rows: number,
  viewportHeight: number,
): string {
  if (reason.kind === "no-location") return "no project directory"
  if (reason.kind === "loading") return "loading..."
  if (reason.kind === "unreadable") return `unreadable: ${reason.reason}`
  if (rows > 0 && viewportHeight < 1) return "panel too short"
  return "no files"
}

/** The slice of the plugin context this module needs. */
export type DirectorySource = {
  location?: { directory: string } | undefined
  data: { location: { default: () => { directory: string } } }
}

/**
 * The project directory. `context.location` can be undefined, so fall back to
 * the data layer's default location, as the CLI plugin docs show:
 * `context.location ?? context.data.location.default()`.
 */
export function resolveDirectory(context: DirectorySource): string | undefined {
  return context.location?.directory ?? context.data.location.default()?.directory
}