import { describe, it, expect } from "bun:test"
import { calculateHeadingPositions, findActiveHeading, findNextHeading, findPrevHeading, type HeadingPositions } from "./toc"
import { layoutBlocks, type Row } from "./markdownLayout"
import { parseMarkdown } from "./markdownParser"

/** One laid-out row, as the text it draws. */
const drawnRow = (row: Row): string => row.map((span) => span.text).join("")

/** A positions map built by hand, so navigation can be tested without a document. */
const positionsOf = (...rows: [number, number][]): HeadingPositions => new Map(rows)

describe("calculateHeadingPositions", () => {
  it("returns exactly what layoutBlocks recorded", () => {
    const source = "# One\n\naaa\n\n## Two\n\nbbb\n\n### Three\n"
    const blocks = parseMarkdown(source)

    // The delegation, stated as the thing that must not change: a second
    // implementation of the row arithmetic is the failure this module exists to
    // prevent, so the test is that there is only ever one answer.
    expect(calculateHeadingPositions(blocks, 40)).toEqual(layoutBlocks(blocks, 40).headingRows)
  })

  it("agrees with layoutBlocks across every block type", () => {
    const source = [
      "# heading",
      "",
      "paragraph",
      "",
      "```ts",
      "const a = 1",
      "```",
      "",
      "- item",
      "",
      "> quote",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "## second",
      "",
      "---",
      "",
      "<div>x</div>",
      "",
    ].join("\n")
    const blocks = parseMarkdown(source)

    for (const width of [40, 12, 1]) {
      expect(calculateHeadingPositions(blocks, width)).toEqual(layoutBlocks(blocks, width).headingRows)
    }
  })

  it("points every position at the row the layout drew the heading on", () => {
    // The cross-check that a second implementation would fail: the rows come from
    // the table's rule row, the blank separators and the quote, all of which a
    // hand-written count gets right only by accident.
    const source = "# One\n\naaa\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n> quoted\n\n## Two\n\n- item\n"
    const { rows, headingRows } = layoutBlocks(parseMarkdown(source), 40)

    for (const [index, row] of calculateHeadingPositions(parseMarkdown(source), 40)) {
      expect(drawnRow(rows[row]!)).toBe(["One", "Two"][index])
    }
  })

  it("keys by the TOC's index rather than the block's", () => {
    const source = "#\n\n# Real\n"

    // `extractHeadings` skips the empty heading, so the entry that exists is
    // index 0 and sits on the second heading's row -- a block-index key would say
    // 1 and name a row the TOC has no entry for.
    expect([...calculateHeadingPositions(parseMarkdown(source), 40).entries()]).toEqual([[0, 2]])
  })

  it("moves the positions when the width changes the wrapping", () => {
    const source = "# One\n\naaa bbb ccc ddd eee fff\n\n## Two\n"

    // The paragraph is one row at 40 columns and two at 12, so the second heading
    // moves down a row. A TOC that kept the old numbers would scroll to the wrong
    // row after a resize.
    expect(calculateHeadingPositions(parseMarkdown(source), 40).get(1)).toBe(4)
    expect(calculateHeadingPositions(parseMarkdown(source), 12).get(1)).toBe(5)
  })

  it("gives an empty map for a document with no headings", () => {
    expect(calculateHeadingPositions(parseMarkdown("just a paragraph\n"), 40).size).toBe(0)
  })

  it("hands out a fresh map each call and leaves the blocks alone", () => {
    const blocks = parseMarkdown("# One\n\n## Two\n")
    const before = JSON.stringify(blocks)

    const first = calculateHeadingPositions(blocks, 40)
    const second = calculateHeadingPositions(blocks, 40)

    // Equal content, distinct maps: the caller that moves the active heading
    // around is mutating its own map, not a shared one.
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
    expect(JSON.stringify(blocks)).toBe(before)
  })
})

