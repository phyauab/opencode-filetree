import { createEffect, createSignal, type Component } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { Token } from "marked"
import { highlightLines, languageFor } from "./highlight"
import { extractHeadings, parseMarkdown, renderInline, type HeadingInfo, type InlineSpan, type ListItem, type MarkdownBlock } from "./markdownParser"

/**
 * Markdown laid out as terminal rows, with a row number for every heading.
 *
 * This is the replacement for `<markdown content={...} />`. `MarkdownRenderable`
 * parses and lays out its own blocks inside a native renderable, so the panel
 * cannot tell where anything ended up -- which is why the first table of
 * contents was reverted. Everything the TOC needs is computed here instead: the
 * rows are laid out in JavaScript, one `<text>` per row, and the row each
 * heading starts on is handed back to the caller.
 *
 * The row numbers are only as good as the layout that produced them, so there is
 * exactly one layout function (`layoutBlocks`) and both the rows on screen and
 * the positions handed to the TOC come out of it. A second implementation of the
 * same arithmetic would be free to disagree with the first, and a TOC that
 * scrolls to the wrong row is the bug this file exists to make impossible.
 */

/** Columns a blockquote marker occupies on every row it prefixes. */
const QUOTE_PREFIX = "> "

/** Columns each level of list nesting is indented by. */
const LIST_INDENT = "  "

/**
 * A thematic break, and the column it repeats to.
 *
 * U+2500 BOX DRAWINGS LIGHT HORIZONTAL rather than an ASCII `-`: the rule reads
 * as a rule, where a row of hyphens reads as the `---` the author typed.
 */
const RULE_CHAR = "─"

/** Narrowest a table column may be squeezed to before the table is left too wide. */
const MIN_COLUMN = 3

/**
 * Markdown chrome, in the One Dark palette `highlight.ts` already uses.
 *
 * Fixed rather than theme-driven, and the reason is worth stating because it
 * looks like a step backwards from `markdown.ts`, which builds a `SyntaxStyle`
 * out of the host theme: `SyntaxStyle` is a native handle keyed by tree-sitter
 * scope names, consulted only by the tree-sitter pipeline inside
 * `MarkdownRenderable` and `CodeRenderable`. Nothing here tokenizes with
 * tree-sitter -- blocks come from `marked` and code fences from Prism -- so there
 * is no scope name to ask it about, and no API on it that resolves a scope to a
 * colour for a caller building `<span>`s itself.
 *
 * Reusing the same six colours as the Prism path is what keeps a `.md` file
 * looking like one thing: the heading in front of a TypeScript fence and the
 * keyword inside it come out of the same palette.
 */
const HEADING_COLORS = ["#e06c75", "#e5c07b", "#61afef", "#98c379", "#c678dd", "#56b6c2"]
const CODE_COLOR = "#98c379"
const LINK_COLOR = "#61afef"
const QUOTE_COLOR = "#abb2bf"
const RULE_COLOR = "#5c6370"

/**
 * One coloured run of text inside a row.
 *
 * The colour and the text attributes live here rather than on the element: a
 * `<span>` is a `TextNodeRenderable`, and `@opentui/solid`'s reconciler handles
 * only `href` and `style` for that kind of node before returning early, so a
 * bare `fg` (or a bare `bold`) on a span is silently dropped. `style` is the one
 * key that carries colour, background and text attributes to a span, which is
 * why `spanProps` hands it over under a spread rather than as a literal (see the
 * note on `SpanProps` below).
 */
