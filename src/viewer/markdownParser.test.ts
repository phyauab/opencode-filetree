import { describe, it, expect } from "bun:test"
import type { Token } from "marked"
import {
  parseMarkdown,
  extractHeadings,
  renderInline,
  type BlockType,
  type MarkdownBlock,
} from "./markdownParser"

/**
 * Returns the block at `index`, narrowed to `type`.
 *
 * `MarkdownBlock` is a discriminated union, so this is what lets a test read
 * `block.level` on a heading without a cast.
 */
function blockAt<T extends BlockType>(
  blocks: MarkdownBlock[],
  index: number,
  type: T,
): Extract<MarkdownBlock, { type: T }> {
  const block = blocks[index]
  if (block === undefined || block.type !== type) {
    throw new Error(`expected block ${index} to be a "${type}", got "${block?.type ?? "nothing"}"`)
  }
  return block as Extract<MarkdownBlock, { type: T }>
}

/** Returns the inline tokens of the block at `index`, for `renderInline`. */
function inlineTokens(blocks: MarkdownBlock[], index = 0): Token[] {
  const block = blocks[index]
  if (block === undefined || !("tokens" in block)) {
    throw new Error(`expected block ${index} to have inline tokens`)
  }
  return block.tokens
}

describe("parseMarkdown", () => {
  it("parses a heading with the correct level and text", () => {
    const blocks = parseMarkdown("# Hello World")
    expect(blocks).toHaveLength(1)
    const block = blockAt(blocks, 0, "heading")
    expect(block.level).toBe(1)
    expect(block.text).toBe("Hello World")
  })

  it("parses all six heading levels", () => {
    const source = ["# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6"].join("\n\n")
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(6)
    for (let i = 0; i < 6; i++) {
      const block = blockAt(blocks, i, "heading")
      expect(block.level).toBe(i + 1)
      expect(block.text).toBe(`H${i + 1}`)
    }
  })

  it("parses a paragraph with inline tokens", () => {
    const blocks = parseMarkdown("This is a paragraph.")
    expect(blocks).toHaveLength(1)
    expect(blockAt(blocks, 0, "paragraph").tokens.length).toBeGreaterThan(0)
  })

  it("parses a fenced code block with language", () => {
    const source = "```ts\nconst a = 1\n```"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    const block = blockAt(blocks, 0, "code")
    expect(block.text).toBe("const a = 1")
    expect(block.lang).toBe("ts")
  })

  it("parses an indented code block without language", () => {
    const source = "    const a = 1"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    expect(blockAt(blocks, 0, "code").lang).toBeUndefined()
  })

  it("parses an unordered list with its items", () => {
    const source = "- item one\n- item two\n- item three"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    const block = blockAt(blocks, 0, "list")
    expect(block.ordered).toBe(false)
    expect(block.items.map((item) => item.text)).toEqual(["item one", "item two", "item three"])
    expect(block.items.every((item) => item.depth === 0)).toBe(true)
    expect(block.items.every((item) => item.ordered === false)).toBe(true)
  })

  it("parses an ordered list and flags it ordered", () => {
    const source = "1. first\n2. second\n3. third"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    const block = blockAt(blocks, 0, "list")
    expect(block.ordered).toBe(true)
    expect(block.items.map((item) => item.text)).toEqual(["first", "second", "third"])
    expect(block.items.every((item) => item.ordered)).toBe(true)
  })

  it("gives each list item its inline tokens", () => {
    const blocks = parseMarkdown("- some **bold** text")
    const items = blockAt(blocks, 0, "list").items
    expect(items).toHaveLength(1)
    expect(items[0].tokens.length).toBeGreaterThan(0)
    expect(renderInline(items[0].tokens)).toContainEqual({ text: "bold", bold: true })
    expect(items[0].text).toBe("some bold text")
  })

  it("flattens nested lists into items with increasing depth", () => {
    const source = "- outer\n  - middle\n    - inner"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    const items = blockAt(blocks, 0, "list").items
    expect(items.map((item) => [item.text, item.depth])).toEqual([
      ["outer", 0],
      ["middle", 1],
      ["inner", 2],
    ])
  })

  it("keeps each nested item's own ordered flag", () => {
    const source = "- outer\n  1. nested ordered"
    const blocks = parseMarkdown(source)
    const items = blockAt(blocks, 0, "list").items
    expect(items.map((item) => item.ordered)).toEqual([false, true])
    expect(items.map((item) => item.depth)).toEqual([0, 1])
  })

  it("keeps inline tokens of a nested item free of the sub-list", () => {
    const blocks = parseMarkdown("- outer\n  - nested *emphasised*")
    const items = blockAt(blocks, 0, "list").items
    expect(items[0].tokens.length).toBeGreaterThan(0)
    expect(items[1].text).toBe("nested emphasised")
  })

  it("keeps the paragraphs of a loose list item", () => {
    const source = "- loose one\n\n  second paragraph\n- loose two"
    const blocks = parseMarkdown(source)
    const items = blockAt(blocks, 0, "list").items
    expect(items).toHaveLength(2)
    expect(items[0].text).toBe("loose one\nsecond paragraph")
    expect(items[1].text).toBe("loose two")
  })

  it("parses a blockquote", () => {
    const blocks = parseMarkdown("> quoted text")
    expect(blocks).toHaveLength(1)
    expect(blockAt(blocks, 0, "blockquote").tokens.length).toBeGreaterThan(0)
  })

  it("parses a horizontal rule", () => {
    const blocks = parseMarkdown("---")
    expect(blocks).toHaveLength(1)
    expect(blockAt(blocks, 0, "hr").raw).toBe("---")
  })

  it("parses an HTML block", () => {
    const blocks = parseMarkdown("<div>hello</div>")
    expect(blocks).toHaveLength(1)
    expect(blockAt(blocks, 0, "html").text).toBe("<div>hello</div>")
  })

  it("parses a table with its header and rows", () => {
    const source = ["| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |"].join("\n")
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    const block = blockAt(blocks, 0, "table")
    expect(block.header).toEqual(["A", "B"])
    expect(block.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ])
  })

  it("strips inline markdown from table cells", () => {
    const source = ["| Name | Note |", "|------|------|", "| `code` | **bold** |"].join("\n")
    const blocks = parseMarkdown(source)
    const block = blockAt(blocks, 0, "table")
    expect(block.header).toEqual(["Name", "Note"])
    expect(block.rows).toEqual([["code", "bold"]])
  })

  it("parses a table with a single row and no data rows", () => {
    const source = ["| A | B |", "|---|---|"].join("\n")
    const block = blockAt(parseMarkdown(source), 0, "table")
    expect(block.header).toEqual(["A", "B"])
    expect(block.rows).toEqual([])
  })

  it("filters out space tokens", () => {
    const source = "# Title\n\n\n\nParagraph"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].type).toBe("heading")
    expect(blocks[1].type).toBe("paragraph")
  })

  it("returns an empty array for empty input", () => {
    expect(parseMarkdown("")).toEqual([])
  })

  it("preserves raw source on each block", () => {
    const source = "# Title\n\nParagraph"
    const blocks = parseMarkdown(source)
    expect(blocks[0].raw).toBe("# Title")
    expect(blocks[1].raw).toBe("Paragraph")
  })

  it("parses a complex document with multiple block types", () => {
    const source = [
      "# Title",
      "",
      "Some *introductory* text.",
      "",
      "## Section 1",
      "",
      "- point a",
      "- point b",
      "",
      "> a quote",
      "",
      "```js",
      "const x = 1",
      "```",
      "",
      "---",
      "",
      "## Section 2",
      "",
      "Final paragraph.",
    ].join("\n")
    const blocks = parseMarkdown(source)
    const types = blocks.map((b) => b.type)
    expect(types).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "blockquote",
      "code",
      "hr",
      "heading",
      "paragraph",
    ])
  })
})

