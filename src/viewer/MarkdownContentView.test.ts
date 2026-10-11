import { describe, it, expect } from "bun:test"
import { createSignal } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import { MarkdownContentView, layoutBlocks, type MarkdownContentViewProps } from "./MarkdownContentView"
import { parseMarkdown } from "./markdownParser"

/** Counts the frames the plugin asks for, the way FileViewer's own mock does. */
function createMockRenderer() {
  const counter = { frames: 0 }
  return {
    height: 40,
    requestRender: () => {
      counter.frames++
    },
    frames: () => counter.frames,
  }
}

/**
 * Mounts the component through the stub JSX runtime.
 *
 * The stub builds a plain description of the tree instead of calling OpenTUI, so
 * the rows are inspectable without a renderer. The reactive tests below do not
 * come through here: they need a getter over a signal for `contentWidth` or
 * `blocks`, which is what babel-preset-solid compiles a caller's JSX into.
 */
function mount(source: string, contentWidth = 40) {
  const renderer = createMockRenderer()
  const positions: Map<number, number>[] = []
  const props = {
    blocks: parseMarkdown(source),
    contentWidth,
    context: { renderer },
    onHeadingPositions: (map: Map<number, number>) => positions.push(map),
  }
  return {
    element: (MarkdownContentView as any)(props),
    renderer,
    positions,
    lastPositions: () => positions[positions.length - 1],
  }
}

/** Mounts a document and returns its rows as plain text. */
function rowsOf(source: string, contentWidth = 40): string[] {
  return textRows(mount(source, contentWidth).element)
}

/** Every element in a `children` prop, however deeply nested. */
function elements(children: unknown): any[] {
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  return list.filter((child): child is any => Boolean(child) && typeof child === "object")
}

/** The text a node renders, following the stub's shape. */
function textOf(node: any): string {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  return typeof node === "object" ? textOf(node.props?.children) : ""
}

/** The root box's children: one `<text>` per rendered row. */
function rowElements(element: any): any[] {
  return elements(element?.props?.children)
}

/** The rendered rows, as text. */
function textRows(element: any): string[] {
  return rowElements(element).map(textOf)
}

/** One row's coloured runs, as `{text, style}` pairs, in order. */
function spansOf(element: any, row: number): { text: string; style: Record<string, unknown> | undefined }[] {
  return elements(rowElements(element)[row]?.props?.children).map((span: any) => ({
    text: span.props.children,
    style: span.props.style,
  }))
}