type RowSpan = {
  text: string
  fg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

/** One screen row: the coloured runs it draws, left to right. */
type Row = RowSpan[]

/**
 * A laid-out document: every row it draws, and where each heading starts.
 *
 * `headingRows` is keyed by the heading's index in `extractHeadings(blocks)` --
 * not by its index in `blocks` -- because that is the list the TOC holds and the
 * list a keypress indexes into. The two are not the same array: a document whose
 * `#` heading has no text is one heading block and zero TOC entries.
 */
export type MarkdownLayout = {
  rows: Row[]
  headingRows: Map<number, number>
}

/**
 * The props of a rendered markdown column.
 *
 * `contentWidth` is the number of columns the caller has measured for this panel,
 * not the terminal's width: the TOC takes columns away from the content on the
 * right, so the panel sizes the content and passes the result down. It is a
 * number in a getter, so reading it inside an effect subscribes to whatever
 * signal the renderer's width lives in.
 *
 * `context` is passed in rather than read with `usePlugin()` for the reason
 * `FileViewer` gives: reading it from this module's own copy of
 * `@opencode/plugin/tui` yields a different Solid context object than the
 * host's.
 */
export type MarkdownContentViewProps = {
  blocks: MarkdownBlock[]
  contentWidth: number
  context: Context
  /** Handed `headingIndex -> start row` whenever the layout changes. */
  onHeadingPositions: (positions: Map<number, number>) => void
}

/**
 * The props for one coloured run inside a row.
 *
 * A spread rather than a literal because `SpanProps["style"]` is
 * `Partial<Omit<{}, NonStyledProps>>` -- an empty object -- so an inline
 * `style={{ fg: "red" }}` is an excess-property error under `strict`, while the
 * same object spread in is not. `FileViewer.spanProps` earns its keep for the
 * same reason; this one carries text attributes as well as colour, which is why
 * it is a function of the span rather than of a colour.
 *
 * An unstyled span gets no `style` key at all, matching what the constructor
 * would have produced: `setProperty`'s `style` branch does
 * `A.fg = l.fg ? parse(l.fg) : A.fg`, so an explicit `fg: undefined` inside it is
 * harmless but noisier than leaving it out.
 */
function spanProps(span: RowSpan): { style?: Record<string, string | true> } {
  const style: Record<string, string | true> = {}
  if (span.fg !== undefined) style.fg = span.fg
  if (span.bold === true) style.bold = true
  if (span.italic === true) style.italic = true
  if (span.underline === true) style.underline = true
  return Object.keys(style).length === 0 ? {} : { style }
}

/**
 * The columns a row of spans occupies.
 *
 * `String.length`, so a character outside the Basic Latin block is counted as
 * whatever JavaScript says it is rather than as the columns it actually takes on
 * screen. Every other width in this file is counted the same way -- including the
 * viewer's own gutter, which pads `String(lines.length)` -- so a document of wide
 * characters is laid out a little short of its real width and its rows truncate
 * a column or two early. Getting it right means a wcwidth per character, which is
 * a bigger change than this feature is.
 */
function widthOf(spans: RowSpan[]): number {
  let width = 0
  for (const span of spans) width += span.text.length
  return width
}

/** Marked's inline tokens as row spans, with the parser's formatting flags applied. */
function inlineSpans(tokens: Token[]): RowSpan[] {
  return renderSpans(renderInline(tokens))
}

/** A span that is nothing but one tag: what marked emits for inline HTML. */
const TAG_SPAN = /^<[^>]*>$/

/**
 * `renderInline`'s output mapped onto colours.
 *
 * A span that is exactly one tag is dropped. `renderInline` flattens marked's
 * inline tree and gives an `html` token back as ordinary text, so the tag cannot
 * be recognised by kind here -- only by shape. The whole-span test is what makes
 * that safe: marked leaves a literal `<` in prose unescaped, so a global replace
 * would delete "< b and c >" out of the middle of a sentence, while a span that
 * is one tag and nothing else can only have come from markup.
 */
function renderSpans(inline: InlineSpan[]): RowSpan[] {
  return inline.filter((span) => !TAG_SPAN.test(span.text)).map((span) => {
    const out: RowSpan = { text: span.text }
    if (span.code === true) out.fg = CODE_COLOR
    if (span.link !== undefined) {
      out.fg = LINK_COLOR
      out.underline = true
    }
    if (span.bold === true) out.bold = true
    if (span.italic === true) out.italic = true
    return out
  })
}

/** One wrappable piece of a span: a word, or the run of whitespace beside it. */
type Piece = { text: string; style: RowSpan }

/**
 * Cuts one span's text into wrappable pieces: runs of whitespace kept whole, so
 * that a space between two words stays a space between them and is not silently
 * dropped by the wrapper.
 *
 * Whitespace and word alternate, which is what lets the wrapper tell "the line is
 * not full yet, this is the gap before the next word" from "this is a word".
 */
function piecesOf(text: string, style: RowSpan): Piece[] {
  const pieces: Piece[] = []
  for (const part of text.split(/(\s+)/)) {
    if (part === "") continue
    pieces.push({ text: part, style })
  }
  return pieces
}

/**
 * Word-wraps spans into rows, at `width` columns.
 *
 * The wrap is done here rather than by the terminal (`wrapMode="word"`) for the
 * same reason the viewer's rows use `wrapMode="none"`: a row the terminal wraps
 * itself becomes two screen rows, and every row number the TOC recorded would be
 * counting something the reader cannot see. What is on screen has to be exactly
 * what was counted here.
 *
 * A new line inside the text (`renderInline` emits one for a hard break, and a
 * loose list item's paragraphs arrive with one) ends the row outright rather than
 * being treated as a gap, and a word longer than the row is cut at the row's edge
 * -- a URL or a path in a narrow terminal would otherwise be one row's worth of
 * text spread over however many rows the terminal decided on.
 *
 * Returns no rows at all for input with no text in it, and the caller decides
 * what an empty block draws.
 */
function wrapSpans(spans: RowSpan[], width: number): Row[] {
  const budget = Math.max(1, Math.floor(width))
  const rows: Row[] = []
  let row: Row = []
  let used = 0

  const push = (text: string, style: RowSpan): void => {
    row.push({ ...style, text })
    used += text.length
  }
  const endRow = (): void => {
    rows.push(row)
    row = []
    used = 0
  }

  for (const span of spans) {
    // Split on the newlines first so that a hard break ends a row and each side of
    // it keeps the span's own colour.
    const segments = span.text.split("\n")
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) endRow()
      for (const piece of piecesOf(segments[i]!, span)) {
        if (/^\s+$/.test(piece.text)) {
          // Leading whitespace on a wrapped row would push the text one column
          // right of where it started on the row above, and trailing whitespace on
          // a full row would push the row one column past the panel -- which the
          // `<text>` would then truncate, in the one case where truncating is
          // invisible and therefore untestable.
          if (used === 0 || used >= budget) continue
          push(piece.text, piece.style)
          continue
        }
        let word = piece.text
        while (word.length > 0) {
          const room = budget - used
          if (word.length <= room) {
            push(word, piece.style)
            break
          }
          if (room > 0) push(word.slice(0, room), piece.style)
          word = word.slice(Math.max(room, 0))
          endRow()
        }
      }
    }
  }

  // Nothing pushed here means the text ended on a newline, which already ended a
  // row; pushing an empty one would add a row the text does not have.
  if (row.length > 0) rows.push(row)
  return rows
}

