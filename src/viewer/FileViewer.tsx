import { createEffect, createSignal, type Component, type Setter } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { basename } from "node:path"
import { highlightLines, languageFor, type HighlightedLine } from "./highlight"
import { buildSyntaxStyle, isMarkdown, type MarkdownTheme } from "./markdown"
import { readForView, type ViewFile } from "./readForView"
import { maxScroll } from "./scroll"

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

export type FileViewerProps = {
  path: string
  /** Rows available for content, after the panel has taken its chrome off. */
  height: number
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
 * `Context["theme"]` is typed as an unresolved import -- `@opencode/plugin/tui/context`
 * borrows it from `@opentui/core`, which is a runtime package this plugin must
 * not ship a copy of -- so the one cast that bridges it lives here rather than at
 * the use site.
 */
function themeOf(context: Context): MarkdownTheme | undefined {
  return (context as { theme?: MarkdownTheme }).theme
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
function spanProps(fg: string | undefined): { style?: { fg: string } } {
  return fg === undefined ? {} : { style: { fg } }
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

  const lines = file.kind === "text" ? file.lines : []
  /*
   * Markdown is a different renderer, not a different colouring of the same one:
   * `MarkdownRenderable` parses and lays out its own blocks, so it never sees the
   * line-by-line span pipeline and does not need it. `buildSyntaxStyle` cannot
   * return undefined -- it falls back to the empty style, which is what the host
   * itself uses -- so there is no colour-driven fork back to the Prism path. A
   * thin theme buys an uncoloured preview, never raw source.
   */
  const markdown = isMarkdown(props.path) && file.kind === "text"
  const syntaxStyle = markdown ? buildSyntaxStyle(themeOf(context)) : undefined
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
   * The writer the markdown path hands the keymap, in place of the signal's.
   *
   * The plugin never says where to go, only how far: it hands an updater over a
   * previous position, and the scrollbox is the source of truth for what that
   * previous position is -- `scrollTop`, not a number any other side holds. The
   * signal writer cannot serve here because nothing on this path reads the
   * signal: the offset lives in the renderable, which does its own scrolling,
   * and a signal nobody reads moves nothing.
   *
   * The clamp is this side's because it is the only one that knows the rendered
   * height. `openViewer` in `tui.tsx` hands the keymap a line count that
   * deliberately cannot clamp, so `scrollByLine` will keep asking for one more
   * row than there is; left unclamped the bottom of a long file would be
   * unreachable, and overshooting it would leave the panel blank. `box.maxScrollTop`
   * is the renderable's own answer, computed after it laid out.
   */
  const markdownScroll: Setter<number> = (value) => {
    const box = markdownBox as
      | { scrollTop: number; maxScrollTop: number; scrollTo(n: number): void }
      | undefined
    if (!box) return 0
    const updater = typeof value === "function" ? value : () => value
    const next = updater(box.scrollTop)
    box.scrollTo(Math.max(0, Math.min(next, box.maxScrollTop)))
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
   * side clamps itself, for the reason its own adapter gives.
   */
  if (markdown) {
    props.scrollTo?.(markdownScroll)
  } else {
    props.scrollTo?.(setScroll)
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
      <span {...spanProps("dim")}>{`${String(row.number).padStart(gutterWidth, " ")} │ `}</span>
      {row.spans.map((span) => (
        <span {...spanProps(span.color)}>{span.text}</span>
      ))}
    </text>
  )

  /*
   * Markdown's own branch, ahead of the text one and returning through it
   * rather than into it: the scrollbox owns the scrolling, so everything the
   * text path does with `offset`, `rows` and the gutter would be work thrown
   * away. A separate return also keeps the two shapes from being threaded
   * together by a ternary, which is how a shared header ended up carrying a line
   * range for a file that has none.
   *
   * The `syntaxStyle` assertion is `buildSyntaxStyle`'s own guarantee rather
   * than a guess: it falls back to `SyntaxStyle.create()` when the theme is
   * thin, so the only way the body's variable is undefined is its other arm.
   */
  if (markdown) {
    return (
      <box flexDirection="column">
        <text fg="dim" wrapMode="none" truncate>
          {markdownHeader(file, props.path)}
        </text>
        <scrollbox flexGrow={1} ref={captureMarkdownBox}>
          <markdown content={lines.join("\n")} syntaxStyle={syntaxStyle!} conceal />
        </scrollbox>
      </box>
    )
  }

  return (
    <box flexDirection="column">
      <text fg="dim" wrapMode="none" truncate>
        {header()}
      </text>
      {file.kind === "text" ? (
        rows().map(renderRow)
      ) : (
        <text fg="dim" wrapMode="none" truncate>
          {messageFor(file)}
        </text>
      )}
    </box>
  )
}