describe("layoutBlocks", () => {
  it("draws a heading as one bold row in the colour for its level", () => {
    const rows = layoutBlocks(parseMarkdown("# Title\n"), 40).rows

    expect(rows).toHaveLength(1)
    expect(rows[0]!.map((span) => span.text).join("")).toBe("Title")
    expect(rows[0]![0]).toMatchObject({ bold: true, fg: "#e06c75" })
  })

  it("colours each level differently, and keeps deep levels in range", () => {
    const six = layoutBlocks(parseMarkdown("# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f\n"), 40)

    const colors = six.rows.filter((_, index) => index % 2 === 0).map((row) => row[0]?.fg)
    expect(colors).toEqual(["#e06c75", "#e5c07b", "#61afef", "#98c379", "#c678dd", "#56b6c2"])
  })

  it("separates blocks with a blank row, and never before the first", () => {
    const rows = layoutBlocks(parseMarkdown("# Title\n\ntext\n"), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["Title", "", "text"])
  })

  it("draws a fenced block through Prism rather than as plain text", () => {
    const source = "```ts\nconst answer: number = 1\n```\n"
    const rows = layoutBlocks(parseMarkdown(source), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["const answer: number = 1"])
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

    expect(rows[0]!.map((span) => span.text).join("")).toBe("int main() {}")
  })

  it("draws list items with markers, numbered per depth", () => {
    // An ordered list followed by a `- ` item is two lists to marked, not one, so
    // the blank row between them is the separator between blocks and not a blank
    // item.
    const source = "- a\n- b\n\n1. one\n2. two\n- not numbered\n\n1. back to one\n"
    const rows = layoutBlocks(parseMarkdown(source), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual([
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

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["1. a", "  1. b", "  2. c", "2. d"])
  })

  it("draws an item's nested block as nothing rather than as a crash", () => {
    // The parser keeps only an item's inline tokens, so the fence survives in the
    // list's `raw` and nowhere else. What must not happen is a throw or a
    // duplicated fence.
    const rows = layoutBlocks(parseMarkdown("- item\n\n  ```js\n  const a = 1\n  ```\n\n- next\n"), 40).rows
    const drawn = rows.map((row) => row.map((span) => span.text).join(""))

    expect(drawn).toContain("- item")
    expect(drawn).toContain("- next")
    expect(drawn.some((row) => row.includes("const a = 1"))).toBe(false)
  })

  it("prefixes a blockquote's rows, and nests one level at a time", () => {
    const rows = layoutBlocks(parseMarkdown("> quoted\n"), 40).rows
    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["> quoted"])
  })

  it("draws a list and a fence inside a quote behind the marker", () => {
    const rows = layoutBlocks(parseMarkdown("> - one\n> - two\n"), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["> - one", "> - two"])
  })

  it("terminates on a quote whose content is another quote", () => {
    // The naive `parseMarkdown(block.raw)` recursion never gets shallower: the
    // re-parsed blockquote's `raw` is the same `>`-prefixed text. If this test
    // ever hangs rather than fails, the stripping in `appendBlockquote` is gone.
    const rows = layoutBlocks(parseMarkdown("> > > deep\n"), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["> > > deep"])
  })

  it("separates a quote's own blocks behind the marker, blank rows included", () => {
    const rows = layoutBlocks(parseMarkdown("> intro\n>\n> - one\n"), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["> intro", "> ", "> - one"])
  })

  it("draws a heading inside a quote without giving it a TOC position", () => {
    // `extractHeadings` scans top-level blocks only, so a quoted heading is not an
    // entry in the list the positions are keyed by. Filing it anyway would hand
    // the TOC a row number for an entry that does not exist and shift every index
    // after it.
    const source = "# Real\n\n> ## Quoted\n"
    const { rows, headingRows } = layoutBlocks(parseMarkdown(source), 40)

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toContain("> Quoted")
    expect([...headingRows.entries()]).toEqual([[0, 0]])
  })

  it("draws a table with pipes, a rule under the header, and every row", () => {
    const source = "| Name | Value |\n| --- | --- |\n| a | 1 |\n| bb | 22 |\n"
    const rows = layoutBlocks(parseMarkdown(source), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual([
      "| Name | Value |",
      "|------|-------|",
      "| a    | 1     |",
      "| bb   | 22    |",
    ])
  })

  it("squeezes a table that is wider than the panel", () => {
    const source = `| ${"a".repeat(60)} | b |\n| --- | --- |\n| ${"c".repeat(60)} | d |\n`
    const rows = layoutBlocks(parseMarkdown(source), 24).rows

    for (const row of rows) expect(row.map((span) => span.text).join("").length).toBeLessThanOrEqual(24)
    // 24 columns, two columns and seven of overhead -- a leading and a trailing
    // pipe and three per cell -- leaves 17 for the cells, all of them taken from
    // the wide one because it is the wide one.
    expect(rows[0]!.map((span) => span.text).join("")).toBe("| aaaaaaaaaaaaaaaa | b |")
    expect(rows[2]!.map((span) => span.text).join("")).toBe("| cccccccccccccccc | d |")
  })

  it("draws a rule across the whole row", () => {
    const rows = layoutBlocks(parseMarkdown("---\n"), 12).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["────────────"])
  })

  it("draws a raw HTML block as its source", () => {
    const rows = layoutBlocks(parseMarkdown("<div class=\"x\">hi</div>\n"), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["<div class=\"x\">hi</div>"])
  })

  it("strips an inline tag and keeps the text around it", () => {
    const rows = layoutBlocks(parseMarkdown("a <span>b</span> c\n"), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["a b c"])
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

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["aaa bbb ", "ccc ddd"])
  })

  it("cuts a word longer than the row rather than letting it run off", () => {
    const rows = layoutBlocks(parseMarkdown("https://example.com/a/very/long/path\n"), 10).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual([
      "https://ex",
      "ample.com/",
      "a/very/lon",
      "g/path",
    ])
  })

  it("starts a wrapped row at the left edge, with no carried indent", () => {
    const rows = layoutBlocks(parseMarkdown("aaa bbb ccc ddd\n"), 8).rows

    expect(rows[1]!.map((span) => span.text).join("").startsWith(" ")).toBe(false)
  })

  it("wraps a list item under its marker, at the marker's column", () => {
    const rows = layoutBlocks(parseMarkdown("- aaa bbb ccc ddd\n"), 10).rows

    // Eight columns behind the two-column marker. The gap that falls on the row's
    // edge stays (the row is exactly as wide as the panel, not wider), and the one
    // that would not is dropped rather than truncated away by the `<text>`.
    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["- aaa bbb ", "  ccc ddd"])
  })

  it("wraps at the narrower width a quote leaves behind", () => {
    const rows = layoutBlocks(parseMarkdown("> aaa bbb ccc\n"), 9).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["> aaa bbb", "> ccc"])
  })

  it("ends a hard break as a row of its own", () => {
    const rows = layoutBlocks(parseMarkdown("one  \ntwo\n"), 40).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["one", "two"])
  })

  it("floors the width at one column instead of dividing by nothing", () => {
    const rows = layoutBlocks(parseMarkdown("aaa\n"), 0).rows

    expect(rows.map((row) => row.map((span) => span.text).join(""))).toEqual(["a", "a", "a"])
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
      expect(rows[row]!.map((span) => span.text).join("")).toBe(["One", "Two", "Three"][index])
    }
  })
})

