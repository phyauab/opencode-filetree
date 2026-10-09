import { createEffect, createSignal, type Component } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { basename } from "node:path"
import { highlightLines, languageFor, type HighlightedLine } from "./highlight"
import { readForView, type ViewFile } from "./readForView"
import { maxScroll } from "./scroll"

/**
 * Rows of the panel the viewer spends on something other than file content.
 *
 * The panel subtracts this from what it measured before handing `height` down,
 * which is how the viewer gets to stay ignorant of the terminal's size.
 */
export const VIEWER_ROWS_CHROME = 2 // header + gutter allowance

export type FileViewerProps = {
  path: string
  /** Rows available for content, excluding the header and the gutter. */
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
   */
  scrollTo?: (fn: (prev: number) => number) => void
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
 * The props for one coloured run of text inside a row.
 *
 * `@opentui/solid` publishes `<span>` as `ComponentProps<{}, TextNodeRenderable>`
 * -- an empty object -- so the checker rejects `fg` even though `TextNodeOptions`,
 * which is what `SpanRenderable` is constructed with and what the renderable
 * honours, carries `fg?: string | RGBA`. This is the whole of the workaround,
 * and it lives in one place so the two `<span>`s below cannot drift into
 * disagreeing about it. A plain spread rather than a cast on the element,
 * because a cast on the element would have to be written twice and would hide
 * the shape from every reader of the row.
 */
function spanProps(fg: string | undefined): Record<string, string | undefined> {
  return { fg }
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
   * shows. Opening a different file therefore has to remount the viewer --
   * Task 5 gets that for free by closing the panel, which tears the slot down --
   * rather than by handing a new path to an instance already on screen.
   */
  const file = readForView(props.path)

  const lines = file.kind === "text" ? file.lines : []
  const spans = tokenize(lines, props.path)

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
    const range = file.totalLines === 0 ? "0" : `${start + 1}-${last}`
    const position = `${name}  ${range} of ${file.totalLines}`
    // Only said when content really was dropped: the reader compares the bytes
    // it kept against the size of the file, so the notice cannot mean "the cap
    // is larger than this file", which is the common case.
    return file.truncated ? `${position} — first ${file.totalLines} lines` : position
  }

  /** The gutter's width, so the numbers do not shuffle as the window moves. */
  const gutterWidth = String(lines.length).length

  /*
   * Hands the keymap the signal's own writer rather than a value, so Task 5 can
   * move the offset from outside without holding one.
   *
   * Nothing is clamped on the way in, and nothing has to be: every read of the
   * offset goes through `offset()` above, which clamps, so no value a caller
   * writes -- a runaway, a negative, one left over from a taller panel -- can
   * put the window outside the file. Task 5's own `scrollByLine`/`scrollByPage`
   * clamp as well, so the next keypress puts a legal value back.
   */
  props.scrollTo?.(setScroll)

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
   */
  const renderRow = (row: Row) => (
    <text wrapMode="none" truncate>
      <span {...spanProps("dim")}>{`${String(row.number).padStart(gutterWidth, " ")} │ `}</span>
      {row.spans.map((span) => (
        <span {...spanProps(span.color)}>{span.text}</span>
      ))}
    </text>
  )

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