import { createEffect, createSignal, onCleanup, type Component, type Setter } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { RGBA } from "@opentui/core"
import { basename } from "node:path"
import { highlightLines, languageFor, type HighlightedLine } from "./highlight"
import { isMarkdown, mutedText, tocColors, type MarkdownTheme, type TocColors } from "./markdown"
import { MarkdownContentView } from "./MarkdownContentView"
import { extractHeadings, parseMarkdown, type HeadingInfo } from "./markdownParser"
import { readForView, type ViewFile } from "./readForView"
import { maxScroll } from "./scroll"
import { findActiveHeading, type HeadingPositions } from "./toc"

/**
 * Rows of the panel the viewer spends on something other than file content.
 *
 * One of the two is the header. The other is slack: the gutter is a prefix on
 * the same row as the code it labels, not a row of its own, so a caller that
 * reserved a row "for the gutter" would lose a line of content and get nothing
 * back. The panel subtracts this from what it measured before handing `height`
 * down, which is how the viewer stays ignorant of the terminal's size.
 */
export const VIEWER_ROWS_CHROME = 2

/** Default maximum width of the viewer content, in terminal columns. */
const DEFAULT_MAX_WIDTH = 150

/**
 * Columns each level of heading nesting is indented by in the table of
 * contents.
 *
 * `level - 1` spaces, so the top level is flush and its children step in under
 * it. Indenting the top level too would spend two columns on a document whose
 * headings are all `#` and buy nothing, which is also the document most likely
 * to need the columns back.
 */
const TOC_INDENT = "  "

/** The table of contents' own width, for headings that fit inside it. */
const TOC_MIN_WIDTH = 30

/** The ceiling on a table of contents widened to fit its longest heading. */
const TOC_MAX_WIDTH = 40

/**
 * The narrowest content column worth showing beside a table of contents.
 *
 * The sidebar is a luxury and the content is the file, so a panel that can only
 * fit both by squeezing the file into a strip is a panel better off with the
 * file alone. Thirty columns is about where a wrapped paragraph stops reading
 * as prose; below it the reader is looking at the sidebar more carefully than
 * the document.
 */
const MIN_CONTENT_WIDTH = 30

/**
 * The terminal width to assume when the renderer reports none.
 *
 * Zero rather than a guess, and zero reads as "no room": a sidebar drawn at a
 * width nothing measured is a sidebar that may not fit, and the failure mode
 * for that is content pushed off the right edge of the screen. The viewer hides
 * the sidebar instead, which is a thing the reader can live with.
 */
const UNKNOWN_TERMINAL_WIDTH = 0

export type FileViewerProps = {
  path: string
  /** Rows available for content, after the panel has taken its chrome off. */
  height: number
  /** Maximum content width in terminal columns. Defaults to DEFAULT_MAX_WIDTH. */
  maxWidth?: number
  /**
   * The plugin context, passed down by the plugin entry rather than read with
   * `usePlugin()`. Reading it from our own copy of `@opencode/plugin/tui`
   * yields a different Solid context object than the host's.
   */
  context: Context
  /**
   * Handed the component's own writer for the scroll offset, so a keymap that
   * lives outside can move it.
   *
   * A writer and not a value, because the offset belongs to the component:
   * whoever drives it says how far to move, never what the answer is. The keys
   * live outside because the host owns the keymap and its layer ordering, and
   * the offset lives inside because it is display state that only the viewer
   * can repaint against. Hoisting it into plugin state would leave a bare
   * signal, and a bare signal paints nothing until something asks for a frame.
   *
   * Typed as Solid's own `Setter<number>` because that is literally what is
   * handed over: the signal's writer. A narrower declared type would describe
   * what the writer *does* rather than what it *is*, and every caller would
   * then need a cast to bridge the difference -- a cast that says nothing the
   * checker did not already know, and that hides the one thing worth pinning.
   * `Setter<number>` takes an updater, so the caller writes
   * `setScroll((prev) => next)` and the type says exactly that.
   */
  scrollTo?: (setOffset: Setter<number>) => void
  /**
   * Handed the heading positions and the active heading, so a keymap outside
   * can move between them.
   *
   * Readers rather than values, and getters rather than a map handed over once,
   * for the same reason `scrollTo` hands over a writer: both are display state
   * the viewer owns and something else drives. The positions are replaced every
   * time the layout is recomputed -- a resize re-wraps the document and every
   * row below the change moves -- so a snapshot taken when the panel opened
   * would be stale by the first keypress, and a keypress that navigates to a row
   * from the old layout scrolls to the wrong place. A getter always answers for
   * the layout on screen.
   */
  onHeadings?: (state: HeadingState) => void
}

/**
 * What the viewer knows about the document's headings, handed to `onHeadings`.
 *
 * `positions` is the layout's own map, handed over untouched: its rows are
 * 0-based and mean the row the heading's own text is drawn on, and the only
 * correct way to scroll to a heading is to hand that number to the scroll writer
 * as it stands. There is deliberately no `scrollToHeading` here -- the writer
 * belongs to the caller already, through `scrollTo`, and a second path to the
 * scrollbox is a second thing that can disagree with the first.
 *
 * `active` is `-1` when there is no heading to point at. That is a real answer
 * for a document with no headings, and it is NOT a key into `positions`.
 */
export type HeadingState = {
  /** Heading index to the row that heading starts on, for the current layout. */
  positions: () => HeadingPositions
  /** The heading the reader is at, or `-1` when there is none. */
  active: () => number
}

/**
 * One rendered line: its number in the file, and its coloured pieces.
 *
 * The plain text is `lines` itself and is never thrown away -- it is what says
 * how many lines the file has, and what the gutter is numbered against, so
 * neither has to walk tokens to find out.
 */
type Row = { number: number; spans: HighlightedLine }

/**
 * Coloured spans for `lines`, exactly one list per line.
 *
 * The count comes from `lines`, never from what the highlighter returned, and
 * that is not a detail. Tokenizing the joined text gives an array as long as
 * the *tokenized* text has lines, and `readForView` reports a file with nothing
 * in it as the single empty string: joining that gives "", `highlightLines("")`
 * gives no lines at all, and a viewer counting the array draws an empty panel
 * for a file that does have a line in it. A file whose entire content is a
 * single newline arrives in the same shape. Any shortfall is padded with a
 * blank span list, which renders as the blank row it is.
 *
 * Guarded because this is the one step that runs a grammar over untrusted input
 * on the keypress path. `highlightLines` already swallows its own failures; the
 * catch here covers what escapes it -- a grammar that throws while being
 * constructed, a stack overflow on a pathological file -- so a bad grammar costs
 * the reader their colours rather than the whole panel.
 */