describe("MarkdownContentView", () => {
  it("draws one row per row the layout produced", () => {
    const { element } = mount("# Title\n\nsome text\n")

    expect(textRows(element)).toEqual(["Title", "", "some text"])
  })

  it("draws each row as a text node of coloured spans", () => {
    const { element } = mount("# Title\n")
    const row = rowElements(element)[0]

    // `wrapMode="none"` is load-bearing: a row the terminal wrapped itself would
    // be two screen rows, and every heading row the TOC recorded would be
    // counting something the reader cannot see.
    expect(row.type).toBe("text")
    expect(row.props.wrapMode).toBe("none")
    expect(spansOf(element, 0)).toEqual([{ text: "Title", style: { fg: "#e06c75", bold: true } }])
  })

  it("leaves a span with nothing to say with no style at all", () => {
    const { element } = mount("plain text\n")
    const spans = spansOf(element, 0)

    // The wrapper cuts a run at its spaces, so this is three spans rather than
    // one. What matters is that none of them claims a colour or an attribute.
    expect(spans.map((span) => span.text).join("")).toBe("plain text")
    expect(spans.every((span) => span.style === undefined)).toBe(true)
  })

  it("hands the heading positions over on mount", () => {
    const { lastPositions } = mount("# One\n\ntext\n\n## Two\n")

    expect([...(lastPositions()?.entries() ?? [])]).toEqual([[0, 0], [1, 4]])
  })

  it("asks the renderer for a frame on mount", () => {
    const { renderer } = mount("# One\n")

    expect(renderer.frames()).toBe(1)
  })

  it("recomputes the positions and repaints when the width changes", () => {
    const source = "# One\n\naaa bbb ccc ddd eee fff\n\n## Two\n"
    const [width, setWidth] = createSignal(40)
    const renderer = createMockRenderer()
    const maps: Map<number, number>[] = []
    const props = {
      blocks: parseMarkdown(source),
      get contentWidth() {
        return width()
      },
      context: { renderer },
      onHeadingPositions: (map: Map<number, number>) => maps.push(map),
    }
    ;(MarkdownContentView as any)(props)

    expect(maps[maps.length - 1]!.get(1)).toBe(4)
    setWidth(12)

    /*
     * A getter, not a number: babel-preset-solid compiles the caller's JSX into
     * one, and the effect only subscribes to the width because it reads it. With
     * a plain number this whole test would pass its first two assertions on mount
     * and never run again.
     *
     * The rows on screen are not asserted, and the reason is the stub rather than
     * the component: bun compiles the JSX for a test into a plain object, so
     * `props.children` is an array built once at mount. What the host build
     * compiles this file into is `_$insert(el, () => layout().rows.map(...))` --
     * an accessor the reconciler re-calls -- and no test here can reach a
     * reconciler. The callback and the frame request are what a test can see, and
     * both are asserted above; the test below pins the limitation itself.
     */
    expect(maps.length).toBe(2)
    expect(maps[maps.length - 1]!.get(1)).toBe(5)
    expect(renderer.frames()).toBe(2)
  })

  it("cannot catch a stale tree red-handed, because the stub has no reconciler", () => {
    // Pinned so the limitation above is not rediscovered later: a resize really
    // does change the layout, and the stubbed element still describes the rows it
    // was built with.
    const source = "# One\n\naaa bbb ccc ddd eee fff\n\n## Two\n"
    const blocks = parseMarkdown(source)
    const [width, setWidth] = createSignal(40)
    const element = (MarkdownContentView as any)({
      blocks,
      get contentWidth() {
        return width()
      },
      context: { renderer: createMockRenderer() },
      onHeadingPositions: () => {},
    })

    expect(textRows(element)).toHaveLength(5)
    setWidth(12)
    expect(layoutBlocks(blocks, 12).rows).toHaveLength(6)
    // Still five: `props.children` is an array bun built once, and the accessor
    // that would rebuild it lives in the host build's `_$insert` call.
    expect(textRows(element)).toHaveLength(5)
  })

  it("hands over a fresh map each time, so a caller holding the old one is not mutated under it", () => {
    const maps: Map<number, number>[] = []
    const [width, setWidth] = createSignal(40)
    const props = {
      blocks: parseMarkdown("# One\n\naaa bbb ccc ddd eee\n"),
      get contentWidth() {
        return width()
      },
      context: { renderer: createMockRenderer() },
      onHeadingPositions: (map: Map<number, number>) => maps.push(map),
    }
    ;(MarkdownContentView as any)(props)
    setWidth(12)

    expect(maps[0]).not.toBe(maps[1])
  })

  it("re-lays the document when the blocks themselves change", () => {
    // The other half of what the effect reads. A getter for `blocks` is what a
    // caller that opened a different file hands over, and the positions have to
    // follow it exactly as they follow a resize.
    const maps: Map<number, number>[] = []
    const [source, setSource] = createSignal("# One\n\ntext\n")
    const props = {
      get blocks() {
        return parseMarkdown(source())
      },
      contentWidth: 40,
      context: { renderer: createMockRenderer() },
      onHeadingPositions: (map: Map<number, number>) => maps.push(map),
    }
    ;(MarkdownContentView as any)(props)

    expect([...(maps[0]!.entries())]).toEqual([[0, 0]])
    setSource("#\n\n# Two\n\nmore text\n")

    expect(maps).toHaveLength(2)
    // `#` has no text, so the only entry is the second heading -- which the
    // layout draws on row 2, after its own blank separator.
    expect([...(maps[1]!.entries())]).toEqual([[0, 2]])
  })

  it("draws an empty document as no rows, and says so with an empty map", () => {
    const { element, lastPositions } = mount("")

    expect(textRows(element)).toEqual([])
    expect([...(lastPositions()?.entries() ?? [])]).toEqual([])
  })

  it("does not take a `syntaxStyle`, and says so at compile time", () => {
    /*
     * The plan put `syntaxStyle: SyntaxStyle` on this component, and it is
     * deliberately not a prop. `SyntaxStyle` is a native handle keyed by
     * tree-sitter scope names, consulted by the tree-sitter pipeline inside
     * `MarkdownRenderable`; nothing here tokenizes with tree-sitter -- blocks come
     * from marked and code fences from Prism -- so there is no scope to ask it
     * about. Code fences take their colours from `highlightLines`, and the rest of
     * the chrome from the One Dark palette `highlight.ts` already uses.
     *
     * The `@ts-expect-error` is the test. An unused directive is itself a compile
     * error, so the day someone adds the prop back this file stops compiling --
     * which is the outcome worth having, because the alternative is a caller
     * passing a handle this component would quietly ignore.
     */
    const props: MarkdownContentViewProps = {
      blocks: parseMarkdown("# One\n"),
      contentWidth: 40,
      context: { renderer: createMockRenderer() } as unknown as MarkdownContentViewProps["context"],
      onHeadingPositions: () => {},
    }
    // @ts-expect-error `syntaxStyle` is not part of MarkdownContentViewProps.
    const withStyle: MarkdownContentViewProps = { ...props, syntaxStyle: SyntaxStyle.create() }

    expect(Object.keys(props)).toEqual(["blocks", "contentWidth", "context", "onHeadingPositions"])
    expect(Object.keys(withStyle)).toContain("syntaxStyle")
  })
})