/**
 * A slice of the visible tree that fits the panel, chosen so the cursor row is
 * always inside it.
 */
export type Viewport = {
  /** Index of the first rendered row. */
  start: number
  /** Index one past the last rendered row. */
  end: number
}

/** Rows that fit; never less than one, so the cursor is always renderable. */
export function viewportHeight(height: number): number {
  return Math.max(1, Math.floor(height))
}

/**
 * The window covering `cursor`, advanced from `scroll` only as far as needed.
 * Keeps the cursor on screen without scrolling when it is already visible, so
 * the view stays still while the user moves through it.
 */
export function computeViewport(
  total: number,
  cursor: number,
  height: number,
  scroll: number,
): Viewport {
  const rows = viewportHeight(height)

  if (total <= rows) return { start: 0, end: total }

  const clampedCursor = Math.max(0, Math.min(total - 1, cursor))
  let start = Math.max(0, Math.min(scroll, total - rows))

  if (clampedCursor < start) start = clampedCursor
  else if (clampedCursor >= start + rows) start = clampedCursor - rows + 1

  // A window near the end must not run past the final row.
  start = Math.max(0, Math.min(start, total - rows))
  return { start, end: start + rows }
}

/** Rows to render for a viewport, as 0-based indices. */
export function visibleRowIndices(total: number, viewport: Viewport): number[] {
  const indices: number[] = []
  const end = Math.min(viewport.end, total)
  for (let i = Math.max(0, viewport.start); i < end; i++) indices.push(i)
  return indices
}

/**
 * Scroll offset that keeps the cursor visible after the tree changes shape,
 * for when the caller has no stored offset to carry forward.
 */
export function scrollForCursor(total: number, cursor: number, height: number): number {
  const rows = viewportHeight(height)
  if (total <= rows) return 0
  return Math.max(0, Math.min(cursor - rows + 1, total - rows))
}