/**
 * The walk's mutable state.
 *
 * `rows` is shared with nested walks (a blockquote's own blocks are rows of the
 * outer document too, prefix and all), so `rows.length` is the absolute row
 * number at every level. `positions` is what nesting turns off: a heading inside a
 * blockquote is rendered and numbered like any other row, but `extractHeadings`
 * scans only top-level blocks, so there is no TOC index to file it under.
 */
type Walk = {
  rows: Row[]
  /** Total columns a row may occupy, prefix included. */
  width: number
  /** Prepended to every row this walk draws. */
  prefix: RowSpan[]
  /** Heading start rows by TOC index; null when the walk is nested. */
  positions: Map<number, number> | null
  /** The TOC's headings, in the order their indices are handed out. */
  headings: HeadingInfo[]
  /** The next heading index this walk owns. */
  next: number
}

/** Draws `blocks`, one blank row between neighbours. */
function appendBlocks(walk: Walk, blocks: MarkdownBlock[]): void {
  for (let index = 0; index < blocks.length; index++) {
    /*
     * A blank row between blocks, and never before the first one.
     *
     * Markdown's blocks are separated by blank lines in the source and are read
     * as separate things without them: a heading's row and the paragraph under
     * it run together into one block of text. The row is accounted for in the
     * count the TOC is handed, so it costs nothing but a line -- and it is what
     * puts the blank row *above* a heading when a keypress scrolls to one.
     */
    if (index > 0) walk.rows.push([...walk.prefix])

    /*
     * The row a heading starts on, filed under the index the TOC holds it by.
     *
     * The pointer is walked rather than the block index being used directly:
     * `extractHeadings` skips a heading with no text, so a document's second
     * heading block is not necessarily TOC entry 1, and a map keyed by block
     * index would hand the TOC a row for a heading it has no entry for.
     *
     * The whole thing is skipped on a nested walk, which is how a heading inside
     * a blockquote is drawn without being numbered.
     */
    const positions = walk.positions
    if (positions !== null) {
      const heading = walk.headings[walk.next]
      if (heading !== undefined && heading.blockIndex === index) {
        positions.set(walk.next, walk.rows.length)
        walk.next++
      }
    }

    appendBlock(walk, blocks[index]!)
  }
}

