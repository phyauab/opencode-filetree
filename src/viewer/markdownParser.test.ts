import { describe, it, expect } from "bun:test"
import { parseMarkdown, extractHeadings, renderInline, type MarkdownBlock } from "./markdownParser"

describe("parseMarkdown", () => {
  it("parses a heading with the correct level and text", () => {
    const blocks = parseMarkdown("# Hello World")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("heading")
    expect(blocks[0]!.level).toBe(1)
    expect(blocks[0]!.text).toBe("Hello World")
  })

  it("parses all six heading levels", () => {
    const source = ["# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6"].join("\n\n")
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(6)
    for (let i = 0; i < 6; i++) {
      expect(blocks[i]!.type).toBe("heading")
      expect(blocks[i]!.level).toBe(i + 1)
      expect(blocks[i]!.text).toBe(`H${i + 1}`)
    }
  })

  it("parses a paragraph with inline tokens", () => {
    const blocks = parseMarkdown("This is a paragraph.")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("paragraph")
    expect(blocks[0]!.tokens).toBeDefined()
    expect(blocks[0]!.tokens!.length).toBeGreaterThan(0)
  })

  it("parses a fenced code block with language", () => {
    const source = "```ts\nconst a = 1\n```"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("code")
    expect(blocks[0]!.text).toBe("const a = 1")
    expect(blocks[0]!.lang).toBe("ts")
  })

  it("parses an indented code block without language", () => {
    const source = "    const a = 1"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("code")
    expect(blocks[0]!.lang).toBeUndefined()
  })

  it("parses an unordered list", () => {
    const source = "- item one\n- item two\n- item three"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("list")
  })

  it("parses an ordered list", () => {
    const source = "1. first\n2. second\n3. third"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("list")
  })

  it("parses a blockquote", () => {
    const blocks = parseMarkdown("> quoted text")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("blockquote")
  })

  it("parses a horizontal rule", () => {
    const blocks = parseMarkdown("---")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("hr")
  })

  it("parses an HTML block", () => {
    const blocks = parseMarkdown("<div>hello</div>")
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("html")
    expect(blocks[0]!.text).toBe("<div>hello</div>")
  })

  it("parses a table", () => {
    const source = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n")
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe("table")
  })

  it("filters out space tokens", () => {
    const source = "# Title\n\n\n\nParagraph"
    const blocks = parseMarkdown(source)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.type).toBe("heading")
    expect(blocks[1]!.type).toBe("paragraph")
  })

  it("returns an empty array for empty input", () => {
    expect(parseMarkdown("")).toEqual([])
  })

  it("preserves raw source on each block", () => {
    const source = "# Title\n\nParagraph"
    const blocks = parseMarkdown(source)
    expect(blocks[0]!.raw).toBe("# Title")
    expect(blocks[1]!.raw).toBe("Paragraph")
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
    const headings = extractHeadings(blocks)
    expect(headings[0]!.text).toBe("Hello World")
  })

  it("handles headings with inline code", () => {
    const blocks = parseMarkdown("# The `marked` library")
    const headings = extractHeadings(blocks)
    expect(headings[0]!.text).toBe("The marked library")
  })
})

describe("renderInline", () => {
  it("converts plain text tokens to spans", () => {
    const blocks = parseMarkdown("hello world")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toEqual([{ text: "hello world" }])
  })

  it("marks bold text", () => {
    const blocks = parseMarkdown("some **bold** text")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toContainEqual({ text: "bold", bold: true })
  })

  it("marks italic text", () => {
    const blocks = parseMarkdown("some *italic* text")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toContainEqual({ text: "italic", italic: true })
  })

  it("marks inline code", () => {
    const blocks = parseMarkdown("some `code` text")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toContainEqual({ text: "code", code: true })
  })

  it("marks links with href", () => {
    const blocks = parseMarkdown("a [link](https://example.com) here")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toContainEqual({ text: "link", link: "https://example.com" })
  })

  it("handles nested formatting in links", () => {
    const blocks = parseMarkdown("a [**bold link**](https://example.com) here")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toContainEqual({ text: "bold link", bold: true, link: "https://example.com" })
  })

  it("handles strikethrough as plain text", () => {
    const blocks = parseMarkdown("some ~~struck~~ text")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toContainEqual({ text: "struck" })
  })

  it("preserves soft line breaks within text", () => {
    // marked treats soft breaks as part of the text token, not as br tokens
    const blocks = parseMarkdown("line one\nline two")
    const spans = renderInline(blocks[0]!.tokens!)
    expect(spans).toEqual([{ text: "line one\nline two" }])
  })

  it("returns an empty array for empty input", () => {
    expect(renderInline([])).toEqual([])
  })

  it("preserves text order across mixed formatting", () => {
    const blocks = parseMarkdown("start **bold** middle *italic* end")
    const spans = renderInline(blocks[0]!.tokens!)
    const text = spans.map((s) => s.text).join("")
    expect(text).toBe("start bold middle italic end")
  })
})