describe("findActiveHeading", () => {
  it("has no active heading in a document with no headings", () => {
    expect(findActiveHeading(new Map(), 0)).toBe(-1)
    expect(findActiveHeading(new Map(), 1000)).toBe(-1)
  })

  it("reports the only heading of a one-heading document, at any offset", () => {
    const positions = positionsOf([0, 0])

    expect(findActiveHeading(positions, 0)).toBe(0)
    expect(findActiveHeading(positions, 500)).toBe(0)
  })

  it("reports the first heading above the top of the document", () => {
    const positions = positionsOf([0, 10], [1, 40])

    // The reader is inside the section `0` opens, even though its heading is ten
    // rows below the top of the screen. Highlighting nothing there reads as a TOC
    // that has lost the document.
    expect(findActiveHeading(positions, 0)).toBe(0)
    expect(findActiveHeading(positions, 9)).toBe(0)
  })

  it("switches on the row the heading is drawn on", () => {
    const positions = positionsOf([0, 0], [1, 10], [2, 20])

    expect(findActiveHeading(positions, 0)).toBe(0)
    expect(findActiveHeading(positions, 9)).toBe(0)
    expect(findActiveHeading(positions, 10)).toBe(1)
    expect(findActiveHeading(positions, 19)).toBe(1)
    expect(findActiveHeading(positions, 20)).toBe(2)
  })

  it("stays on the last heading past the end of the document", () => {
    const positions = positionsOf([0, 0], [1, 10], [2, 20])

    expect(findActiveHeading(positions, 21)).toBe(2)
    expect(findActiveHeading(positions, 10000)).toBe(2)
  })

  it("reads a real document's positions the same way", () => {
    const positions = calculateHeadingPositions(parseMarkdown("# One\n\naaa\n\n## Two\n\nbbb\n\n### Three\n"), 40)

    // Rows 0, 4 and 8: a heading, a blank separator, a paragraph, another blank
    // separator -- twice.
    expect([...positions.entries()]).toEqual([[0, 0], [1, 4], [2, 8]])
    expect(findActiveHeading(positions, 0)).toBe(0)
    expect(findActiveHeading(positions, 3)).toBe(0)
    expect(findActiveHeading(positions, 4)).toBe(1)
    expect(findActiveHeading(positions, 8)).toBe(2)
  })

  it("takes the first index of the map, not a hard-coded zero", () => {
    // The key is a TOC index, and a map whose indices do not start at zero still
    // has a first heading. This is the shape a caller gets after the entries
    // above it were dropped from the document.
    const positions = positionsOf([2, 5], [3, 9])

    expect(findActiveHeading(positions, 0)).toBe(2)
    expect(findActiveHeading(positions, 5)).toBe(2)
    expect(findActiveHeading(positions, 9)).toBe(3)
  })

  it("follows the row it is given rather than the order the keys come in", () => {
    // A map built out of order, which no layout produces and a caller could
    // still hand over. The rule is "the largest row at or above the offset", so
    // the answer is index 0 -- the entry on row 20 -- not the last key visited.
    const positions = positionsOf([1, 10], [0, 20])

    expect(findActiveHeading(positions, 25)).toBe(0)
    expect(findActiveHeading(positions, 15)).toBe(1)
  })

  it("treats a NaN offset as no position rather than as past the end", () => {
    // A NaN compares as greater than every row, so a scan that did not guard it
    // would report the *last* heading of a document the reader is at the top of.
    // The repo has already shipped one panel that ended up scrolled to NaN.
    const positions = positionsOf([0, 0], [1, 10], [2, 20])

    expect(findActiveHeading(positions, Number.NaN)).toBe(-1)
  })

  it("leaves the map it was given untouched", () => {
    const positions = positionsOf([0, 0], [1, 10])

    findActiveHeading(positions, 7)

    expect([...positions.entries()]).toEqual([[0, 0], [1, 10]])
  })
})

describe("findNextHeading", () => {
  it("has nothing to move to in an empty document", () => {
    expect(findNextHeading(new Map(), 0)).toBeNull()
    expect(findNextHeading(new Map(), -1)).toBeNull()
  })

  it("has nothing to move to at the last heading", () => {
    expect(findNextHeading(positionsOf([0, 0]), 0)).toBeNull()
    expect(findNextHeading(positionsOf([0, 0], [1, 5], [2, 9]), 2)).toBeNull()
  })

  it("moves down the document one heading at a time", () => {
    const positions = positionsOf([0, 0], [1, 5], [2, 9])

    expect(findNextHeading(positions, 0)).toBe(1)
    expect(findNextHeading(positions, 1)).toBe(2)
  })

  it("starts from the top when no heading is active yet", () => {
    // What the keymap holds before anything is active, and what it holds across a
    // resize that changed the document.
    expect(findNextHeading(positionsOf([0, 0], [1, 5]), -1)).toBe(0)
    expect(findNextHeading(positionsOf([2, 0], [3, 5]), -1)).toBe(2)
  })

  it("steps over an index that is not in the map", () => {
    // A resize can drop entries above the active one, leaving the keymap holding
    // an index the new map does not have. The nearest one above it is the answer.
    expect(findNextHeading(positionsOf([0, 0], [5, 12]), 1)).toBe(5)
    expect(findNextHeading(positionsOf([0, 0], [5, 12]), 5)).toBeNull()
  })

  it("goes in document order even when the keys were inserted out of order", () => {
    const positions = positionsOf([2, 9], [0, 0], [1, 5])

    expect(findNextHeading(positions, -1)).toBe(0)
    expect(findNextHeading(positions, 0)).toBe(1)
    expect(findNextHeading(positions, 1)).toBe(2)
  })

  it("leaves the map it was given untouched", () => {
    const positions = positionsOf([0, 0], [1, 5])

    findNextHeading(positions, 0)

    expect([...positions.entries()]).toEqual([[0, 0], [1, 5]])
  })
})

