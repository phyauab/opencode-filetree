/**
 * Scroll math for the file viewer.
 *
 * Separate from the component for the same reason `treeLogic.ts` is: the host's
 * JSX runtime is not available here, and this is the part most worth pinning
 * down with tests.
 */

/** Largest legal scroll offset: keeps at least one line on screen. */
export function maxScroll(totalLines: number, visibleRows: number): number {
  // A panel that has not been laid out yet reports zero rows. Left alone that
  // would make the offset totalLines - 0, which is one past the end of the
  // file, so scrolling to the bottom would paint a blank panel. One row is the
  // least a viewer can honestly claim to show. The max(0, ...) covers the
  // opposite case, where a panel taller than the file would make the
  // subtraction negative.
  const rows = Math.max(1, visibleRows)
  return Math.max(0, totalLines - rows)
}

/**
 * Confines an offset to the scrollable range.
 *
 * Takes the already-computed limit rather than the line and row counts, so a
 * transposed pair of numbers cannot compile here.
 */
function clampTo(offset: number, limit: number): number {
  return Math.min(Math.max(offset, 0), limit)
}

/** Offset after a line-step, clamped to [0, maxScroll]. */
export function scrollByLine(scroll: number, delta: number, totalLines: number, visibleRows: number): number {
  return clampTo(scroll + delta, maxScroll(totalLines, visibleRows))
}

/** Offset after a page-step, clamped the same way. */
export function scrollByPage(
  scroll: number,
  direction: -1 | 1,
  totalLines: number,
  visibleRows: number,
): number {
  // Half a screen, so the reader keeps their place when the step reverses
  // direction. The floor of one keeps the key live on a one-row panel, whose
  // half is zero and would leave the key apparently stuck.
  const step = Math.max(1, Math.floor(visibleRows / 2))
  return clampTo(scroll + direction * step, maxScroll(totalLines, visibleRows))
}