function tokenize(lines: string[], path: string): HighlightedLine[] {
  try {
    const highlighted = highlightLines(lines.join("\n"), languageFor(path))
    return lines.map((_, index) => highlighted[index] ?? [])
  } catch {
    return lines.map(() => [])
  }
}

/** What the panel shows in place of a file it cannot render as text. */
function messageFor(file: Exclude<ViewFile, { kind: "text" }>): string {
  const name = basename(file.path)
  return file.kind === "error" ? `cannot read ${name}: ${file.reason}` : `binary file, not shown: ${name}`
}

/**
 * The header for markdown: the name, and the truncation notice when there is
 * one. No line range.
 *
 * The range is dropped because it would be a number the reader cannot map to
 * anything on screen. Markdown's rendered height is not its line count -- a
 * paragraph wraps, a list gains markers, blocks are separated by blank rows --
 * so `1-5 of 3` is both possible and meaningless, and a scroll position the
 * scrollbox owns is not a line of the file. The pruning notice survives,
 * because "first 2000 lines" is a fact about what was read and holds whatever
 * the renderer then does with it.
 *
 * Takes the file already narrowed to `kind: "text"` rather than re-checking the
 * kind itself, and the narrowing is the caller's job rather than a guard here:
 * the only call sits inside `if (markdown)`, and `markdown` already requires
 * `file.kind === "text"`, so a runtime check would be unreachable. It is a
 * parameter rather than a closure over `file` because TypeScript does not carry
 * an alias's narrowing into a nested function -- writing the guard would
 * compile and writing nothing would not, which is what makes the signature the
 * honest place to put it. The text header still checks the kind itself because
 * it also runs for the error and binary kinds.
 */
function markdownHeader(file: Extract<ViewFile, { kind: "text" }>, path: string): string {
  const name = basename(path)
  return file.truncated ? `${name} — first ${file.totalLines} lines` : name
}

/**
 * Which heading the sidebar's window starts at.
 *
 * The one piece of arithmetic the sidebar owns, kept out of the component so it
 * can be tested directly: the stubbed JSX runtime builds `props.children` once,
 * so a window computed inline cannot be observed the moment it has to move.
 *
 * `active` may be `-1`, and that is not an index into anything. It means no
 * heading is active -- a document with no headings, or one scrolled above its
 * first -- and the answer is the top of the list. The alternative would be
 * scrolling the sidebar to `-1` on every keypress in such a document.
 *
 * Two movements and no others, both minimal: the active heading is above the
 * window, so the window starts on it, or it is below the window, so the window
 * ends on it. A sidebar that recentred on every scroll would slide the row the
 * reader is looking at out from under their eyes, which is worse than one
 * showing a few entries above where they are.
 *
 * Bounded above by `total - rows`, which is what stops the window scrolling past
 * the end and drawing blank rows: a list shorter than the window has nothing to
 * scroll and sits at the top.
 *
 * `rows` is floored at one. A zero-row window has no last row to put the active
 * heading on, so the two cases that subtract from it -- "start the window one
 * above the active heading" and "stop the window one short of the end" -- would
 * both be off by a row and can land one past the last entry. The component
 * already floors its own row count at one before calling this, so the floor is
 * belt and braces; it is here because the alternative is a function whose
 * answer for `rows = 0` is `active + 1`, which is a window starting below the
 * heading it was asked to show.
 */
export function tocWindowStart(active: number, total: number, rows: number): number {
  if (active < 0 || total <= rows) return 0
  const window = Math.max(1, rows)
  return Math.min(Math.max(active - window + 1, 0), total - window)
}

/**
 * The props for one coloured run of text inside a row.
 *
 * The colour goes in `style`, not in a bare `fg`, and that is load-bearing
 * rather than a spelling preference. `setProperty` in `@opentui/solid`'s
 * reconciler branches on whether the node is a `TextNodeRenderable` -- which
 * `<span>` is, via `SpanRenderable` -- and that branch handles only `href` and
 * `style` before returning early. A bare `fg` on a `<span>` is silently
 * dropped: it never reaches the renderable at all. `<text>` takes `fg` fine
 * because `TextRenderable` is not a `TextNodeRenderable`, so it falls through
 * to the default assignment that triggers the `fg` setter. The two elements
 * look interchangeable and are not.
 *
 * An uncoloured span gets no `style` key at all. `setProperty`'s `style` branch
 * does `A.fg = l.fg ? parse(l.fg) : A.fg`, so an explicit `fg: undefined`
 * inside `style` would be harmless -- it leaves the renderable alone -- but
 * omitting the key is simpler and matches what the constructor produced.
 * `highlight.ts` maps `operator` and `punctuation` to the theme default on
 * purpose and leaves every unmapped token undefined, so most spans in ordinary
 * code arrive here with no colour at all.
 */
function spanProps(fg: RGBA | string | undefined): { style?: { fg: RGBA | string } } {
  return fg === undefined ? {} : { style: { fg } }
}

/**
 * The style on one row of the table of contents.
 *
 * Every colour is named by value and comes from the host theme (`tocColors`),
 * because a name the host cannot resolve is not a neutral fallback -- it is
 * magenta. This function's first version wrote `fg: "dim"`, which is not a
 * colour at all: `dim` is a *text attribute* (`TextAttributes.DIM`), and as a
 * colour name it misses `CSS_COLOR_NAMES`, falls through to the hex parser, and
 * comes back `RGBA.fromValues(1, 0, 1, 1)`. Every inactive row was pink.
 *
 * The active row names both a foreground and a background rather than setting
 * `reverse`. `reverse` is `TextAttributes.INVERSE`, and the reconciler leaves
 * `node.fg` untouched when the style carries none:
 *
 *     node.fg = value.fg ? parseColor(value.fg) : node.fg
 *
 * so the row inverted the *terminal's* default against the terminal's default
 * background -- light text on a light block on any light background. Naming both
 * ends cannot land there: the pair is the theme's own contrast pair, read one way
 * round for the active row and the other for the rest.
 *
 * Under `style` rather than as bare attributes, because the reconciler handles
 * only `href` and `style` for a `TextNodeRenderable` -- which every `<span>` is
 * -- and returns early before reaching anything else. A bare `bold` or `reverse`
 * on a span is silently dropped.
 *
 * A fresh object per call rather than a shared constant, because `setProperty`
 * ORs the attributes in -- `node.attributes |= createTextAttributes(value)` -- so
 * an object handed out once and mutated in place would carry one row's highlight
 * into every row drawn after it.
 */
export function tocEntryStyle(active: boolean, colors: TocColors): { style: Record<string, RGBA | string | true> } {
  return active
    ? { style: { fg: colors.activeFg, bg: colors.activeBg, bold: true } }
    : { style: { fg: colors.inactive } }
}