describe("findPrevHeading", () => {
  it("has nothing to move to in an empty document", () => {
    expect(findPrevHeading(new Map(), 0)).toBeNull()
  })

  it("has nothing to move to at the first heading", () => {
    expect(findPrevHeading(positionsOf([0, 0]), 0)).toBeNull()
    expect(findPrevHeading(positionsOf([2, 0], [3, 5]), 2)).toBeNull()
  })

  it("moves up the document one heading at a time", () => {
    const positions = positionsOf([0, 0], [1, 5], [2, 9])

    expect(findPrevHeading(positions, 2)).toBe(1)
    expect(findPrevHeading(positions, 1)).toBe(0)
  })

  it("stays at the top when the active index is already the first or none", () => {
    const positions = positionsOf([0, 0], [1, 5])

    expect(findPrevHeading(positions, -1)).toBeNull()
    expect(findPrevHeading(positions, 0)).toBeNull()
  })

  it("steps over an index that is not in the map", () => {
    expect(findPrevHeading(positionsOf([0, 0], [5, 12]), 6)).toBe(5)
    expect(findPrevHeading(positionsOf([0, 0], [5, 12]), 5)).toBe(0)
  })

  it("goes in document order even when the keys were inserted out of order", () => {
    const positions = positionsOf([2, 9], [0, 0], [1, 5])

    expect(findPrevHeading(positions, 2)).toBe(1)
    expect(findPrevHeading(positions, 1)).toBe(0)
    expect(findPrevHeading(positions, 0)).toBeNull()
  })

  it("leaves the map it was given untouched", () => {
    const positions = positionsOf([0, 0], [1, 5])

    findPrevHeading(positions, 1)

    expect([...positions.entries()]).toEqual([[0, 0], [1, 5]])
  })
})

describe("navigating a real document", () => {
  it("walks the headings the layout drew, in order, to their own rows", () => {
    // The end-to-end shape of the feature: positions that navigation agrees with
    // and that the layout agrees with. Every row named here is one a screen row
    // in `rows` actually carries the heading's text on.
    const source = "# One\n\naaa\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## Two\n\n- item\n\n### Three\n"
    const { rows } = layoutBlocks(parseMarkdown(source), 40)
    const positions = calculateHeadingPositions(parseMarkdown(source), 40)

    const visited: [number, number][] = []
    for (let index: number | null = findNextHeading(positions, -1); index !== null; index = findNextHeading(positions, index)) {
      visited.push([index, positions.get(index)!])
    }

    expect(visited.map(([index, row]) => drawnRow(rows[row]!))).toEqual(["One", "Two", "Three"])

    // Walking back up from the last heading lands on the same rows in reverse,
    // and stops at the first one rather than returning null for it.
    const back: string[] = []
    for (let index: number | null = findPrevHeading(positions, 2); index !== null; index = findPrevHeading(positions, index)) {
      back.push(drawnRow(rows[positions.get(index)!]!))
    }
    expect(back).toEqual(["Two", "One"])
  })

  it("highlights the heading the reader has scrolled past", () => {
    const positions = calculateHeadingPositions(parseMarkdown("# One\n\naaa\n\n## Two\n\nbbb\n"), 40)

    expect(findActiveHeading(positions, 0)).toBe(0)
    expect(findActiveHeading(positions, 2)).toBe(0)
    expect(findActiveHeading(positions, 4)).toBe(1)
    expect(findActiveHeading(positions, 999)).toBe(1)
  })
})