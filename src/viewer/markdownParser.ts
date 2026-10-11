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

/** Fields present on every block. */
interface BlockBase {
  /** Raw markdown source of the block, exactly as it appeared in the document. */
  raw: string
}

/** A heading: `# Title`. */
export interface HeadingBlock extends BlockBase {
  type: "heading"
  /** Heading level 1–6, corresponding to `#` through `######`. */
  level: number
  /** Raw inline markdown of the heading content, e.g. `"Hello **World**"`. */
  text: string
  /** Inline tokens of the heading content. */
  tokens: Token[]
}

/** A paragraph of text. */
export interface ParagraphBlock extends BlockBase {
  type: "paragraph"
  /** Inline tokens of the paragraph content. */
  tokens: Token[]
}

/** A fenced or indented code block. */
export interface CodeBlock extends BlockBase {
  type: "code"
  /** Raw source code, without the surrounding fence. */
  text: string
  /** Fenced code block language; absent for indented code blocks. */
  lang?: string
}

/** One list item, flattened out of marked's nested list structure. */
export interface ListItem {
  /** Plain text of the item, with inline markdown stripped. */
  text: string
  /** Whether the list this item belongs to was ordered (`1. ` rather than `- `). */
  ordered: boolean
  /** Nesting depth: 0 for the block's top-level items, 1 and up for sub-lists. */
  depth: number
  /** Inline tokens of the item's own text, excluding any nested sub-list. */
  tokens: Token[]
}

/** An ordered or unordered list, with any nested sub-lists flattened in. */
export interface ListBlock extends BlockBase {
  type: "list"
  /** Whether the top-level list is ordered; each `ListItem` carries its own flag for nested lists. */
  ordered: boolean
  /** Items in document order, including nested sub-list items at a higher `depth`. */
  items: ListItem[]
}

/** A blockquote: `> quoted text`. */
export interface BlockquoteBlock extends BlockBase {
  type: "blockquote"
  /** Block-level tokens inside the quote (paragraphs, lists, nested headings). */
  tokens: Token[]
}

/** A GFM pipe table. */
export interface TableBlock extends BlockBase {
  type: "table"
  /** Column headings, one per column, as plain text with inline markdown stripped. */
  header: string[]
  /** Data rows in document order, each an array of plain-text cells. */
  rows: string[][]
}

/** A thematic break: `---`. */
export interface HrBlock extends BlockBase {
  type: "hr"
}

/** A raw HTML block. */
export interface HtmlBlock extends BlockBase {
  type: "html"
  /** Raw HTML source of the block. */
  text: string
}

/**
 * One block of a parsed markdown document.
 *
 * A discriminated union: narrowing on `block.type` exposes exactly the fields
 * that block type carries, so reading `block.level` on a paragraph (or
 * `block.items` on a heading) is a compile error rather than a silent
 * `undefined`.
 */
export type MarkdownBlock =
  | HeadingBlock
  | ParagraphBlock
  | CodeBlock
  | ListBlock
  | BlockquoteBlock
  | TableBlock
  | HrBlock
  | HtmlBlock

/** The block types this parser produces, corresponding to marked's token types. */
export type BlockType = MarkdownBlock["type"]

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
 * Headings with no content (`#`) are skipped so the TOC gets no blank entries.
 *
 * Only top-level blocks are scanned: headings nested inside a blockquote or a
 * list item are not extracted.
 */
export function extractHeadings(blocks: MarkdownBlock[]): HeadingInfo[] {
  const headings: HeadingInfo[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type !== "heading") continue
    const text = plainText(block.tokens)
    if (text.trim() === "") continue
    headings.push({
      text,
      level: block.level,
      blockIndex: i,
    })
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
 * rendered distinctly). `image` tokens contribute their alt text, and inline
 * `html` tokens contribute their raw markup. `text` tokens that nest further
 * tokens (marked's list-item wrapper) are unwrapped rather than emitted raw.
 */
export function renderInline(tokens: Token[]): InlineSpan[] {
  const spans: InlineSpan[] = []

  for (const token of tokens) {
    if (token.type === "text") {
      const text = token as Tokens.Text
      // Inside a list item, marked wraps the item's parsed inline tokens in a
      // text token whose own `text` is still raw markdown. The nested tokens
      // are the authoritative content, so recurse into them when present.
      if (text.tokens && text.tokens.length > 0) {
        spans.push(...renderInline(text.tokens))
      } else {
        spans.push({ text: text.text })
      }
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
      // Images render as their alt text inline; the image itself is not drawn.
      spans.push({ text: (token as Tokens.Image).text })
    } else if (token.type === "html") {
      spans.push({ text: (token as Tokens.HTML).text })
    }
  }

  return spans
}

/**
 * Flattens inline tokens to plain text, stripping markdown syntax.
 *
 * Used wherever the consumer wants words rather than markup: TOC entries, list
 * item text, and table cells.
 */
function plainText(tokens: Token[]): string {
  return renderInline(tokens)
    .map((span) => span.text)
    .join("")
}

/**
 * Flattens a marked list token into `ListItem`s, recursing into sub-lists.
 *
 * marked nests a sub-list as a `list` token inside the parent item's tokens.
 * Each sub-list item becomes a further `ListItem` with an incremented `depth`
 * and its own `ordered` flag, so a renderer can pick markers and indentation
 * without re-parsing `raw`.
 */
function collectListItems(list: Tokens.List, depth: number): ListItem[] {
  const items: ListItem[] = []

  for (const item of list.items) {
    const tokens = listItemInlineTokens(item)
    items.push({ text: plainText(tokens), ordered: list.ordered, depth, tokens })
    for (const token of item.tokens) {
      if (token.type === "list") {
        items.push(...collectListItems(token as Tokens.List, depth + 1))
      }
    }
  }

  return items
}

/**
 * Extracts a list item's own inline tokens.
 *
 * A tight item holds `text` tokens directly, a loose item holds `paragraph`
 * tokens whose inline tokens are spliced in; the `space` token between those
 * paragraphs becomes a newline so multi-paragraph items do not run together.
 * Nested `list` tokens are dropped: they are represented by the deeper
 * `ListItem`s from `collectListItems`.
 */
function listItemInlineTokens(item: Tokens.ListItem): Token[] {
  const tokens: Token[] = []

  for (const token of item.tokens) {
    if (token.type === "text") {
      tokens.push(token)
    } else if (token.type === "paragraph") {
      tokens.push(...(token as Tokens.Paragraph).tokens)
    } else if (token.type === "space") {
      tokens.push({ type: "text", raw: token.raw, text: "\n" })
    }
  }

  return tokens
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
        ordered: t.ordered,
        items: collectListItems(t, 0),
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
        header: t.header.map((cell) => plainText(cell.tokens)),
        rows: t.rows.map((row) => row.map((cell) => plainText(cell.tokens))),
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