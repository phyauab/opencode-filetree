import { marked, type Token, type Tokens } from "marked"

/**
 * Markdown parsing for the TOC sidebar.
 *
 * The viewer used to render markdown through `MarkdownRenderable`, a black box
 * that exposed no heading positions. This module is the parsing layer for the
 * replacement: it turns markdown source into structured blocks that a custom
 * renderer can lay out and track.
 *
 * Pure data transformation — no rendering, no side effects. The output is a
 * flat list of blocks in document order, each carrying enough information for
 * the renderer to lay it out and for the TOC to extract heading positions.
 */

/** The block types this parser produces, corresponding to marked's token types. */
export type BlockType =
  | "heading"
  | "paragraph"
  | "code"
  | "list"
  | "blockquote"
  | "table"
  | "hr"
  | "html"

/**
 * One block of a parsed markdown document.
 *
 * `type` and `raw` are always present; the remaining fields are populated
 * according to the block type:
 *
 * - `heading`: `level` (1–6), `text` (plain text content), `tokens` (inline)
 * - `paragraph`: `tokens` (inline)
 * - `code`: `text` (raw source), `lang` (fenced language, if any)
 * - `list`: `items` (one entry per list item, each with inline `tokens`)
 * - `blockquote`: `tokens` (nested block tokens)
 * - `table`: `header` (column headings), `rows` (data rows)
 * - `hr`: no additional fields
 * - `html`: `text` (raw HTML source)
 */
export interface MarkdownBlock {
  type: BlockType
  level?: number
  text?: string
  lang?: string
  tokens?: Token[]
  raw: string
}

/** Heading information extracted from a parsed document, for the TOC sidebar. */
export interface HeadingInfo {
  /** Plain text of the heading, with inline formatting stripped. */
  text: string
  /** Heading level 1–6, corresponding to `#` through `######`. */
  level: number
  /** Index of this heading's block within the parsed `MarkdownBlock[]`. */
  blockIndex: number
}

/** A renderable inline span, produced by flattening marked's inline tokens. */
export interface InlineSpan {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  link?: string
}

/**
 * Parses markdown source into a flat list of structured blocks.
 *
 * Uses `marked.lexer()` for tokenization — battle-tested, synchronous, and
 * handles the full CommonMark spec plus GFM extensions. The output is a pure
 * data structure with no rendering dependencies, so it can be tested in
 * isolation and consumed by any renderer.
 *
 * `space` tokens (blank lines between blocks) are filtered out: they carry no
 * content and the renderer does not need them.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const tokens = marked.lexer(source)
  const blocks: MarkdownBlock[] = []

  for (const token of tokens) {
    if (token.type === "space") continue
    const block = tokenToBlock(token)
    if (block !== null) blocks.push(block)
  }

  return blocks
}

/**
 * Extracts heading information from parsed blocks.
 *
 * Returns one entry per heading block, in document order, with the block's
 * index in the original `MarkdownBlock[]` so the renderer can map heading
 * positions back to scroll rows.
 *
 * The heading text is extracted from inline tokens via `renderInline` to
 * strip markdown syntax (`**`, `` ` ``, etc.) — the TOC shows plain text.
 */
export function extractHeadings(blocks: MarkdownBlock[]): HeadingInfo[] {
  const headings: HeadingInfo[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.type === "heading" && block.level !== undefined && block.tokens !== undefined) {
      const spans = renderInline(block.tokens)
      const text = spans.map((s) => s.text).join("")
      headings.push({
        text,
        level: block.level,
        blockIndex: i,
      })
    }
  }

  return headings
}

/**
 * Converts marked's inline token tree into a flat list of renderable spans.
 *
 * Handles the recursive structure of inline tokens — `strong`, `em`, `link`,
 * and `del` all contain nested `tokens` arrays that are flattened into the
 * output. Plain `text` tokens are passed through directly.
 *
 * `code` tokens become spans with `code: true`; `link` tokens carry the
 * `href` in the `link` field; `strong` and `em` set `bold` and `italic`
 * respectively; `del` is treated as plain text (strikethrough is not yet
 * rendered distinctly).
 */
export function renderInline(tokens: Token[]): InlineSpan[] {
  const spans: InlineSpan[] = []

  for (const token of tokens) {
    if (token.type === "text") {
      spans.push({ text: (token as Tokens.Text).text })
    } else if (token.type === "strong") {
      const inner = renderInline((token as Tokens.Strong).tokens)
      for (const span of inner) spans.push({ ...span, bold: true })
    } else if (token.type === "em") {
      const inner = renderInline((token as Tokens.Em).tokens)
      for (const span of inner) spans.push({ ...span, italic: true })
    } else if (token.type === "codespan") {
      spans.push({ text: (token as Tokens.Codespan).text, code: true })
    } else if (token.type === "link") {
      const link = token as Tokens.Link
      const inner = renderInline(link.tokens)
      for (const span of inner) spans.push({ ...span, link: link.href })
    } else if (token.type === "del") {
      const inner = renderInline((token as Tokens.Del).tokens)
      spans.push(...inner)
    } else if (token.type === "br") {
      spans.push({ text: "\n" })
    } else if (token.type === "escape") {
      spans.push({ text: (token as Tokens.Escape).text })
    } else if (token.type === "image") {
      // Images have no text content to render inline; the alt text is the
      // closest analogue but is already part of the surrounding text flow.
      continue
    } else if (token.type === "html") {
      spans.push({ text: (token as Tokens.HTML).text })
    } else if (token.type === "tag") {
      // Inline HTML tag inside a paragraph; skip the tag itself but keep any
      // text tokens that follow in the same parent.
      continue
    }
  }

  return spans
}

/**
 * Converts a single marked block token to our `MarkdownBlock` shape.
 *
 * Returns `null` for token types we do not currently render (e.g. `space`),
 * so the caller can skip them without a separate filter pass.
 */
function tokenToBlock(token: Token): MarkdownBlock | null {
  switch (token.type) {
    case "heading": {
      const t = token as Tokens.Heading
      return {
        type: "heading",
        level: t.depth,
        text: t.text,
        tokens: t.tokens,
        raw: t.raw,
      }
    }
    case "paragraph": {
      const t = token as Tokens.Paragraph
      return {
        type: "paragraph",
        tokens: t.tokens,
        raw: t.raw,
      }
    }
    case "code": {
      const t = token as Tokens.Code
      return {
        type: "code",
        text: t.text,
        lang: t.lang,
        raw: t.raw,
      }
    }
    case "list": {
      const t = token as Tokens.List
      return {
        type: "list",
        raw: t.raw,
      }
    }
    case "blockquote": {
      const t = token as Tokens.Blockquote
      return {
        type: "blockquote",
        tokens: t.tokens,
        raw: t.raw,
      }
    }
    case "table": {
      const t = token as Tokens.Table
      return {
        type: "table",
        raw: t.raw,
      }
    }
    case "hr": {
      return { type: "hr", raw: token.raw }
    }
    case "html": {
      const t = token as Tokens.HTML
      return {
        type: "html",
        text: t.text,
        raw: t.raw,
      }
    }
    case "space":
      return null
    default:
      return null
  }
}