describe("extractHeadings", () => {
  it("extracts headings with correct text, level, and block index", () => {
    const source = ["# First", "", "paragraph", "", "## Second", "", "### Third"].join("\n")
    const blocks = parseMarkdown(source)
    const headings = extractHeadings(blocks)
    expect(headings).toHaveLength(3)
    expect(headings[0]).toEqual({ text: "First", level: 1, blockIndex: 0 })
    expect(headings[1]).toEqual({ text: "Second", level: 2, blockIndex: 2 })
    expect(headings[2]).toEqual({ text: "Third", level: 3, blockIndex: 3 })
  })

  it("returns an empty array when there are no headings", () => {
    const blocks = parseMarkdown("just a paragraph\n\nanother paragraph")
    expect(extractHeadings(blocks)).toEqual([])
  })

  it("returns an empty array for empty input", () => {
    expect(extractHeadings([])).toEqual([])
  })

  it("strips inline formatting from heading text", () => {
    const blocks = parseMarkdown("# Hello **World**")
    expect(extractHeadings(blocks)[0].text).toBe("Hello World")
  })

  it("handles headings with inline code", () => {
    const blocks = parseMarkdown("# The `marked` library")
    expect(extractHeadings(blocks)[0].text).toBe("The marked library")
  })

  it("skips headings with no content", () => {
    const source = ["#", "", "##   ", "", "## Real Heading"].join("\n")
    expect(extractHeadings(parseMarkdown(source))).toEqual([
      { text: "Real Heading", level: 2, blockIndex: 2 },
    ])
  })
})

describe("renderInline", () => {
  it("converts plain text tokens to spans", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("hello world")))
    expect(spans).toEqual([{ text: "hello world" }])
  })

  it("marks bold text", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("some **bold** text")))
    expect(spans).toContainEqual({ text: "bold", bold: true })
  })

  it("marks italic text", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("some *italic* text")))
    expect(spans).toContainEqual({ text: "italic", italic: true })
  })

  it("marks inline code", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("some `code` text")))
    expect(spans).toContainEqual({ text: "code", code: true })
  })

  it("marks links with href", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("a [link](https://example.com) here")))
    expect(spans).toContainEqual({ text: "link", link: "https://example.com" })
  })

  it("handles nested formatting in links", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("a [**bold link**](https://example.com) here")))
    expect(spans).toContainEqual({ text: "bold link", bold: true, link: "https://example.com" })
  })

  it("handles strikethrough as plain text", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("some ~~struck~~ text")))
    expect(spans).toContainEqual({ text: "struck" })
  })

  it("preserves soft line breaks within text", () => {
    // marked treats soft breaks as part of the text token, not as br tokens
    const spans = renderInline(inlineTokens(parseMarkdown("line one\nline two")))
    expect(spans).toEqual([{ text: "line one\nline two" }])
  })

  it("renders image alt text inline", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("Release ![v1.2](img.png) Notes")))
    expect(spans).toContainEqual({ text: "v1.2" })
    expect(spans.map((s) => s.text).join("")).toBe("Release v1.2 Notes")
  })

  it("returns an empty array for empty input", () => {
    expect(renderInline([])).toEqual([])
  })

  it("preserves text order across mixed formatting", () => {
    const spans = renderInline(inlineTokens(parseMarkdown("start **bold** middle *italic* end")))
    const text = spans.map((s) => s.text).join("")
    expect(text).toBe("start bold middle italic end")
  })
})