import { layoutBlocks } from "./markdownLayout"
import type { MarkdownBlock } from "./markdownParser"

/**
 * Heading navigation for the markdown viewer.
 *
 * A table of contents is a list of headings and the row each one starts on, and
 * the only question worth asking about that list is where a heading is. This
 * module answers it in exactly one place: `calculateHeadingPositions` is the only
 * function here that touches a document at all, and it is a delegation to
 * `layoutBlocks` and nothing more. The other three ask questions of the map it
 * hands over -- which entry the reader is looking at, which is the one above,
 * which is the one below -- and know nothing about blocks, rows or markdown
 * beyond what the map already says.
 *
 * That split is the whole design. The previous table of contents computed its
 * own row numbers and disagreed with the screen on every block whose row count
 * depends on a detail -- a blank separator, a table's rule row, a nested quote --
 * and was reverted. A second implementation of the same arithmetic is free to
 * drift from the first, and a TOC that scrolls to the wrong row is the bug this
 * pair of modules exists to make impossible.
 *
 * It is a module of pure functions with no JSX and no Solid in it, for the same
 * reason `markdownLayout.ts` is: the keymap layer opens the viewer and moves
 * between headings without pulling in the JSX runtime, the host's reconciler and
 * the component that draws the rows.
 */

/**
 * Heading indices to the row each heading starts on.
 *
 * Keyed by the heading's index in `extractHeadings(blocks)` -- the index the TOC
 * holds entries by and a keypress navigates -- and not by its index in `blocks`.
 * The two are not the same list: a `#` heading with no text is a heading block and
 * no entry, so a map keyed by block index would name a row the TOC has no entry
 * for and shift every index above it.
 *
 * Rows are 0-based and mean what `layoutBlocks` means by them: the row the
 * heading's own text is drawn on, not the blank separator above it.
 */
export type HeadingPositions = Map<number, number>

/**
 * Where each of a document's headings starts on screen.
 *
 * `layoutBlocks(...).headingRows` returned as it stands. The rows that came with
 * it are dropped on the floor, because this function is asked a narrower question
 * than the layout answers and re-walking the blocks to get the answer again would
 * be the second implementation of the row arithmetic this module exists to avoid.
 *
 * No copy of the map is made: `layoutBlocks` allocates a new one on every call
 * and the only other thing that could have held this one is the `rows` array being
 * discarded here, so handing it over aliases nothing the caller does not already
 * own. Every call gets its own map, so a caller that navigates by reading one is
 * never looking at a map another caller can see, and nothing passed in is touched.
 */
export function calculateHeadingPositions(blocks: MarkdownBlock[], contentWidth: number): HeadingPositions {
  return layoutBlocks(blocks, contentWidth).headingRows
}

/**
 * The heading the reader is at: the last one that starts at or above the scroll
 * offset's row.
 *
 * The rule is a containment test rather than a proximity test, because the reader
 * is somewhere in a section and the section is the last heading they have passed:
 * a heading twenty rows below the top of the screen is not the section being read,
 * it is a heading the reader has not reached yet. So the answer changes on the row
 * the heading is drawn on, not on the row after.
 *
 * Above the first heading -- the top of a document that opens with prose -- the
 * first entry is the answer rather than "none". The reader is inside the section
 * that first heading opens, and highlighting nothing there reads as a TOC that
 * has lost track of the document it belongs to. `-1` is the answer only when
 * there is genuinely nothing to point at: no headings at all.
 *
 * `NaN` is treated as "no position at all" and gets the same `-1`, rather than
 * falling out of the comparison below as if it were an offset above everything.
 * The repo has already shipped a panel whose scroll position was `NaN` once, and
 * a NaN that compared as "greater than every row" would highlight the *last*
 * heading of a document the reader is looking at the top of.
 */
export function findActiveHeading(positions: HeadingPositions, scrollOffset: number): number {
  if (positions.size === 0 || Number.isNaN(scrollOffset)) return -1

  /*
   * Scanned rather than found from a sorted list, because the answer is "the
   * largest row at or above the offset" and only that value decides it. A map from
   * `layoutBlocks` has rows rising with the index, so the last qualifying entry
   * would do as well -- but this way the function is right for any map it is
   * handed, including one whose keys were built out of order, and it costs one
   * pass and no array. Two headings cannot share a row in a real layout, so the
   * index tie-break below only decides maps a test builds by hand.
   */
  let active: number | null = null
  let activeRow = 0
  for (const [index, row] of positions) {
    if (row > scrollOffset) continue
    if (active === null || row > activeRow || (row === activeRow && index > active)) {
      active = index
      activeRow = row
    }
  }

  return active ?? firstHeading(positions)
}

/**
 * The heading below `currentIndex`, or `null` at the last one.
 *
 * "Below" is "a larger index", and larger is document order because `layoutBlocks`
 * hands indices out as it walks the blocks. The neighbour is therefore the
 * closest index above the current one, found by comparison rather than by sorting
 * the map's keys into an array on every keypress -- the same answer, without the
 * allocation, for a list that is a few dozen entries at most.
 *
 * `null` is a real answer rather than a clamped index: it is what tells the
 * keymap that `alt+down` at the last heading has nowhere to go, which is a
 * different thing from jumping to a heading that is already the current one.
 *
 * An index that is not in the map is not an error. It is what the keymap holds
 * before any heading is active (`-1`, from `findActiveHeading` on a document with
 * no headings) and what it holds across a resize that changed how many headings
 * the document has, so the first index above the one given is the right answer
 * for both.
 */
export function findNextHeading(positions: HeadingPositions, currentIndex: number): number | null {
  let next: number | null = null
  for (const index of positions.keys()) {
    if (index > currentIndex && (next === null || index < next)) next = index
  }
  return next
}

/**
 * The heading above `currentIndex`, or `null` at the first one.
 *
 * The mirror of `findNextHeading`, with the same reasons: `null` at the top of
 * the document, and an index that is not in the map answered with the closest one
 * below it rather than treated as a failure.
 */
export function findPrevHeading(positions: HeadingPositions, currentIndex: number): number | null {
  let previous: number | null = null
  for (const index of positions.keys()) {
    if (index < currentIndex && (previous === null || index > previous)) previous = index
  }
  return previous
}

/**
 * The lowest index in the map: the first heading in document order.
 *
 * A loop rather than `Math.min(...positions.keys())`, because a document can hold
 * more headings than a spread of arguments has slots for, and the engine's
 * `RangeError` says nothing about tables of contents -- the same bound
 * `appendTable` counts for rather than spreads through.
 *
 * Only ever called with a non-empty map: `findActiveHeading` returns `-1` for an
 * empty one before getting here, so the infinite seed is always replaced.
 */
function firstHeading(positions: HeadingPositions): number {
  let first = Number.POSITIVE_INFINITY
  for (const index of positions.keys()) if (index < first) first = index
  return first
}