/** Draws one block. */
function appendBlock(walk: Walk, block: MarkdownBlock): void {
  switch (block.type) {
    case "heading":
      appendHeading(walk, block)
      return
    case "paragraph":
      pushWrapped(walk, inlineSpans(block.tokens))
      return
    case "code":
      appendCode(walk, block)
      return
    case "list":
      appendList(walk, block.items)
      return
    case "blockquote":
      appendBlockquote(walk, block.raw)
      return
    case "table":
      appendTable(walk, block.header, block.rows)
      return
    case "hr":
      walk.rows.push([...walk.prefix, { text: RULE_CHAR.repeat(Math.max(1, walk.width - widthOf(walk.prefix))), fg: RULE_COLOR }])
      return
    case "html":
      /*
       * The source, not the text inside it.
       *
       * Unlike an inline tag (see `renderSpans`), a block of raw HTML has no prose
       * of its own: `<div class="x">` is the whole of what the author wrote, and
       * stripping it would leave a reader wondering where the block went. It is
       * greyed like a quote marker so it reads as markup rather than as body text.
       */
      pushWrapped(walk, [{ text: block.text, fg: QUOTE_COLOR }])
      return
  }
}

/**
 * One row, bold, in the colour for its level.
 *
 * Never wrapped, which is the one place a row is allowed to be wider than the
 * panel: the position the TOC records is a single row, and a heading that wrapped
 * would put its text on rows the count does not name. The `<text>` truncates it
 * instead, so a long heading is cut rather than reflowed.
 */
function appendHeading(walk: Walk, block: Extract<MarkdownBlock, { type: "heading" }>): void {
  const color = HEADING_COLORS[Math.min(Math.max(block.level, 1), HEADING_COLORS.length) - 1]!
  const spans = inlineSpans(block.tokens).map((span) => ({ ...span, fg: color, bold: true }))
  walk.rows.push([...walk.prefix, ...spans])
}

/** Draws wrapped rows under an optional prefix of their own. */
function pushWrapped(walk: Walk, spans: RowSpan[], prefix: RowSpan[] = walk.prefix, continuation: RowSpan[] = prefix): void {
  const rows = wrapSpans(spans, walk.width - widthOf(prefix))
  // A block that wraps to nothing still takes a row. Without this, a list item
  // whose whole text was markup would vanish and the rows after it would slide
  // up under a separator row, and every row number the TOC holds would shift by
  // one without anything having moved a heading.
  if (rows.length === 0) walk.rows.push([...prefix])
  rows.forEach((row, index) => walk.rows.push([...(index === 0 ? prefix : continuation), ...row]))
}

/**
 * A fenced code block, highlighted by Prism.
 *
 * The row count comes from the source, never from what the highlighter returned,
 * for the reason `FileViewer.tokenize` gives: `highlightLines("")` returns no
 * lines at all, and an empty fence is a real block with a real (blank) line in
 * it. Any shortfall is padded with an empty span list, which draws the blank row
 * it is.
 *
 * The fence's language is resolved through `languageFor` on a fake file name, so
 * ```ts opens the TypeScript grammar and ```c++ falls through to plain text
 * rather than being handed to `Prism.languages` as a grammar that is not there.
 */
function appendCode(walk: Walk, block: Extract<MarkdownBlock, { type: "code" }>): void {
  const lines = block.text.split("\n")
  const grammar = block.lang === undefined ? undefined : languageFor(`fence.${block.lang}`)
  const highlighted = highlightLines(block.text, grammar)
  for (let index = 0; index < lines.length; index++) {
    const spans: RowSpan[] = (highlighted[index] ?? []).map((span) => ({ text: span.text, fg: span.color }))
    walk.rows.push([...walk.prefix, ...spans])
  }
}

/**
 * A list, with its markers, its nesting and its numbering.
 *
 * The marker sits on the item's first row and the continuation rows are indented
 * to the same column, so a wrapped item stays visibly inside its own bullet.
 *
 * Numbering is counted per depth and restarts whenever the kind of list changes,
 * because `ListItem` carries `ordered` per item rather than per list: the parser
 * flattens a document's sub-lists into one item list, so an ordered item at depth
 * 1 inside an unordered list at depth 0 has to number itself from one.
 *
 * A list item's non-inline content -- a fenced block, a nested quote, a table --
 * is not in `ListItem` at all: `markdownParser` keeps only an item's inline
 * tokens and drops the rest, so the block survives in the list's `raw` and in
 * nothing else. The item's own text is drawn and the nested block is skipped
 * rather than reconstructed from `raw` and laid out twice: a re-parse of `raw`
 * would produce blocks that no other part of the layout has counted, and their
 * rows would have to be counted a second time by hand. The cost is that a fence
 * inside a bullet is not shown, which is the smaller failure of the two.
 */