export const FileViewer: Component<FileViewerProps> = (props) => {
  const context = props.context

  /*
   * The file is read in the component body, synchronously, for the reason
   * `readDirSync` and `readForView` exist: the plugin runtime does not reliably
   * run promise continuations, so a read that settled on a later tick would
   * paint an empty panel and never fill it in. It also means one open per panel
   * open, which is what the reader's byte and line caps exist to bound.
   *
   * Solid never re-runs a component body, so this is the file *this mount*
   * shows. Opening a different file therefore has to remount the viewer rather
   * than hand a new path to an instance already on screen, which is why the
   * plugin closes the panel before reopening it: closing is what tears the
   * slot's content down. `openViewer` in `tui.tsx` carries that reasoning and a
   * test that pins the path really does move.
   */
  const file = readForView(props.path)

  /*
   * The terminal's width, as a signal rather than a read.
   *
   * Read off the renderer for the reason `FileTree` reads its height the same
   * way: the sidebar slot reports no dimensions of its own, so the renderer is
   * the only thing that knows how wide the screen is. Seeded from the renderer
   * on mount and updated on `resize`, which is what makes a narrowed terminal
   * take the sidebar away instead of leaving it drawn over the content.
   *
   * The initial value is `UNKNOWN_TERMINAL_WIDTH` rather than the renderer's
   * current width. The renderer always has a width by the time a component
   * mounts, but reading it here would subscribe this signal's own initialiser
   * to nothing and hide the question of *when* the first measurement happens;
   * taking it in an effect below means the first render is allowed to be "not
   * measured yet", draw without the sidebar, and repaint with it once the
   * measurement lands. That is the direction that fails safely.
   */
  const [terminalWidth, setTerminalWidth] = createSignal<number>(UNKNOWN_TERMINAL_WIDTH)

  createEffect(() => {
    /*
     * One cast, at the only place the renderer's dimension and event surface
     * meet the viewer's.
     *
     * `Context["renderer"]` is a `CliRenderer`, which has both `width` and the
     * EventEmitter `on`/`off` the resize comes through -- but it is reached
     * through `@opencode/plugin/tui/context`, which borrows those types from
     * `@opentui/core`, a runtime package this plugin must not ship a copy of.
     * `FileTree` reads the same renderer and casts the same way for the same
     * reason, and the two casts are kept to their own files rather than shared
     * because a shared one would be a module both of them import at runtime.
     */
    const renderer = context.renderer as
      | {
          width?: number
          on?: (event: string, handler: () => void) => void
          off?: (event: string, handler: () => void) => void
        }
      | undefined
    if (!renderer) return

    const measure = () => {
      const next = renderer.width
      if (typeof next === "number" && next > 0) setTerminalWidth(Math.floor(next))
    }
    measure()

    renderer.on?.("resize", measure)
    onCleanup(() => renderer.off?.("resize", measure))
  })

  const lines = file.kind === "text" ? file.lines : []
  /*
   * Markdown is a different renderer, not a different colouring of the same one:
   * the old `MarkdownRenderable` parsed and laid out its own blocks inside a
   * native handle, so it never saw the line-by-line span pipeline and said
   * nothing about where anything ended up. It is replaced here by
   * `MarkdownContentView`, which parses through `markdownParser` and lays out
   * through `markdownLayout` -- the one implementation whose row numbers the
   * table of contents reads. That is the whole reason the swap exists: a TOC
   * that scrolls to a row computed by a second, separately-written layout is the
   * defect that got the previous attempt reverted.
   *
   * `blocks` is a snapshot, for the reason `file` above is: Solid never re-runs
   * a component body, so this is the document *this mount* shows, and opening a
   * different file remounts the panel rather than handing a new path to an
   * instance already on screen.
   */
  const markdown = isMarkdown(props.path) && file.kind === "text"
  const blocks = markdown ? parseMarkdown(lines.join("\n")) : []
  /*
   * The TOC's own list, taken from the parser rather than from the layout.
   *
   * Not a second walk of the blocks looking for headings: `extractHeadings` is
   * the same call `layoutBlocks` makes internally, so the indices the sidebar
   * holds are the indices the positions map is keyed by. The two lists are not
   * interchangeable by accident -- `layoutBlocks` skips a heading with no text,
   * so a document whose `#` heading is empty has one more heading *block* than
   * it has TOC entries -- and a sidebar that numbered its rows off the blocks
   * would be one out from the first blank heading down.
   */
  const headings = markdown ? extractHeadings(blocks) : []
  const spans = markdown ? [] : tokenize(lines, props.path)

  /*
   * The scrollbox's own renderable, captured for the keymap's scroll adapter.
   *
   * One closure per mount on purpose: the solid runtime calls `ref` inside a
   * render effect keyed on the function itself, so a fresh arrow per render
   * re-subscribes on every state change. That is the defect `FileTree`'s
   * `captureRoot` carried until its ref was made stable the same way, and it is
   * why the `let` and the writer sit together here rather than in the JSX.
   */
  let markdownBox: unknown
  const captureMarkdownBox = (el: unknown) => {
    markdownBox = el
  }

  /*
   * The offset the markdown path is at, as the table of contents sees it.
   *
   * Read off the renderable by `markdownOffset` below rather than mirrored into
   * this signal's value, and the reason is the one the scroll adapter gives:
   * the scrollbar clamps, so the only position the reader can actually be at is
   * the one the renderable reports. Mirroring the *request* would put the
   * highlight off by exactly the overshoot -- the class of bug this feature
   * exists to prevent. The signal's value is therefore read for its dependency
   * and never for the answer; what it carries is a marker that the offset was
   * last *looked at*, and every write is an opportunity to look again.
   *
   * `0` before the box is captured, which is a real offset and not a sentinel:
   * a document at the top of the file draws its first heading on row 0, and
   * `findActiveHeading` answers `0` for it there.
   */
  const [markdownOffsetSeen, setMarkdownOffset] = createSignal(0)
  const markdownOffset = (): number => {
    markdownOffsetSeen()
    const box = markdownBox as { scrollTop?: number } | undefined
    return typeof box?.scrollTop === "number" ? box.scrollTop : 0
  }

  /*
   * Re-read the scrollbox on every painted frame, so a mouse wheel keeps the
   * sidebar honest.
   *
   * The keys are not the only thing that scrolls. `ScrollBoxRenderable`'s
   * `onMouseEvent` handles a wheel by accumulating a delta and assigning
   * `this.scrollTop` directly (`index.node.js`, `ScrollBoxRenderable.onMouseEvent`),
   * and nothing in this plugin runs: no adapter, no signal write, no repaint
   * effect re-run. The getter above was already reading the live renderable, so
   * the *answer* was right -- but a Solid accessor only re-evaluates when
   * something it read changed, and the only thing it read was the signal. The
   * sidebar therefore sat on the heading the reader was on before the wheel and
   * stayed there until the next keypress or resize, which is the exact "stale
   * panel" shape this repo has paid for four times.
   *
   * A frame is what covers this, and it is what the host offers:
   * `CliRendererEvents.FRAME` is emitted after every frame that renders
   * (`listenerCount(FRAME) > 0` guarding the emit), and a wheel scroll produces
   * frames because the document moved and has to be painted.
   *
   * The scrollbox's own scroll event would be the better shape and is not
   * available, and the reason is worth getting right because it is not the
   * obvious one -- it sits one level up. `ScrollBarRenderable` *does* emit
   * `change`, and readily: `set scrollPosition` (13854) calls
   * `updateSliderFromScrollState()`, which assigns `this.slider.value`, and
   * `SliderRenderable`'s `set value` (13575) fires the `onChange` the
   * scrollbar handed its constructor (13893-13903), a body whose last line is
   * `this.emit("change", { position: this._scrollPosition })`. A wheel,
   * `scrollTo` and `scrollChildIntoView` all set `scrollPosition`, so each
   * one reaches that event; the thumb drag is only the loudest path into it.
   * That same `set value` calls `requestRender()`, so a wheel's frames come
   * down this chain, which is what makes the frame approach sound. What is
   * missing sits one level up from there: `ScrollBoxRenderable`
   * (index.node.js:14187, ~650 lines) emits nothing on itself -- not one
   * `this.emit(...)` in the whole body, of any event kind -- so it never
   * re-emits anything its scrollbars do, and it never listens to their
   * `change`; it only hands their constructors an `onChange` (14404, 14419)
   * that moves the content. A class that emits nothing has nothing to
   * subscribe to, whatever its scrollbars do. That is the real reason, and a
   * stronger one than "the scrollbar does not fire"; a frame is what is left.
   *
   * An earlier version of this comment said the scrollbar's `change` emit was
   * "commented out". It is not -- it exists and fires on thumb drags -- and the
   * conclusion was right for the wrong reason, which is the worst kind of
   * correct. It is recorded here so the next reader does not go looking for a
   * commented-out line that is not there.
   *
   * Cheap by construction: a property read and a comparison per frame, and the
   * write only happens when the number actually moved, so a still sidebar costs
   * nothing and does not re-run the repaint effect sixty times a second.
   */
  createEffect(() => {
    if (!markdown) return
    const renderer = context.renderer as
      | { on?: (event: string, handler: () => void) => void; off?: (event: string, handler: () => void) => void }
      | undefined
    if (!renderer) return

    const resync = () => {
      const box = markdownBox as { scrollTop?: number } | undefined
      if (typeof box?.scrollTop !== "number") return
      // Compared before written, because a signal write that does not change the
      // value is free in Solid and re-running the repaint effect sixty times a
      // second is not.
      if (box.scrollTop === markdownOffset()) return
      setMarkdownOffset(box.scrollTop)
      // The effect above asks for a frame whenever this moves, so the sidebar is
      // already scheduled to repaint; this is not an extra one. It is here so a
      // wheel scroll that lands on the same row the reader was already on does
      // not silently skip a repaint the document itself needs.
      context.renderer.requestRender()
    }

    renderer.on?.("frame", resync)
    onCleanup(() => renderer.off?.("frame", resync))
  })

  /*
   * The writer the markdown path hands the keymap, in place of the signal's.
   *
   * The plugin never says where to go, only how far: it hands an updater over a
   * previous position, and the scrollbox is the source of truth for what that
   * previous position is -- `scrollTop`, not a number any other side holds. The
   * signal writer cannot serve here because nothing on this path reads the
   * signal: the offset lives in the renderable, which does its own scrolling,
   * and a signal nobody reads moves nothing.
   *
   * The clamp is NOT this side's, and a first draft that clamped here is worth
   * recording because it shipped a critical and every test passed. It clamped
   * against `box.maxScrollTop`, which reads as a property and is not one: in
   * `@opentui/core` every occurrence of that name (index.node.js lines 14258,
   * 14287, 14494, 14690 and 14720) is a local `const` inside a method, and
   * `this.maxScrollTop` does not appear at all. So the read was `undefined`,
   * `Math.min(next, undefined)` was `NaN`, `Math.max(0, NaN)` was `NaN`, and
   * `scrollTo(NaN)` left the box with a NaN scroll position -- the panel stops
   * scrolling and says nothing. A stub that declares the property the real
   * renderable lacks cannot catch that, which is exactly what this had.
   *
   * The scrollbar clamps, and it is the side that knows the real content size.
   * `ScrollBoxRenderable.scrollTo` (14482-14484) assigns `this.scrollTop`, the
   * `scrollTop` setter (14236-14237) forwards to `verticalScrollBar.scrollPosition`
   * with no clamp of its own, and `ScrollBarRenderable`'s `scrollPosition` setter
   * (13854-13855) does `Math.round(Math.min(Math.max(0, value), this.scrollSize -
   * this.viewportSize))` -- the same expression `maxScrollTop` would have been,
   * computed from the post-layout viewport rather than from a guess. That is
   * also why the unbounded line count `openViewer` hands the keymap is safe: an
   * overshoot arrives at the setter and comes back as the last legal row.
   */
  const markdownScroll: Setter<number> = (value) => {
    const box = markdownBox as { scrollTop: number; scrollTo(n: number): void } | undefined
    if (!box) return 0
    /*
     * The two forms of `Setter<number>`'s argument, separated rather than
     * inferred.
     *
     * The signal writer's declared type is an overloaded object rather than
     * `(prev: number) => number`, so `typeof value === "function"` narrows it to
     * a union TypeScript will not call a signature across: the caller writes an
     * updater over the previous position, and the declared type happens to allow
     * a bare number as well. So the form is chosen explicitly -- call the updater
     * with the previous position, or take the number -- and each branch is cast
     * to the shape the branch itself says it is. The previous position is the
     * renderable's own `scrollTop`, which is the whole point of reading it here
     * rather than keeping a copy.
     */
    const next: number =
      typeof value === "function" ? (value as (prev: number) => number)(box.scrollTop) : (value as number)
    // Passed through unclamped on purpose. See the comment above: clamping here
    // means guessing a bound the renderable has not published, and the one guess
    // this made was against a property that does not exist.
    box.scrollTo(next)
    // Read back off the box rather than storing `next`: the scrollbar clamps,
    // so `next` is where the reader asked to be and `box.scrollTop` is where
    // the document actually is. The table of contents is driven off this
    // number, and a highlight that follows the request rather than the result
    // is off by exactly the overshoot -- the class of bug this feature exists
    // to stop. Written as a signal purely so the effect below re-runs; the
    // value itself is read off the renderable by `markdownOffset`.
    setMarkdownOffset(box.scrollTop)
    // The repaint effect above reads the signal and `height`, and neither of
    // them moved: the scrollbox did. The renderer is demand-driven, so this is
    // the only thing that will ask for the frame that shows the result -- the
    // stale-panel bug this repo has paid for four times.
    context.renderer.requestRender()
    return next
  }

  /*
   * The offset is a signal rather than a prop because nothing above the panel
   * knows or cares where in the file the reader is: it is display state, and
   * the panel's business is to stay ignorant of it.
   */
  const [scroll, setScroll] = createSignal(0)

  /*
   * Both sides of the window floor the row count at one, and they have to floor
   * it the same way. `maxScroll` refuses to hand out an offset past
   * `totalLines - 1` however few rows the panel claims to have, so a zero-height
   * panel is allowed to sit on the last line -- and slicing with the raw height
   * would then produce an empty window at exactly the offset the clamp says is
   * legal. The guarantee "a clamped offset always leaves a line visible" holds
   * end to end only while the clamp and the slice normalise identically.
   */
  const visibleRows = () => Math.max(1, props.height)

  /** The offset, re-clamped: `height` can change under an offset already set. */
  const offset = () => Math.min(Math.max(scroll(), 0), maxScroll(lines.length, props.height))

  /**
   * The window, as rows.
   *
   * Bounded by `lines.length` and not by `spans.length`, which look identical
   * only because `tokenize` guarantees it: `highlightLines("")` returns no
   * lines at all, so a window built from the tokenized array alone shows nothing
   * for a 0-byte file, whose one line is the empty string.
   */
  const rows = (): Row[] => {
    const start = offset()
    const end = Math.min(lines.length, start + visibleRows())
    const window: Row[] = []
    for (let i = start; i < end; i++) window.push({ number: i + 1, spans: spans[i] ?? [] })
    return window
  }

  const header = () => {
    const name = basename(props.path)
    if (file.kind !== "text") return name
    const start = offset()
    const last = Math.min(file.totalLines, start + visibleRows())
    const position = `${name}  ${start + 1}-${last} of ${file.totalLines}`
    // Only said when content really was dropped: the reader compares the bytes
    // it kept against the size of the file, so the notice cannot mean "the cap
    // is larger than this file", which is the common case.
    return file.truncated ? `${position} — first ${file.totalLines} lines` : position
  }

  /**
   * The gutter's width, so the numbers do not shuffle as the window moves.
   */
  const gutterWidth = String(lines.length).length

  /*
   * The heading positions the layout on screen produced, keyed by heading index.
   *
   * Seeded with an empty map rather than `null` so every reader below can be a
   * plain call: `MarkdownContentView` hands a fresh map over in its own effect
   * on mount, and the reads that happen before that -- the first paint, and any
   * keypress in the gap -- are answered by an empty document, which is what a
   * markdown file with no headings is anyway. `findActiveHeading` on an empty
   * map is `-1`, and `-1` is carried forward as "no heading" all the way to the
   * sidebar, which draws nothing highlighted. That is the whole of the
   * `-1 is not a key` constraint: the value is compared, never looked up.
   *
   * The map itself is never written by anything here. It is the layout's, and
   * the rows in it are 0-based and mean the row the heading's own text is drawn
   * on. Copying it, adjusting it, or rebuilding one from the blocks would all be
   * a second implementation of arithmetic that can disagree with the screen, and
   * a TOC that scrolls to the wrong row is the bug this feature exists to make
   * impossible.
   */
  const [headingPositions, setHeadingPositions] = createSignal<HeadingPositions>(new Map())

  /*
   * Where the layout puts each heading, for `findActiveHeading`.
   *
   * Handed `MarkdownContentView`'s own callback rather than a wrapper that
   * computes anything: the component already recomputes on every width change
   * and hands over a fresh map, and the whole point of the split between
   * `markdownLayout` and `MarkdownContentView` is that there is one layout and
   * the sidebar reads the numbers it produced.
   */
  const onHeadingPositions = (positions: HeadingPositions) => setHeadingPositions(positions)

  /*
   * The heading the reader is at, or `-1` when there is none.
   *
   * A derived read rather than stored state, so it cannot disagree with the two
   * things it is derived from: the positions the current layout handed over and
   * the offset the scrollbox is really at. Storing it would mean updating it in
   * two places -- the layout callback and the scroll adapter -- and a resize
   * that moved every row would leave the stored answer describing the layout
   * before it.
   *
   * `findActiveHeading` is the only thing here that reads the map, and it is
   * given the offset unmodified. The row it compares against is the row the
   * heading is drawn on, so this offset is in the same coordinate space and no
   * adjustment of any kind belongs between them: a "-1 looks nicer" would put
   * the highlight one row off the heading it names.
   */
  const activeHeading = (): number => findActiveHeading(headingPositions(), markdownOffset())

  /*
   * The sidebar's colours, read from the host theme.
   *
   * A getter rather than a value captured once, because the theme is resolved
   * after the plugin mounts: a panel opened before the host had one would
   * otherwise keep the fallback for the rest of the session. Reading through
   * also means a theme change repaints with the new one, since the rows below are
   * rebuilt on every render anyway.
   *
   * `context.theme` is typed `ResolvedTheme` by the host's declarations, but that
   * package is a type-only import we cannot resolve here, so it arrives as the
   * loose shape `MarkdownTheme` describes -- the same cast `buildSyntaxStyle`
   * takes, for the same reason. `themeMode` is a plain union and needs no help.
   */
  const tocPalette = (): TocColors =>
    tocColors(context.theme as MarkdownTheme | undefined, context.themeMode ?? "dark")

  /*
   * The viewer's chrome colour: the line-number gutter on a code file, and every
   * sidebar row the reader is not currently on.
   *
   * The same getter for both because both want the same colour, and because both
   * were once `spanProps("dim")` -- a colour name the host does not know, which
   * resolves to magenta.
   */
  const mutedColour = (): RGBA | string =>
    mutedText(context.theme as MarkdownTheme | undefined, context.themeMode ?? "dark")

  /*
   * How many columns the table of contents wants.
   *
   * Driven by the longest heading rather than fixed, because a sidebar of 30
   * columns showing "Introduction" and truncating a 38-column heading is a
   * sidebar that has decided what the reader is allowed to read. Capped at 40
   * because past that the sidebar has stopped being a list of headings and
   * started being the second half of the panel -- and a heading that long is
   * better read in the document than in the index of it.
   *
   * A heading's own width is its text plus the indent its level earns, and the
   * indent is `level - 1` because the top level is flush; see `TOC_INDENT`.
   */
  const tocWidth = (): number => {
    let longest = 0
    for (const heading of headings) {
      const indent = Math.max(0, heading.level - 1) * TOC_INDENT.length
      longest = Math.max(longest, indent + heading.text.length)
    }
    return Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, longest))
  }

  /*
   * The columns the content column is allowed before the sidebar takes any.
   *
   * `maxWidth` first and the terminal second, and the order matters: the plugin
   * hands the viewer a *preference* for how wide the content should be, and
   * `maxWidth` is that preference. The terminal is a second ceiling on top of it,
   * not an override of it -- a reader who has asked for 60 columns of markdown on
   * a 200-column terminal wants 60, not 200.
   *
   * Both are min'd rather than either/or, so the content is never wider than the
   * screen (a box wider than the terminal is clipped by the screen, which is not
   * "as wide as the reader asked for" in any sense they would recognise) and never
   * wider than the preference (which is the whole point of the preference).
   *
   * This is a function rather than a line inside `contentWidth` because *two*
   * things need it and they must not be able to disagree: the width the content
   * column is drawn at, and the decision about whether the sidebar fits beside
   * it. An earlier revision compared the sidebar's room against the terminal
   * alone, which is right only while `maxWidth` is never the smaller of the two --
   * and `filetree.set-width` is a persisted user setting, so it very much can be.
   * `terminal=200, maxWidth=50` gave a 20-column content column beside a
   * 30-column sidebar, which is the squeeze `MIN_CONTENT_WIDTH` exists to prevent,
   * reached by a route nobody tested.
   */
  const contentCeiling = (): number => {
    const wanted = props.maxWidth ?? DEFAULT_MAX_WIDTH
    const terminal = terminalWidth()
    return terminal > 0 ? Math.min(wanted, terminal) : wanted
  }

  /*
   * Whether the sidebar is drawn at all.
   *
   * Three things have to be true, and each of them is a way the feature would
   * otherwise be broken rather than absent:
   *
   *   - There is something to list. A document with no headings gets no sidebar,
   *     because an empty frame beside the content is a decoration that costs 30
   *     columns and says nothing.
   *   - The terminal has been measured. `UNKNOWN_TERMINAL_WIDTH` stands for "we
   *     do not know how wide this is", and guessing there means drawing a
   *     sidebar at a width that may not exist -- which pushes the content off
   *     the right edge rather than merely leaving it narrower.
   *   - What the content is left with is worth reading. `MIN_CONTENT_WIDTH` is
   *     the floor, and what is compared against it is `contentCeiling()` -- the
   *     same number the content column is then drawn at, less the sidebar's
   *     width. Comparing against the terminal instead would let `maxWidth` under
   *     the terminal pass a check the drawn layout then fails: on a 200-column
   *     terminal with `viewerWidth` set to 50, the terminal has all the room in
   *     the world and the content column has twenty columns.
   */
  const showToc = (): boolean => {
    if (headings.length === 0) return false
    if (terminalWidth() <= 0) return false
    return contentCeiling() - tocWidth() >= MIN_CONTENT_WIDTH
  }

  /*
   * The columns the content column gets.
   *
   * `contentCeiling()` minus the sidebar, and the same two floors the sidebar's
   * own decision implies.
   *
   * One column, never zero. The layout floors its own width at one because a
   * zero-column wrap divides by nothing, and the box this number sizes has to
   * be at least as wide as the rows inside it or the document is clipped by its
   * own frame rather than by the screen. The floor is belt and braces here --
   * `showToc` will not draw a sidebar that would leave less than thirty columns,
   * and with no sidebar `contentCeiling()` is at least one -- but a box one
   * column narrower than its own rows is a failure worth being unreachable rather
   * than unlikely.
   */
  const contentWidth = (): number => {
    return Math.max(1, showToc() ? contentCeiling() - tocWidth() : contentCeiling())
  }

  /*
   * Hands the keymap the writer for whichever scrolling this path owns, rather
   * than a value, so the plugin can move it from outside without holding one.
   *
   * Two writers, because there are two kinds of scrolling and only one of them
   * is a signal. The Prism path moves the offset every row reads through
   * `offset()`; the markdown path moves the scrollbox, which owns its own. One
   * call cannot serve both, and the branch has to be here rather than in the
   * caller because `markdown` is a fact about the file only this component has.
   *
   * Nothing is clamped on the signal side, and nothing has to be: every read of
   * the offset goes through `offset()` above, which clamps, so no value a caller
   * writes -- a runaway, a negative, one left over from a taller panel -- can
   * put the window outside the file. The plugin's `scrollByLine`/`scrollByPage`
   * clamp as well, so the next keypress puts a legal value back. The markdown
   * side clamps nothing and needs to: the box clamps, for the reason its own
   * adapter gives.
   */
  if (markdown) {
    props.scrollTo?.(markdownScroll)
  } else {
    props.scrollTo?.(setScroll)
  }

  /*
   * Hands the keymap the heading state, on the markdown path only.
   *
   * Getters, not values, for the reason `HeadingState` documents: the positions
   * are replaced on every layout and the active heading moves with every
   * keypress, so a snapshot handed over at mount would be describing the
   * document as it was when the panel opened. A caller that reads `positions()`
   * at the moment of a keypress always gets the layout that is on screen.
   *
   * Markdown-only, because a code file has no headings and handing over an
   * empty map would invite a keymap to navigate a document that has nothing to
   * navigate. The absence of the call is the signal: `onHeadings` not having
   * fired means "this file is not a markdown file", which is exactly the
   * condition a keymap binding wants to gate on.
   */
  if (markdown) {
    props.onHeadings?.({ positions: () => headingPositions(), active: activeHeading })
  }

  /*
   * The repaint. OpenTUI's renderer is demand-driven: it paints a frame when
   * something asks it to, and nothing in a plugin's state change does that on its
   * own. So the offset moved, Solid updated the rows, and no frame was ever
   * scheduled -- the panel sat there showing exactly what it showed before,
   * while the window underneath it had already moved. Reopening the panel showed
   * the right thing, which is what made that look like a state bug for so long.
   *
   * Asking the renderer for a frame is the documented way to get that repaint:
   * `requestRender()` schedules a one-shot frame and coalesces repeat calls, so
   * a burst of changes costs one frame and nothing is torn down.
   *
   * Reading every input that changes what is visible turns all the ways the
   * viewer can change -- its own keys, the panel resizing -- into one effect, so
   * none of them can be forgotten again.
   */
  createEffect(() => {
    scroll()
    // Read for the dependency, never for the value. A resize changes how many
    // lines the window holds and where its last line ends, so leaving `height`
    // out would mean the rows rebuild on a scroll and never on a resize --
    // which is the shape of the bug this repo has already paid for twice, where
    // something changed underneath and nothing on screen moved.
    //
    // This read only counts because the caller passes a signal, not a number:
    // the plugin's JSX is `height={viewerHeight()}`, and babel-preset-solid
    // compiles that to a getter, so reading `props.height` here subscribes this
    // effect to the renderer's height. A plain number would make the line inert
    // and unreadable, which is why the test mounts the component with a getter
    // over a signal rather than with a number.
    props.height
    /*
     * The markdown path's own inputs, read for the same reason.
     *
     * `headingPositions` because the sidebar is drawn from it and the rows from
     * the layout are drawn beside it: a resize replaces the map, and without
     * this read the panel would keep highlighting the heading that was active
     * under the old layout while the document under it had re-wrapped. The
     * layout's own effect already asks for a frame when it recomputes, so this
     * is not what paints the rows -- it is what makes *this* effect re-run so
     * the sidebar's own state is recomputed against the new positions.
     *
     * `activeHeading` for the offset underneath it. It is a derived read --
     * `headingPositions` plus the scrollbox's real `scrollTop` -- and the offset
     * signal underneath *that* is written both by the scroll adapter (a keypress)
     * and by the frame listener above (a wheel), so this line is what turns
     * either into a repaint of the highlight. Called rather than its result
     * assigned, because a bare `activeHeading` written to an unused variable is a
     * line a reader has to convince themselves is still a read.
     *
     * `contentWidth` because it decides whether there is a sidebar at all and
     * how wide the content column is, and both of those change on a terminal
     * resize that `props.height` never sees -- a window dragged narrower keeps
     * its height and loses its width. `terminalWidth` is the signal underneath
     * it, so this read subscribes to the resize directly.
     */
    if (markdown) {
      headingPositions()
      activeHeading()
      contentWidth()
    }
    context.renderer.requestRender()
  })

  /*
   * One row per line of the file, always. The gutter is a prefix on the same
   * row rather than a row of its own, so a number cannot drift away from the
   * code it labels, and `wrapMode="none"` plus `truncate` is what keeps it that
   * way: a wrapped code line would become two screen rows and the count would
   * stop matching what is on screen. Same shape as `TreeNode`'s row.
   *
   * The coloured pieces are `<span>`s inside the row's single text node, not
   * nested `<text>`s: OpenTUI's TextNodeRenderable accepts strings,
   * TextNodeRenderables and StyledText, so a nested `<text>` throws where a
   * span does not.
   *
   * The rows are a plain `.map()` inside the root's children rather than a
   * `<For>`, and the kind switch is a ternary rather than a `<Show>`. The test
   * reason is weaker than it was once said to be, and is worth stating
   * accurately rather than repeating: a capitalised JSX tag compiles to
   * `createComponent(Show, props)`, which the stub runtime records *without
   * invoking* -- so a component inside a `<Show>` is never run by a test. Its
   * children are still reachable, because the stub does not invoke the props
   * getters either and the compiled `get children()` survives (`scripts/
   * test-stubs.ts` implements `Show` honestly for exactly that reason), but
   * anything computed inside a component body is not. A ternary and a `.map()`
   * need no such walk: the rows are directly in `props.children`.
   *
   * An earlier version of this comment claimed the stub defined both as
   * `() => null` and that "no test can find them" inside one. The first half is
   * no longer true of `Show`, and the second was never true. The reasoning above
   * is the part that survives.
   *
   * The reactivity is a different question from the choice of element, and it is
   * worth being precise because `FileTree` looks like the counter-example. Its
   * `TreeRows` sits behind a keyed `<Show>`, so its rows are rebuilt by REMOUNT.
   * These are not: babel-preset-solid compiles the ternary and the `.map()` into
   * a single `insert(el, <accessor>, null)`, and it is the reconciler re-calling
   * that accessor on every change to what it reads -- `scroll()` and `props.height`
   * through `rows()`. So the two components have a consistent shape driven by
   * two different mechanisms, and only `FileTree`'s has been run in a real host.
   */
  const renderRow = (row: Row) => (
    <text wrapMode="none" truncate>
      <span {...spanProps(mutedColour())}>{`${String(row.number).padStart(gutterWidth, " ")} │ `}</span>
      {row.spans.map((span) => (
        <span {...spanProps(span.color)}>{span.text}</span>
      ))}
    </text>
  )

  /*
   * One row of the table of contents: an indent, the heading's text, and the
   * highlight when this is the section being read.
   *
   * The indent is `level - 1` steps of `TOC_INDENT`, so the top level sits flush
   * against the sidebar's left edge and each level below it steps right. A
   * heading's text is never re-measured or re-wrapped here: the sidebar's width
   * was decided from the longest of them, and `truncate` on the row is what
   * handles the rounding.
   *
   * The highlight itself is `tocEntryStyle`, which carries the reasoning for
   * reverse-over-colour and for the style-over-attribute choice.
   */
  const renderTocRow = (heading: HeadingInfo, index: number) => {
    const indent = TOC_INDENT.repeat(Math.max(0, heading.level - 1))
    return (
      <text wrapMode="none" truncate>
        <span {...tocEntryStyle(index === activeHeading(), tocPalette())}>{`${indent}${heading.text}`}</span>
      </text>
    )
  }

  /*
   * The table of contents itself: a column beside the content, listing every
   * heading in the document in order.
   *
   * A plain `.map()` in the box's children rather than a `<For>`, for the reason
   * the content rows give: the stub JSX runtime records a capitalised tag
   * without invoking it, so a component inside would never run in a test and its
   * rows would not be reachable. A `.map()` puts them directly in
   * `props.children`, where a test can count them.
   *
   * The window is a slice rather than a scrollbox. A scrollbox would own its own
   * offset in a renderable, which is precisely the state the previous attempt at
   * this feature could not read -- the same reason the content column's
   * scrollbox makes its offset a signal here. The sidebar's offset is a plain
   * number this component owns, adjusted below to keep the active heading in
   * view, and a list of a few dozen headings is not a document.
   */
  const renderToc = () => {
    const width = tocWidth()
    /*
     * How many rows the sidebar has, and therefore which headings fit.
     *
     * `props.height` rather than the terminal's height: it is the panel's own
     * measured budget with the chrome already subtracted, so the sidebar's window
     * and the content's are the same number and the two columns end on the same
     * row. One row is spent on the sidebar's own label, which is why the
     * content below subtracts it.
     */
    const rows = Math.max(1, props.height - 1)

    /*
     * Keep the active heading on screen.
     *
     * `tocWindowStart` owns the arithmetic and the reasoning; the one line here
     * is the call. `-1` is handled inside it rather than here because it is a
     * real value `activeHeading` returns, not a sentinel this call site invents.
     */
    const start = tocWindowStart(activeHeading(), headings.length, rows)

    return (
      <box flexDirection="column" width={width} height={props.height} flexShrink={0}>
        <text fg="gray" wrapMode="none" truncate flexShrink={0}>
          {"Contents"}
        </text>
        {headings.slice(start, start + rows).map((heading, offset) => renderTocRow(heading, start + offset))}
      </box>
    )
  }

  /*
   * Markdown's own branch, ahead of the text one and returning through it
   * rather than into it: the scrollbox owns the scrolling, so everything the
   * text path does with `offset`, `rows` and the gutter would be work thrown
   * away. A separate return also keeps the two shapes from being threaded
   * together by a ternary, which is how a shared header ended up carrying a line
   * range for a file that has none.
   */
  if (markdown) {
    /*
     * The row budget, on a path that otherwise reads it for nothing.
     *
     * `props.height` is the measured, resize-reactive count `tui.tsx` computes
     * and already subtracts `VIEWER_ROWS_CHROME` from, and the repaint effect
     * above reads it -- but on this branch nothing consumed it, so the panel's
     * extent rested entirely on `flexGrow={1}` stretching the claim's element
     * out to the panel area. Whether the host does that has never been observed
     * in this repo; the plugin only ever saw the renderer's height signal.
     *
     * If it does not, this is the shape of the failure: the root box takes its
     * natural height, the scrollbox inside it never gets a bounded viewport,
     * `scrollSize - viewportSize` is 0, and the scrollbar's own setter clamps
     * every keypress back to 0. Markdown scrolling is then inert on every file
     * while the panel still clips to the top rows -- no error, no missing
     * scrollbar, just a preview that will not move. The text path is immune
     * because it slices `rows` to whatever it is given either way; the markdown
     * path exists precisely because it does not slice.
     *
     * So the bound is stated here rather than assumed: `height` is already
     * chrome-adjusted and already reactive, which makes `flexGrow` deterministic
     * instead of a bet on the host. One line, and strictly narrower than the
     * behaviour it replaces -- the box cannot now claim more rows than the
     * panel measured, whatever the container does.
     *
     * The two yoga props below are the other half of that bound, and they are
     * load-bearing rather than tidying. Measured against the real renderer
     * (`scripts/probe-markdown-layout.ts`): OpenTUI renderables default to
     * `flexShrink: 1`, and a fixed-height column whose children's flex bases
     * overflow it shrinks both in proportion to those bases. The scrollbox's
     * basis is `auto` -- its content height, 119 rows for a 60-line document --
     * so with the header's 1 row the column claims 120 rows of a 20-row box.
     * The pair shrink, the scrollbox's basis dominates, and it ends up filling
     * the box from y=0: the captured geometry is header y=0, scrollbox y=0 h=20,
     * viewport y=0, and the captured frame's first row reads `linem1.md` -- the
     * filename and the first line of the file painted on one row. Scrolling
     * moves the first line up out of the overlap, which is why the mixing
     * changes shape as you scroll instead of disappearing, and why a file short
     * enough to fit never shows it.
     *
     * `flexShrink={0}` on the header says its one row is not negotiable;
     * `flexBasis={0}` on the scrollbox says the box's size comes from the
     * container and never from its content -- which is what scrolling is for.
     * Either alone fixes it; both state the invariant from both ends.
     */
    return (
      <box flexDirection="row" justifyContent="center">
        {/*
         * Both columns are `flexShrink={0}`.

         * The content column's bound was already stated above and the sidebar's
         * has to be stated the same way: OpenTUI renderables default to
         * `flexShrink: 1`, and a row whose two children are narrower than the
         * container does not shrink anything -- but the day the terminal is
         * narrower than `contentWidth() + tocWidth()` by even a column, a
         * shrinking sidebar would take its columns out of the *content*, and the
         * layout would be wrapping the document for one width while the rows are
         * drawn in another. `showToc` is what keeps that from happening by
         * refusing to draw a sidebar that does not fit; these two say the same
         * thing from the other end, for the case where the box's own width and
         * the terminal's disagree about it.
         */}
        <box
          flexDirection="column"
          width={contentWidth()}
          height={props.height}
          flexShrink={0}
        >
          <text fg="gray" wrapMode="none" truncate flexShrink={0}>
            {markdownHeader(file, props.path)}
          </text>
          <scrollbox flexGrow={1} flexBasis={0} ref={captureMarkdownBox}>
            {/*
              The rows, from the one layout.

              `MarkdownContentView` is handed `contentWidth` and not the content
              box's own `width` because it draws at that width and the box has to
              be exactly as wide as the rows inside it. Any disagreement between
              the two and the document is wrapped for one width and drawn in
              another, which puts every heading row the sidebar recorded on a row
              the reader does not see it on.

              No `syntaxStyle`. It is deliberately not a prop of this component:
              `SyntaxStyle` is a native handle keyed by tree-sitter scope names,
              consulted only by the tree-sitter pipeline inside
              `MarkdownRenderable`, and nothing in this layout tokenizes with
              tree-sitter. Blocks come from `marked` and fences from Prism, and
              the chrome comes from the One Dark palette `highlight.ts` already
              uses. Passing one would be a handle the component quietly ignores,
              so `MarkdownContentView.test.ts` holds a `@ts-expect-error` over
              the prop and this is the call site that would break first if it came
              back.
            */}
            <MarkdownContentView
              blocks={blocks}
              contentWidth={contentWidth()}
              context={context}
              onHeadingPositions={onHeadingPositions}
            />
          </scrollbox>
        </box>
        {showToc() ? renderToc() : null}
      </box>
    )
  }

  return (
    <box flexDirection="row" justifyContent="center">
      <box flexDirection="column" width={props.maxWidth ?? DEFAULT_MAX_WIDTH}>
        {/* "gray" rather than "dim": `parseColor` accepts CSS colour names and
            hex only, and a name it does not know does not fall back to the theme
            -- it falls back to magenta. Every header here was magenta until this. */}
        <text fg="gray" wrapMode="none" truncate>
          {header()}
        </text>
        {file.kind === "text" ? (
          rows().map(renderRow)
        ) : (
          <text fg="gray" wrapMode="none" truncate>
            {messageFor(file)}
          </text>
        )}
      </box>
    </box>
  )
}
