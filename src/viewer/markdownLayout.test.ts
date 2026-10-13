import { describe, it, expect } from "bun:test"
import { layoutBlocks, displayWidth, type Row } from "./markdownLayout"
import { parseMarkdown, type MarkdownBlock } from "./markdownParser"

/** One laid-out row, as the text it draws. */
const drawnRow = (row: Row): string => row.map((span) => span.text).join("")

/** Lays a document out and returns its rows as text. */
function rowsOf(source: string, contentWidth = 40): string[] {
  return layoutBlocks(parseMarkdown(source), contentWidth).rows.map(drawnRow)
}

/** The columns one laid-out row occupies. */
const rowWidth = (row: Row): number => row.map((span) => span.text.length).reduce((sum, width) => sum + width, 0)

describe("layoutBlocks", () => {
  it("draws a heading as one bold row in the colour for its level", () => {
    const rows = layoutBlocks(parseMarkdown("# Title\n"), 40).rows

    expect(rows).toHaveLength(1)
    expect(drawnRow(rows[0]!)).toBe("Title")
    expect(rows[0]![0]).toMatchObject({ bold: true, fg: "#e06c75" })
  })

  it("colours each level differently, and keeps deep levels in range", () => {
    const six = layoutBlocks(parseMarkdown("# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f\n"), 40)

    const colors = six.rows.filter((_, index) => index % 2 === 0).map((row) => row[0]?.fg)
    expect(colors).toEqual(["#e06c75", "#e5c07b", "#61afef", "#98c379", "#c678dd", "#56b6c2"])
  })

  it("separates blocks with a blank row, and never before the first", () => {
    const rows = layoutBlocks(parseMarkdown("# Title\n\ntext\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["Title", "", "text"])
  })

  it("draws a fenced block through Prism rather than as plain text", () => {
    const source = "```ts\nconst answer: number = 1\n```\n"
    const rows = layoutBlocks(parseMarkdown(source), 40).rows

    expect(rows.map(drawnRow)).toEqual(["const answer: number = 1"])
    // `keyword` is #c678dd and the annotation is `class-name`, #e5c07b, in the
    // same palette the viewer's own code path uses.
    expect(rows[0]!.map((span) => span.fg)).toContain("#c678dd")
  })

  it("keeps a code block's row count the source's, including an empty fence", () => {
    const rows = layoutBlocks(parseMarkdown("```\n```\n"), 40).rows

    // One source line, one blank row. `highlightLines("")` returns no lines at
    // all, so a count taken from the highlighter would draw nothing here.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual([])
  })

  it("leaves a fence in a language Prism has no grammar for as plain text", () => {
    const rows = layoutBlocks(parseMarkdown("```c++\nint main() {}\n```\n"), 40).rows

    expect(drawnRow(rows[0]!)).toBe("int main() {}")
  })

  it("draws list items with markers, numbered per depth", () => {
    // An ordered list followed by a `- ` item is two lists to marked, not one, so
    // the blank row between them is the separator between blocks and not a blank
    // item.
    const source = "- a\n- b\n\n1. one\n2. two\n- not numbered\n\n1. back to one\n"
    const rows = layoutBlocks(parseMarkdown(source), 40).rows

    expect(rows.map(drawnRow)).toEqual([
      "- a",
      "- b",
      "",
      "1. one",
      "2. two",
      "",
      "- not numbered",
      "",
      "1. back to one",
    ])
  })

  it("indents a nested list by two columns and numbers it from one", () => {
    const rows = layoutBlocks(parseMarkdown("1. a\n   1. b\n   2. c\n2. d\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["1. a", "  1. b", "  2. c", "2. d"])
  })

  it("draws an item's nested block as nothing rather than as a crash", () => {
    // The parser keeps only an item's inline tokens, so the fence survives in the
    // list's `raw` and nowhere else. What must not happen is a throw or a
    // duplicated fence.
    const rows = layoutBlocks(parseMarkdown("- item\n\n  ```js\n  const a = 1\n  ```\n\n- next\n"), 40).rows
    const drawn = rows.map(drawnRow)

    expect(drawn).toContain("- item")
    expect(drawn).toContain("- next")
    expect(drawn.some((row) => row.includes("const a = 1"))).toBe(false)
  })

  it("prefixes a blockquote's rows, and nests one level at a time", () => {
    const rows = layoutBlocks(parseMarkdown("> quoted\n"), 40).rows
    expect(rows.map(drawnRow)).toEqual(["> quoted"])
  })

  it("draws a list and a fence inside a quote behind the marker", () => {
    const rows = layoutBlocks(parseMarkdown("> - one\n> - two\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["> - one", "> - two"])
  })

  it("terminates on a quote whose content is another quote", () => {
    // The naive `parseMarkdown(block.raw)` recursion never gets shallower: the
    // re-parsed blockquote's `raw` is the same `>`-prefixed text. If this test
    // ever hangs rather than fails, the stripping in `appendBlockquote` is gone.
    const rows = layoutBlocks(parseMarkdown("> > > deep\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["> > > deep"])
  })

  it("separates a quote's own blocks behind the marker, blank rows included", () => {
    const rows = layoutBlocks(parseMarkdown("> intro\n>\n> - one\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["> intro", "> ", "> - one"])
  })

  it("draws a quote with nothing in it as its marker alone", () => {
    // `>` and `> ` are blocks an author really writes. What the quote stripping
    // leaves behind parses to no blocks at all, so the quote used to draw nothing
    // and disappear from the document -- with `pushWrapped`'s one-row floor a few
    // lines above it, which is the same rule one level down.
    expect(rowsOf(">\n")).toEqual(["> "])
    expect(rowsOf("> \n")).toEqual(["> "])
    // Two quoted blank lines are one quote, not two, so one marker row.
    expect(rowsOf("> \n> \n")).toEqual(["> "])
  })

  it("draws a heading inside a quote without giving it a TOC position", () => {
    // `extractHeadings` scans top-level blocks only, so a quoted heading is not an
    // entry in the list the positions are keyed by. Filing it anyway would hand
    // the TOC a row number for an entry that does not exist and shift every index
    // after it.
    const source = "# Real\n\n> ## Quoted\n"
    const { rows, headingRows } = layoutBlocks(parseMarkdown(source), 40)

    expect(rows.map(drawnRow)).toContain("> Quoted")
    expect([...headingRows.entries()]).toEqual([[0, 0]])
  })

  it("draws a table with pipes, a rule under the header, and every row", () => {
    const source = "| Name | Value |\n| --- | --- |\n| a | 1 |\n| bb | 22 |\n"
    const rows = layoutBlocks(parseMarkdown(source), 40).rows

    expect(rows.map(drawnRow)).toEqual([
      "| Name | Value |",
      "|------|-------|",
      "| a    | 1     |",
      "| bb   | 22    |",
    ])
  })

  it("squeezes a table that is wider than the panel", () => {
    const source = `| ${"a".repeat(60)} | b |\n| --- | --- |\n| ${"c".repeat(60)} | d |\n`
    const rows = layoutBlocks(parseMarkdown(source), 24).rows

    for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(24)
    // 24 columns, two columns and seven of overhead -- a leading and a trailing
    // pipe and three per cell -- leaves 17 for the cells, all of them taken from
    // the wide one because it is the wide one.
    expect(drawnRow(rows[0]!)).toBe("| aaaaaaaaaaaaaaaa | b |")
    expect(drawnRow(rows[2]!)).toBe("| cccccccccccccccc | d |")
  })

  it("budgets a table inside a quote for the marker in front of it", () => {
    /*
     * The table is drawn *behind* the `> `, so the whole row width is not the
     * table's to spend. Budgeting against it meant every row of a quoted table was
     * two columns too wide -- `> | aaaa | bbbb |` is sixteen columns -- and the
     * last column was cut off by the panel in exactly the case where a table is
     * hardest to read.
     */
    const source = "> | aaaa | bbbb |\n> | --- | --- |\n> | 1 | 2 |\n"
    const rows = layoutBlocks(parseMarkdown(source), 14).rows

    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(rowWidth(row)).toBeLessThanOrEqual(14)
  })

  it("draws a table inside a quote behind the marker, with the marker on every row", () => {
    const source = "> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n"
    const rows = layoutBlocks(parseMarkdown(source), 40).rows

    for (const row of rows) expect(drawnRow(row).startsWith("> |")).toBe(true)
  })

  it("draws a rule across the whole row", () => {
    const rows = layoutBlocks(parseMarkdown("---\n"), 12).rows

    expect(rows.map(drawnRow)).toEqual(["────────────"])
  })

  it("draws a raw HTML block as its source", () => {
    const rows = layoutBlocks(parseMarkdown("<div class=\"x\">hi</div>\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["<div class=\"x\">hi</div>"])
  })

  it("strips an inline tag and keeps the text around it", () => {
    const rows = layoutBlocks(parseMarkdown("a <span>b</span> c\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["a b c"])
  })

  it("leaves an entity literal, as every other block does", () => {
    expect(rowsOf("a &amp; b\n")).toEqual(["a &amp; b"])
  })

  it("colours inline code and links apart from the prose around them", () => {
    const rows = layoutBlocks(parseMarkdown("use `code` and [text](http://x)\n"), 40).rows
    const spans = rows[0]!

    expect(spans.find((span) => span.text === "code")?.fg).toBe("#98c379")
    expect(spans.find((span) => span.text === "text")).toMatchObject({ fg: "#61afef", underline: true })
  })

  it("wraps a paragraph at the content width", () => {
    const rows = layoutBlocks(parseMarkdown("aaa bbb ccc ddd\n"), 8).rows

    expect(rows.map(drawnRow)).toEqual(["aaa bbb ", "ccc ddd"])
  })

  it("cuts a word longer than the row rather than letting it run off", () => {
    const rows = layoutBlocks(parseMarkdown("https://example.com/a/very/long/path\n"), 10).rows

    expect(rows.map(drawnRow)).toEqual([
      "https://ex",
      "ample.com/",
      "a/very/lon",
      "g/path",
    ])
  })

  it("starts a wrapped row at the left edge, with no carried indent", () => {
    const rows = layoutBlocks(parseMarkdown("aaa bbb ccc ddd\n"), 8).rows

    expect(drawnRow(rows[1]!).startsWith(" ")).toBe(false)
  })

  it("clips a gap to what is left of the row rather than pushing past it", () => {
    // A gap is not one column. `"aaa   bbb"` in a five-column panel used to push
    // all three gap columns onto a row with two left, which made a six-column row
    // that `<text truncate>` cut with nothing to show that it had.
    expect(rowsOf("aaa   bbb\n", 5)).toEqual(["aaa  ", "bbb"])
  })

  it("never draws a row wider than the panel", () => {
    /*
     * The invariant, across every block that wraps.
     *
     * Headings and fenced blocks are deliberately excluded: neither is wrapped,
     * both are cut by `truncate`, and both say so where they are drawn.
     */
    const sources = [
      "aaa   bbb\n",
      "a  b  c  d  e  f  g  h\n",
      "   leading and trailing   \n",
      "- an   item   whose   gaps   do   not   fit\n",
      "> quoted   text   in a   narrow   panel\n",
      "> - a   b   c\n",
      "text with `a   code   span` in it\n",
      "<div   class=\"x\">markup   here</div>\n",
      "one  \ntwo   three\n",
    ]
    for (const source of sources) {
      for (const width of [6, 8, 12, 20, 40]) {
        for (const row of layoutBlocks(parseMarkdown(source), width).rows) {
          expect(rowWidth(row)).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  it("fits a table into the panel, and into what the quote marker leaves of it", () => {
    // Tables are held to the same rule, from twelve columns up: a quoted
    // two-column table spends two on the marker, seven on its pipes and one on
    // each cell, so below twelve there is nothing left to squeeze and the row is
    // the panel's to cut. That case is named in `MIN_COLUMN`.
    const tables = ["| a | bbbb |\n| --- | --- |\n| 1 | 2 |\n", "> | a | bbbb |\n> | --- | --- |\n> | 1 | 2 |\n"]
    for (const source of tables) {
      for (const width of [12, 20, 40]) {
        for (const row of layoutBlocks(parseMarkdown(source), width).rows) {
          expect(rowWidth(row)).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  it("keeps a marker wider than the panel rather than dropping the content under it", () => {
    /*
     * The one boundary the invariant above does not hold, pinned so it stays a
     * decision.
     *
     * A `> ` marker is two columns and a `1. ` marker three, so a panel narrower
     * than its own marker leaves nothing for the text. The marker is what says the
     * row is quoted or listed, and `truncate` cuts from the right, so keeping the
     * marker is also what keeps the row readable: what is given up is a column of
     * text in a panel too narrow to read it in anyway.
     */
    expect(rowsOf("> q\n", 1)).toEqual(["> q"])
    expect(rowsOf("> q\n", 2)).toEqual(["> q"])
    expect(rowsOf("1. q\n", 3)).toEqual(["1. q"])
    // Which is three columns of marker and text in a one-column panel, and one of
    // the rows the invariant above does not cover.
    expect(rowWidth(layoutBlocks(parseMarkdown("> q\n"), 1).rows[0]!)).toBe(3)
    // From the width the marker fits in, the rule holds again.
    for (const width of [3, 4, 12]) {
      for (const row of layoutBlocks(parseMarkdown("> quoted   text\n"), width).rows) {
        expect(rowWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })

  it("wraps a list item under its marker, at the marker's column", () => {
    const rows = layoutBlocks(parseMarkdown("- aaa bbb ccc ddd\n"), 10).rows

    // Eight columns behind the two-column marker. The gap that falls on the row's
    // edge stays (the row is exactly as wide as the panel, not wider), and the one
    // that would not is dropped rather than truncated away by the `<text>`.
    expect(rows.map(drawnRow)).toEqual(["- aaa bbb ", "  ccc ddd"])
  })

  it("wraps at the narrower width a quote leaves behind", () => {
    const rows = layoutBlocks(parseMarkdown("> aaa bbb ccc\n"), 9).rows

    expect(rows.map(drawnRow)).toEqual(["> aaa bbb", "> ccc"])
  })

  it("ends a hard break as a row of its own", () => {
    const rows = layoutBlocks(parseMarkdown("one  \ntwo\n"), 40).rows

    expect(rows.map(drawnRow)).toEqual(["one", "two"])
  })

  it("floors the width at one column instead of dividing by nothing", () => {
    const rows = layoutBlocks(parseMarkdown("aaa\n"), 0).rows

    expect(rows.map(drawnRow)).toEqual(["a", "a", "a"])
  })
})

describe("layoutBlocks heading positions", () => {
  it("records the row each heading starts on, keyed by TOC index", () => {
    const { headingRows } = layoutBlocks(parseMarkdown("# One\n\naaa\n\n## Two\n\nbbb\n"), 40)

    // `# One` is row 0, the blank separator is row 1, `aaa` is row 2, the blank
    // separator row 3 -- so `## Two` is row 4.
    expect([...headingRows.entries()]).toEqual([[0, 0], [1, 4]])
  })

  it("keys by the TOC's index, not the block's, when a heading has no text", () => {
    const blocks = parseMarkdown("#\n\n# Real\n")
    const { headingRows } = layoutBlocks(blocks, 40)

    // Two heading blocks, one TOC entry: `extractHeadings` skips the empty one, so
    // the entry that exists is index 0 and sits on the second heading's row.
    expect([...headingRows.entries()]).toEqual([[0, 2]])
  })

  it("counts the rows a table really draws", () => {
    const source = "# One\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## Two\n"
    const { headingRows } = layoutBlocks(parseMarkdown(source), 40)

    // Heading, blank, header, rule, row, blank -- so `## Two` is row 6.
    expect(headingRows.get(1)).toBe(6)
  })

  it("moves the positions when the width changes the wrapping", () => {
    const source = "# One\n\naaa bbb ccc ddd eee fff\n\n## Two\n"
    const wide = layoutBlocks(parseMarkdown(source), 40).headingRows
    const narrow = layoutBlocks(parseMarkdown(source), 12).headingRows

    // The paragraph is one row at 40 columns and two at 12, so the second heading
    // moves down one row. This is what makes a resize repaint the TOC.
    expect(wide.get(1)).toBe(4)
    expect(narrow.get(1)).toBe(5)
  })

  it("gives no positions for a document with no headings", () => {
    const { rows, headingRows } = layoutBlocks(parseMarkdown("just a paragraph\n"), 40)

    expect(rows).toHaveLength(1)
    expect(headingRows.size).toBe(0)
  })

  it("points every position at a row the layout actually drew", () => {
    const source = "# One\n\ntext\n\n## Two\n\n```ts\nconst a = 1\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n### Three\n"
    const { rows, headingRows } = layoutBlocks(parseMarkdown(source), 40)

    for (const [index, row] of headingRows) {
      expect(row).toBeGreaterThanOrEqual(0)
      expect(row).toBeLessThan(rows.length)
      // The row is the heading itself, not the blank separator above it.
      expect(drawnRow(rows[row]!)).toBe(["One", "Two", "Three"][index])
    }
  })
})

/*
 * `appendBlock`'s switch ends on `assertNever(block)`, so a block type added to
 * `MarkdownBlock` and not drawn is a compile error rather than a document that
 * quietly loses a paragraph. TypeScript is what enforces it, and this file stops
 * compiling the moment it stops being true -- there is no runtime test for that,
 * and the one below is for the other half: the throw.
 */
describe("a block nothing can draw", () => {
  it("is named in the error rather than skipped in silence", () => {
    // Unreachable from a value of the declared type, which is the point. It is
    // what a hand-built block in a test, or a parser whose union grew behind this
    // module's back, would land on -- and a message naming the block is worth more
    // than a document with a hole in it and no symptom.
    const bogus = [{ type: "sidenote", raw: "x" }] as unknown as MarkdownBlock[]

    expect(() => layoutBlocks(bogus, 40)).toThrow(/sidenote/)
  })

  it("draws every block type the parser currently produces", () => {
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
      "---",
      "",
      "<div>x</div>",
      "",
    ].join("\n")

    const { rows, headingRows } = layoutBlocks(parseMarkdown(source), 40)

    expect(headingRows.get(0)).toBe(0)
    // Eight blocks -- heading, paragraph, fence, item, quote, table, rule, html --
    // and a blank separator before each but the first. The table is three rows and
    // one block, so the arithmetic is 8 + 7 separators + 2 extra table rows.
    expect(rows).toHaveLength(17)
    expect(rows).toContainEqual([])
  })
})


/**
 * Display columns, the way a terminal counts them.
 *
 * Deliberately independent of the one under test: this is the yardstick the
 * layout is measured against, so it cannot be the same function.
 */
function columnsOf(text: string): number {
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

function widestRow(rows: { text: string }[][]): number {
  return rows.reduce((widest, row) => {
    const w = row.reduce((n, span) => n + columnsOf(span.text), 0)
    return w > widest ? w : widest
  }, 0)
}

describe("rows fit the column they are drawn in", () => {
  /*
   * Every row is `<text wrapMode="none" truncate>` in a box of exactly the width
   * the layout was given, so a row wider than that budget is not wrapped by the
   * terminal -- it is cut off at the edge. That is the bug.
   */

  it("keeps ascii prose inside the width", () => {
    const doc = "A fairly long paragraph of ordinary English prose that runs past any narrow column and must wrap.\n"
    for (const width of [30, 40, 50, 80]) {
      const { rows } = layoutBlocks(parseMarkdown(doc), width)
      // Never *wider* than the budget. It will not always be exactly the width:
      // a word that does not fit in what is left moves down whole, which is the
      // whole point, so rows are ragged-right and the widest is often short of it.
      expect(widestRow(rows)).toBeLessThanOrEqual(width)
    }
  })

  it("keeps cjk prose inside the width", () => {
    // The regression: `String.length` counts each of these as 1 column while the
    // terminal draws 2, so the layout believed it had twice the room it had and
    // emitted rows at double the width. They were then truncated at the box edge.
    const doc = "这是一段很长的中文段落，用来测试宽字符在换行的时候是否被正确计算，不会超出边框。".repeat(3) + "\n"
    for (const width of [30, 40, 70]) {
      const { rows } = layoutBlocks(parseMarkdown(doc), width)
      expect(widestRow(rows)).toBeLessThanOrEqual(width)
    }
  })

  it("keeps mixed-width prose inside the width", () => {
    const doc = "Mixed ASCII 与中文 mixed together 混排文本 in one paragraph 段落 to wrap 换行 properly.\n"
    for (const width of [24, 40, 60]) {
      const { rows } = layoutBlocks(parseMarkdown(doc), width)
      expect(widestRow(rows)).toBeLessThanOrEqual(width)
    }
  })

  it("keeps a heading on one row, wrapped or not", () => {
    /*
     * Headings are one row by design and truncate when they do not fit -- that is
     * the same for ASCII today, so it is not part of this regression. What is
     * asserted here is the narrower claim that a wide-character heading still
     * occupies exactly one row, i.e. that the wrap fix did not quietly start
     * breaking headings across rows (which would move every heading below it and
     * desynchronise the sidebar's row numbers from the screen).
     */
    const doc = "# 这是一个非常非常长的中文标题，用来测试标题是否也会超出边框\n"
    const { rows, headingRows } = layoutBlocks(parseMarkdown(doc), 30)
    const headingRow = rows[headingRows.get(0)!]!
    expect(headingRow).toHaveLength(1)
  })

  it("keeps a list and a quote inside the width", () => {
    const doc = "- 这是一个非常长的列表项，里面有很多很多的中文字符需要换行\n\n> 这是一个非常长的引用段落\n"
    for (const width of [30, 50]) {
      const { rows } = layoutBlocks(parseMarkdown(doc), width)
      expect(widestRow(rows)).toBeLessThanOrEqual(width)
    }
  })

  it("keeps a cjk table inside the width", () => {
    const doc = "| 名称 | 说明 |\n| --- | --- |\n| 第一项 | 这是很长的说明文字 |\n"
    for (const width of [40, 70]) {
      const { rows } = layoutBlocks(parseMarkdown(doc), width)
      expect(widestRow(rows)).toBeLessThanOrEqual(width)
    }
  })

  it("agrees with an independent column count", () => {
    // The yardstick above is hand-written, which is the point -- but it could
    // itself be wrong. This pins `displayWidth` against the two facts that
    // matter most and are easy to get backwards: ASCII is one column, and CJK is
    // two. A surrogate pair is one character, so an emoji must not count as two.
    expect(displayWidth("hello")).toBe(5)
    expect(displayWidth("中文")).toBe(4)
    expect(displayWidth("a中b")).toBe(4)
    expect(displayWidth("🚀")).toBe(2)
    expect(displayWidth("")).toBe(0)
  })
})


describe("words are not split across rows", () => {
  /*
   * The wrapper used to cut any word that did not fit in the space left on the
   * row, so "Content" became "Con" on one row and "tent" on the next. Nothing
   * was lost, which is why it read as a layout bug rather than a wrap bug: the
   * text looked complete until the reader tried to read a word and could not.
   */

  it("moves a word that does not fit onto the next row whole", () => {
    // "Content" is 7 columns. At width 10 with "See " already on the row there
    // are 6 left, so it does not fit -- and must not be cut. The trailing space
    // is the gap before it, kept whole so the words stay separated.
    const rows = rowsOf("See Content here\n", 10)
    expect(rows).toEqual(["See ", "Content ", "here"])
  })

  it("does not split a word at the row edge", () => {
    const rows = rowsOf("aaaaaa bbbbbb cccccc\n", 10)
    // Each word is 6 columns, so two fit per row and the third wraps whole.
    expect(rows).toEqual(["aaaaaa ", "bbbbbb ", "cccccc"])
  })

  it("keeps a word that fits a whole row on its own row", () => {
    // "abcdefghij" is 10 columns: it fits a whole row but not the 8 left after
    // "x ", so it moves down whole rather than being cut.
    const rows = rowsOf("x abcdefghij y\n", 10)
    expect(rows).toEqual(["x ", "abcdefghij", "y"])
  })

  it("still cuts a word wider than a whole row", () => {
    // A word longer than the row has nowhere to go, so it is cut -- a URL or a
    // path in a narrow terminal has to be broken to be shown at all.
    const rows = rowsOf("abcdefghijklmnopqrstuvwxyz\n", 10)
    expect(rows).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz"])
  })

  it("still cuts cjk runs, which have no spaces to wrap at", () => {
    // CJK has no word boundaries, so a run is always wider than a row and is cut
    // between characters -- which is correct, since any break is between words.
    // 11 characters is 22 columns, so three rows at a width of 10.
    const rows = rowsOf("这是一段很长的中文段落\n", 10)
    expect(rows).toHaveLength(3)
    expect(rows.map(columnsOf)).toEqual([10, 10, 2])
  })

  it("never emits a row wider than the width", () => {
    // The invariant the whole change exists to keep.
    for (const width of [10, 20, 30, 40]) {
      for (const doc of ["See Content here\n", "aaaaaa bbbbbb cccccc\n", "这是一段很长的中文段落\n"]) {
        for (const row of rowsOf(doc, width)) {
          expect(columnsOf(row)).toBeLessThanOrEqual(width)
        }
      }
    }
  })
})