function appendList(walk: Walk, items: ListItem[]): void {
  const counters = new Map<number, number>()

  for (const item of items) {
    // A shallower item ends every deeper list, so their counters go with it.
    for (const depth of [...counters.keys()]) if (depth > item.depth) counters.delete(depth)

    const number = item.ordered ? (counters.get(item.depth) ?? 0) + 1 : 0
    if (item.ordered) counters.set(item.depth, number)
    else counters.delete(item.depth)

    const marker = item.ordered ? `${number}. ` : "- "
    const indent = LIST_INDENT.repeat(item.depth)
    // Continuation rows are indented to the marker's column rather than repeating
    // the marker: a wrapped item that repeated its bullet would read as two items.
    pushWrapped(walk, inlineSpans(item.tokens), [
      ...walk.prefix,
      { text: indent + marker },
    ], [
      ...walk.prefix,
      { text: indent + " ".repeat(marker.length) },
    ])
  }
}

/**
 * A blockquote: its own blocks, every row behind a `> `.
 *
 * The nesting is stripped out of `raw` and the source re-parsed, which is the only
 * way to get at a quote's contents from what the parser hands over:
 * `BlockquoteBlock.tokens` holds marked's *block* tokens, which are not the
 * inline tokens `renderInline` takes, and `parseMarkdown(block.raw)` is worse
 * than useless -- the blockquote's raw is the same `> `-prefixed text the outer
 * document had, so re-parsing it hands back a blockquote with a byte-identical
 * `raw` and the recursive call never gets any shallower. It terminates only
 * because this removes one marker per pass, which is also what the marker means:
 * each pass renders the content one level in.
 *
 * Nested blocks are separated by blank rows like any other blocks, and those rows
 * carry the marker too, so the quote reads as one continuous gutter.
 *
 * `width` is carried over untouched: it is the width of the whole row, prefix
 * included, and `pushWrapped` is what takes the prefix off it before wrapping.
 * Narrowing it here as well would take the marker off twice, and a quote in a
 * 40-column panel would wrap at 36 columns.
 */
function appendBlockquote(walk: Walk, raw: string): void {
  const inner = parseMarkdown(raw.replace(/^[ \t]*>[ \t]?/gm, ""))
  const nested: Walk = {
    ...walk,
    prefix: [...walk.prefix, { text: QUOTE_PREFIX, fg: QUOTE_COLOR }],
    positions: null,
  }
  appendBlocks(nested, inner)
}

/**
 * A pipe table: a header, a rule, and the rows.
 *
 * Column widths come from the content and are then squeezed, widest column
 * first, until the table fits the panel. A table is the one block whose natural
 * width is not bounded by anything, so without the squeeze a three-column table
 * of prose would be clipped by the panel at whatever column the panel ends at,
 * with no way to read the last column at all.
 *
 * Cells are cut rather than wrapped: a wrapped cell would make the columns of one
 * row straddle two screen rows, and a table row is the unit the eye reads across.
 */
function appendTable(walk: Walk, header: string[], rows: string[][]): void {
  /*
   * The column count is the widest row's, counted in a loop rather than with
   * `Math.max(...rows.map(...))`: a generated table can have more rows than a
   * spread of arguments has slots for, and the throw that produces is a
   * `RangeError` from the engine rather than anything to do with tables.
   */
  let columns = header.length
  for (const row of rows) columns = Math.max(columns, row.length)

  const widths: number[] = []
  for (let column = 0; column < columns; column++) {
    let width = (header[column] ?? "").length
    for (const row of rows) width = Math.max(width, (row[column] ?? "").length)
    widths.push(width)
  }
  squeeze(widths, walk.width - (3 * columns + 1))

  const line = (cells: string[]): RowSpan[] => {
    const spans: RowSpan[] = [{ text: "|", fg: RULE_COLOR }]
    for (let column = 0; column < columns; column++) {
      const cell = (cells[column] ?? "").slice(0, widths[column]!)
      spans.push({ text: ` ${cell.padEnd(widths[column]!, " ")} ` }, { text: "|", fg: RULE_COLOR })
    }
    return [...walk.prefix, ...spans]
  }

  walk.rows.push(line(header))
  walk.rows.push([...walk.prefix, { text: `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`, fg: RULE_COLOR }])
  for (const row of rows) walk.rows.push(line(row))
}

