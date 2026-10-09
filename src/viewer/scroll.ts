/**
 * Scroll math for the file viewer.
 *
 * Separate from the component for the same reason `treeLogic.ts` is: the host's
 * JSX runtime is not available here, and this is the part most worth pinning
 * down with tests.
 */

/** Largest legal scroll offset: keeps at least one line on screen. */
export function maxScroll(totalLines: number, visibleRows: number): number {
  // A zero-height render area would otherwise make the subtraction negative and
  // hand back an offset no line can be drawn at, which is the "end of file,
  // blank panel" failure the clamp below is meant to make impossible.
  const rows = Math.max(1, visibleRows)
  return Math.max(0, totalLines - rows)
}

/** Confines an offset to the scrollable range. */
function clamp(offset: number, totalLines: number, visibleRows: number): number {
  return Math.min(Math.max(offset, 0), maxScroll(totalLines, visibleRows))
}

/** Offset after a line-step, clamped to [0, maxScroll]. */
export function scrollByLine(scroll: number, delta: number, totalLines: number, visibleRows: number): number {
  return clamp(scroll + delta, totalLines, visibleRows)
}

/** Offset after a page-step, clamped the same way. */
export function scrollByPage(
  scroll: number,
  direction: -1 | 1,
  totalLines: number,
  visibleRows: number,
): number {
  // Half a screen, so the reader keeps their place when the step reverses
  // direction. The floor of one keeps the key live on a two-row panel, where
  // the half would otherwise be zero and the key would appear stuck.
  const step = Math.max(1, Math.floor(Math.max(1, visibleRows) / 2))
  return clamp(scroll + direction * step, totalLines, visibleRows)
}