/** Narrows the widest columns until the widths fit `budget`, or hit the floor. */
function squeeze(widths: number[], budget: number): void {
  const total = () => widths.reduce((sum, width) => sum + width, 0)
  while (total() > budget) {
    let widest = 0
    for (let column = 1; column < widths.length; column++) {
      if (widths[column]! > widths[widest]!) widest = column
    }
    if (widths[widest]! <= MIN_COLUMN) return
    widths[widest] = widths[widest]! - 1
  }
}

/**
 * Lays a parsed document out into rows and heading positions.
 *
 * Exported because the TOC needs the same arithmetic and must not have its own:
 * `toc.ts` asks for a heading's row when a keypress moves, and an answer computed
 * from a second, separately-written layout is an answer that can disagree with
 * the screen. One function, one set of numbers.
 *
 * `contentWidth` is floored at one column, so a panel that has not been measured
 * yet draws single-column rows instead of dividing by zero or looping forever in
 * the wrapper.
 */
export function layoutBlocks(blocks: MarkdownBlock[], contentWidth: number): MarkdownLayout {
  const positions = new Map<number, number>()
  const walk: Walk = {
    rows: [],
    width: Math.max(1, Math.floor(contentWidth)),
    prefix: [],
    positions,
    headings: extractHeadings(blocks),
    next: 0,
  }
  appendBlocks(walk, blocks)
  return { rows: walk.rows, headingRows: positions }
}

/**
 * A parsed markdown document, drawn as one `<text>` per row.
 *
 * The rows are a plain `.map()` in the root's children rather than a `<For>`,
 * for the reason `FileViewer` gives: the reconciler re-calls the accessor that
 * `.map()` compiles into whenever anything it read changes, so a resize rebuilds
 * the rows, and the rows stay directly reachable from `props.children` for a
 * test that wants to count them.
 *
 * The root is a non-shrinking column: this lives inside a scrollbox whose size
 * comes from the container, and a column of rows whose height is its content is
 * the one thing that must not be compressed when the container is short -- a
 * shrunk column is fewer rows on screen than the TOC has numbered.
 */
export const MarkdownContentView: Component<MarkdownContentViewProps> = (props) => {
  /*
   * The layout is a signal, seeded from the props in the body rather than built
   * inside the effect below.
   *
   * `createEffect` runs after the first render, so a column whose rows only
   * appeared once the effect had run paints one empty frame first. Building it
   * synchronously here and rebuilding it in the effect costs one extra layout on
   * mount and no extra one afterwards: after the effect writes, the rows are read
   * out of the signal rather than recomputed, because the render effect re-runs
   * against the value the writer just stored.
   */
  const [layout, setLayout] = createSignal(layoutBlocks(props.blocks, props.contentWidth))

  /*
   * The repaint, and the positions.
   *
   * OpenTUI's renderer is demand-driven: it paints when something asks it to, and
   * a Solid state change does not ask it to anything on its own. So the width
   * moved, the rows were rebuilt, and no frame was scheduled -- the panel sat
   * showing the rows for the width it had before, while the TOC had already been
   * handed positions for a layout nobody was looking at. That is the stale-panel
   * shape this repo has paid for four times, and it is why the one effect reads
   * every input that changes what is visible and asks for a frame at the end of
   * it.
   *
   * `blocks` and `contentWidth` are read for their dependencies and not for
   * their values, exactly as `FileViewer` reads `height`: they are getters,
   * compiled from the caller's JSX, and leaving either out would mean the rows
   * rebuild on a new document and never on a resize. The positions are handed
   * over in the same effect for the same reason -- they are a function of the
   * width, because wrapping is, and a TOC that outlives a resize with the row
   * numbers of the old width scrolls to the wrong row.
   */
  createEffect(() => {
    const next = layoutBlocks(props.blocks, props.contentWidth)
    setLayout(next)
    props.onHeadingPositions(next.headingRows)
    props.context.renderer.requestRender()
  })

  return (
    <box flexDirection="column" flexShrink={0} width={props.contentWidth}>
      {layout().rows.map((row) => (
        <text wrapMode="none" truncate>
          {row.map((span) => (
            <span {...spanProps(span)}>{span.text}</span>
          ))}
        </text>
      ))}
    </box>
  )
}