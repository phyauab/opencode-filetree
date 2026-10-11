import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"
import type { RGBA } from "@opentui/core"
import { FileViewer, VIEWER_ROWS_CHROME, tocWindowStart, tocEntryStyle } from "./FileViewer"
import { MarkdownContentView } from "./MarkdownContentView"
import { MAX_VIEW_LINES } from "./readForView"

const created: string[] = []

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

/**
 * An `RGBA`, in the shape the host resolves its theme colours to.
 *
 * The real class keeps channels in a `Uint16Array` and exposes them as 0..1
 * getters (`@opentui/core`, `class RGBA`); this reproduces that shape, because
 * reading those getters is what the viewer's theme reader does. The stubbed
 * `@opentui/core` exports no `RGBA`, so the real class is not importable here.
 */
const rgba = (hex: string): RGBA => {
  const value = Number.parseInt(hex.slice(1), 16)
  const buffer = new Uint16Array([(value >> 16) & 255, (value >> 8) & 255, value & 255, 255])
  // One cast, confined to this fixture factory: the object reproduces the
  // channels the viewer's reader reads and the class's own storage, and the
  // rest of the class is never touched on this path -- what the tests need is
  // the shape `tokenValue` accepts, not a second implementation of it.
  return {
    buffer,
    get r() {
      return (buffer[0] & 255) / 255
    },
    get g() {
      return (buffer[1] & 255) / 255
    },
    get b() {
      return (buffer[2] & 255) / 255
    },
    get a() {
      return (buffer[3] & 255) / 255
    },
  } as unknown as RGBA
}

function makeFile(name: string, contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "viewer-"))
  created.push(root)
  const path = join(root, name)
  writeFileSync(path, contents)
  return path
}

/**
 * Counts the frames the plugin asks for, the way FileTree's own mock does.
 *
 * The width is a parameter because the table of contents decides whether it can
 * be drawn from it, and a mock that always reported the same width would make
 * "the sidebar is hidden in a narrow terminal" untestable without a second mock.
 * It defaults to zero -- the "not measured" case -- so every test written before
 * the sidebar existed keeps the behaviour it had.
 *
 * `fireFrame` emits the renderer's `frame` event, which is what a wheel scroll
 * over the scrollbox produces and what the viewer's listener hangs off. The host
 * guards the emit with `listenerCount(FRAME) > 0`, so the mock does the same: a
 * frame with nobody listening is not a frame worth reporting, and returning
 * whether it fired lets a test say "nothing asked for this".
 */
function createMockRenderer(width = 0) {
  const counter = { frames: 0 }
  const listeners = new Map<string, Set<() => void>>()
  const on = (event: string, handler: () => void) => {
    const set = listeners.get(event) ?? new Set()
    set.add(handler)
    listeners.set(event, set)
  }
  const off = (event: string, handler: () => void) => {
    listeners.get(event)?.delete(handler)
  }
  return {
    height: 40,
    width,
    on,
    off,
    requestRender: () => {
      counter.frames++
    },
    frames: () => counter.frames,
    frameListeners: () => listeners.get("frame")?.size ?? 0,
    /** Emits one painted frame. False when nothing was listening for it. */
    fireFrame: () => {
      const set = listeners.get("frame")
      if (!set || set.size === 0) return false
      for (const handler of [...set]) handler()
      return true
    },
  }
}

/** The subset of the host's context the viewer is handed. */
function makeContext(renderer: any, path: string) {
  return {
    location: { directory: path },
    data: { location: { default: () => ({ directory: path }) } },
    storage: {
      memory(key: string, options: { initial: unknown }) {
        return [options.initial, () => {}]
      },
    },
    renderer,
    ui: { format: { path: (p: string) => p } },
  }
}

/**
 * Mounts the viewer through the stub JSX runtime.
 *
 * The stub builds a plain description of the tree instead of calling OpenTUI, so
 * the rows are inspectable without a renderer. `scrollTo` is the writer the
 * component hands out; passing one is how a test stands in for a keypress.
 */
function mount(path: string, height: number, renderer: any = createMockRenderer(), extra: any = {}) {
  // `theme` belongs on the context, not on the component's props, because the
  // viewer reads `context.theme`. It is pulled out of `extra` so every existing
  // call -- which passes no theme -- is unchanged and simply gets `undefined`.
  const { theme, ...props } = extra
  return (FileViewer as any)({
    path,
    height,
    context: { ...makeContext(renderer, path), theme },
    ...props,
  })
}

/** Every element in a `children` prop, however deeply nested. */
function elements(children: unknown): any[] {
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  return list.filter((child): child is any => Boolean(child) && typeof child === "object")
}

/**
 * The content column: the one child `box` the root wraps the viewer's rows in.
 *
 * The root is `<box flexDirection="row" justifyContent="center">` wrapping a
 * `<box flexDirection="column">`, so the header and the rows are the
 * *grandchildren* of whatever the component returned. Master commit `19f6f38`
 * ("feat: make viewer width configurable via command palette") added that
 * centring box and never told this file, so the four helpers below each searched
 * one flat `children` level, found the centring box where they expected the
 * header, and reported empty results on every test that needed the rows.
 *
 * Every helper in this file therefore takes this step first and searches inside
 * the content column afterwards. It is the single implementation of that
 * traversal: a second one, written again wherever a test needed a row, is a
 * second thing that can disagree with the markup.
 */
function contentColumnOf(element: any): any {
  return elements(element?.props?.children).find((child: any) => child.type === "box")
}

/** The content column's children as elements: the header, then the rows. */
function contentChildrenOf(element: any): any[] {
  return elements(contentColumnOf(element)?.props?.children)
}

/**
 * The text a node renders, following the stub's shape: children are strings,
 * spans, or arrays of either, at any depth.
 */
function textOf(node: any): string {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  return typeof node === "object" ? textOf(node.props?.children) : ""
}

/** The header line, which is always the first child of the content column. */
function headerOf(element: any): string {
  return textOf(contentChildrenOf(element)[0])
}

/**
 * The rendered content rows, which is everything after the header.
 *
 * A message row (error, binary) is included: it is drawn in the same slot, so
 * the assertions do not have to know which kind produced it.
 */
function rowsOf(element: any): string[] {
  return contentChildrenOf(element)
    .slice(1)
    .map(textOf)
}

/**
 * The first code row, which is the one content row that is not the header.
 *
 * Its own traversal rather than a number a caller re-derives, because
 * `codeColorsOf` and the "uncoloured piece" test both need the same element and
 * two ways of reaching it are two ways to drift apart.
 */
function codeRowOf(element: any): any {
  return contentChildrenOf(element)[1]
}

/** The colours a row's own pieces carry, in order, so highlighting is assertable. */
function codeColorsOf(element: any): (string | undefined)[] {
  const row = codeRowOf(element)
  // The first span is the gutter, which is dim by design and carries no code.
  return elements(row?.props?.children)
    .filter((child: any) => child.type === "span")
    .map((span: any) => span.props.style?.fg)
    .slice(1)
}

describe("FileViewer", () => {
  it("renders one row per visible line, with line numbers in the gutter", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    const element = mount(path, 3)

    expect(rowsOf(element)).toEqual(["1 │ one", "2 │ two", "3 │ three"])
  })

  it("shows only as many rows as the panel has", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    expect(rowsOf(mount(path, 2))).toEqual(["1 │ one", "2 │ two"])
  })

  it("shows the file name, the visible range and the line count in the header", () => {
    const path = makeFile("notes.txt", "one\ntwo\nthree\nfour\nfive\n")
    const header = headerOf(mount(path, 2))

    expect(header).toContain("notes.txt")
    expect(header).toContain("1-2")
    // The count is the reader's own: a header claiming more lines than were
    // read is the "wrong number in the header" readForView refuses to produce.
    expect(header).toContain("of 5")
  })

  it("gives the header alone, with no rows glued on after it", () => {
    /*
     * Every header assertion above is a `toContain`, and that is what lets a
     * broken `headerOf` pass all of them.
     *
     * The traversal this file had before master's `19f6f38` stopped one level
     * short of the column the rows live in, and `textOf` follows children
     * recursively -- so it returned the header's text concatenated with every
     * row beneath it. `toContain` cannot tell the difference, so no header test
     * failed, and the helper was quietly returning a string no header is. This
     * pins it exactly so the fix is load-bearing rather than merely correct.
     */
    const path = makeFile("notes.txt", "one\ntwo\nthree\n")
    expect(headerOf(mount(path, 2))).toBe("notes.txt  1-2 of 3")
  })

  it("says so when the file was truncated", () => {
    const path = makeFile("big.txt", "x\n".repeat(2001))
    const header = headerOf(mount(path, 5))

    expect(header).toContain("big.txt")
    expect(header).toContain("first 2000 lines")
  })

  it("says nothing about truncation when the whole file fit", () => {
    const path = makeFile("f.txt", "one\ntwo\n")
    expect(headerOf(mount(path, 5))).not.toContain("first")
  })

  it("renders a readable message for kind 'error' (Review Focus #1)", () => {
    const missing = join(tmpdir(), "definitely-not-here-4c81")
    const rows = rowsOf(mount(missing, 5))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("cannot read")
    // The reason is the reader's, not `String(error)`: only `reason` carries a
    // sentence the user can act on.
    expect(rows[0]).toContain("not found")
  })

  it("renders a readable message for kind 'binary' (Review Focus #1)", () => {
    const path = makeFile("blob.bin", Buffer.from([0x41, 0x00, 0x42]))
    const rows = rowsOf(mount(path, 5))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("binary")
  })

  it("renders plain rows for an unrecognised extension (Review Focus #4)", () => {
    const path = makeFile("data.weird", "alpha\nbeta\n")
    const element = mount(path, 5)

    expect(rowsOf(element)).toEqual(["1 │ alpha", "2 │ beta"])
    // No grammar means no colour at all, so every piece inherits the theme
    // default rather than picking one out of the table. The count is here
    // because `.every` on an empty array is vacuously true: without it, a
    // `codeColorsOf` that had lost the row entirely would pass below by
    // returning nothing and proving nothing.
    expect(codeColorsOf(element).length).toBeGreaterThan(0)
    expect(codeColorsOf(element).every((color) => color === undefined)).toBe(true)
  })

  it("colours a recognised extension from the highlighter", () => {
    const path = makeFile("a.ts", "const value = 1\n")
    const element = mount(path, 5)

    expect(rowsOf(element)).toEqual(["1 │ const value = 1"])
    expect(codeColorsOf(element)).toContain("#c678dd")
  })

  it("gives an uncoloured piece no style key at all, not an explicit undefined", () => {
    // `highlight.ts` maps `operator` and `punctuation` to the theme default on
    // purpose and leaves every unmapped token undefined, so most pieces of
    // ordinary code arrive uncoloured. The reconciler's `style` branch does
    // `A.fg = l.fg ? parse(l.fg) : A.fg`, so an explicit `fg: undefined` inside
    // `style` would be harmless -- it leaves the renderable alone -- but
    // omitting the key is simpler and matches what the constructor produced.
    const path = makeFile("a.ts", "const value = 1\n")
    const element = mount(path, 5)
    const pieces = elements(codeRowOf(element)?.props?.children)
      .filter((child: any) => child.type === "span")
      .slice(1)

    const coloured = pieces.filter((piece: any) => piece.props.style?.fg !== undefined)
    const uncoloured = pieces.filter((piece: any) => piece.props.style?.fg === undefined)
    // Both kinds really are present, so the assertion below is about the
    // uncoloured ones specifically rather than about an all-default row.
    expect(coloured.length).toBeGreaterThan(0)
    expect(uncoloured.length).toBeGreaterThan(0)
    expect(uncoloured.every((piece: any) => !("style" in piece.props))).toBe(true)
  })

  it("never wraps a row, truncating at its own width instead", () => {
    const path = makeFile("f.txt", "one\ntwo\n")
    const element = mount(path, 5)
    for (const child of contentChildrenOf(element)) {
      expect(child.props.wrapMode).toBe("none")
      expect(child.props.truncate).toBe(true)
    }
  })

  it("asks the renderer for a frame when the scroll offset changes", () => {
    // The renderer is demand-driven: state that changed without anything asking
    // for a frame leaves the panel showing exactly what it showed before.
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    const renderer = createMockRenderer()
    let write: ((fn: (prev: number) => number) => void) | undefined
    mount(path, 3, renderer, { scrollTo: (fn: any) => (write = fn) })
    const before = renderer.frames()

    write!((prev) => prev + 2)

    expect(renderer.frames()).toBeGreaterThan(before)
  })

  it("asks for a frame when the panel resizes, not only when the offset moves", () => {
    /*
     * The last read in the repaint effect with no test behind it.
     *
     * `height` is read for its dependency and never for its value, so the only
     * way to tell whether the read is there is to change it and see whether a
     * frame is asked for. Mounting with a plain number cannot do that: a
     * number is not a signal, nothing subscribes to it, and the read is
     * invisible however it is written.
     *
     * So the props are given a getter over a signal, which is exactly what
     * babel-preset-solid emits for `height={viewerHeight()}` in the plugin's
     * JSX. Remove `props.height` from the effect and the effect no longer
     * touches the signal, so the write re-runs nothing and this fails.
     */
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    const renderer = createMockRenderer()
    const [height, setHeight] = createSignal(3)
    const props: any = {
      path,
      context: makeContext(renderer, path),
      get height() {
        return height()
      },
    }

    ;(FileViewer as any)(props)
    const before = renderer.frames()

    setHeight(2)

    // A resize changes how many lines the window holds and where its last line
    // ends, so leaving `height` out of the effect means the rows rebuild on a
    // scroll and never on a resize.
    expect(renderer.frames()).toBeGreaterThan(before)
  })

  it("asks for no frame when the offset is written to the value it already had", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\n")
    const renderer = createMockRenderer()
    let write: ((fn: (prev: number) => number) => void) | undefined
    mount(path, 3, renderer, { scrollTo: (fn: any) => (write = fn) })
    const before = renderer.frames()

    write!((prev) => prev)

    expect(renderer.frames()).toBe(before)
  })

  it("scrollTo(2) renders the window starting two lines down", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    const element = mount(path, 3, createMockRenderer(), {
      scrollTo: (fn: (updater: (prev: number) => number) => void) => fn((prev) => prev + 2),
    })

    expect(rowsOf(element)).toEqual(["3 │ three", "4 │ four", "5 │ five"])
  })

  it("clamps a runaway offset to the last line rather than past it", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    const element = mount(path, 3, createMockRenderer(), {
      scrollTo: (fn: (updater: (prev: number) => number) => void) => fn((prev) => prev + 5000),
    })

    expect(rowsOf(element)).toEqual(["3 │ three", "4 │ four", "5 │ five"])
  })

  it("refuses a negative offset", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\n")
    const element = mount(path, 3, createMockRenderer(), {
      scrollTo: (fn: (updater: (prev: number) => number) => void) => fn((prev) => prev - 5000),
    })

    expect(rowsOf(element)).toEqual(["1 │ one", "2 │ two", "3 │ three"])
  })
})

/*
 * The two defects carried forward from the reviews of tasks 2 and 3. Both were
 * found in code that is already committed and neither is handled anywhere else,
 * so the component that joins those modules is the only place they can be
 * closed.
 */

describe("a file with no lines of its own", () => {
  it("renders one row for a zero-byte file, not zero", () => {
    // readForView hands over [""], whose join is "", and highlightLines("") is
    // []. Counting the highlighted array therefore renders nothing at all for
    // a file that does have one line, and the panel looks broken rather than
    // empty.
    const path = makeFile("empty.ts", "")
    const element = mount(path, 5)
    const rows = rowsOf(element)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain("1")
    expect(headerOf(element)).toContain("of 1")
  })

  it("renders one row for a file whose whole content is a newline", () => {
    // The same shape by a different route: one empty line, no text to tokenize.
    const path = makeFile("blank.ts", "\n")
    const element = mount(path, 5)

    expect(rowsOf(element)).toHaveLength(1)
    expect(rowsOf(element)[0]).toContain("1")
  })

  it("numbers an interior blank line like any other row", () => {
    const path = makeFile("f.txt", "one\n\nthree\n")
    expect(rowsOf(mount(path, 5))).toEqual(["1 │ one", "2 │ ", "3 │ three"])
  })
})

describe("a panel with no rows yet", () => {
  // maxScroll floors the viewport at one row, so a zero-height panel is allowed
  // an offset of totalLines - 1. A slice that used the raw height instead would
  // render nothing at exactly that offset, and the guarantee the clamp exists
  // to provide -- a legal offset always leaves a line on screen -- would hold
  // for the maths and not for the screen.

  it("still shows a line at the furthest offset the clamp permits", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    const element = mount(path, 0, createMockRenderer(), {
      scrollTo: (fn: (updater: (prev: number) => number) => void) => fn((prev) => prev + 4),
    })

    expect(rowsOf(element)).toEqual(["5 │ five"])
  })

  it("still shows a line when a zero-height panel is pushed far past the end", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\nfour\nfive\n")
    const element = mount(path, 0, createMockRenderer(), {
      scrollTo: (fn: (updater: (prev: number) => number) => void) => fn((prev) => prev + 5000),
    })

    expect(rowsOf(element)).toEqual(["5 │ five"])
  })

  it("shows the first line at offset zero with no rows to draw it", () => {
    const path = makeFile("f.txt", "one\ntwo\nthree\n")
    expect(rowsOf(mount(path, 0))).toEqual(["1 │ one"])
  })
})

describe("VIEWER_ROWS_CHROME", () => {
  it("reserves two rows for the header plus slack, none of them for a gutter", () => {
    // One row is the header. The other is slack. The gutter is a prefix on each
    // content row, so it spends no row of its own, and a caller that believed
    // otherwise would subtract a line of file to keep nothing.
    expect(VIEWER_ROWS_CHROME).toBe(2)
  })
})

/**
 * A theme with one real markdown token in it, so `buildSyntaxStyle` builds one
 * real scope row instead of falling back to the empty style.
 *
 * The token is an `RGBA` because that is what the host resolves its theme to
 * (`ResolvedTheme`); a hex string here would read as no colour at all, which is
 * how the live host came to render every markdown file white while this suite
 * passed.
 *
 * It exists to make the theme -> context -> style wiring observable, which is
 * otherwise invisible: the element renders either way. It says nothing about
 * which files count as markdown -- the extension decides that alone, through
 * `isMarkdown` -- so a thinner theme must never be read as "not markdown".
 */
const mdTheme = { markdown: { heading: rgba("#e06c75") } }

/** The columns the mock reports its terminal as being. */
const WIDE_TERMINAL = 120

/**
 * Mounts a file and, optionally, the heading state the viewer handed the keymap.
 *
 * `onHeadings` is captured rather than asserted on directly because it is the
 * only channel the table of contents has to the outside world: the positions map
 * is replaced on every layout and the active heading moves on every keypress,
 * so what a caller sees is the value at the moment it reads, not a snapshot.
 */
function mountCapturingHeadings(path: string, height: number, extra: any = {}) {
  let state: any
  const { renderer, ...rest } = extra
  const element = mount(path, height, renderer ?? createMockRenderer(WIDE_TERMINAL), {
    ...rest,
    onHeadings: (s: any) => {
      state = s
    },
  })
  return { element, headings: () => state }
}

/**
 * The `MarkdownContentView` element, which is the scrollbox's only child.
 *
 * Found by identity against the imported component rather than by a type string,
 * because the stub builds a capitalised tag as `{type: <the function>, props}`.
 * A string comparison here would pass against any component with the right name
 * and fail the moment the import is aliased.
 */
function contentViewOf(element: any): any {
  const box = elements(contentColumnOf(element)?.props?.children).find((child: any) => child.type === "scrollbox")
  return elements(box?.props?.children).find((child: any) => child.type === MarkdownContentView)
}

/**
 * Runs the content view, which is what hands the positions over.
 *
 * The stub records a component without invoking it -- `createComponent` writes
 * `{comp, props}` and stops -- so `onHeadingPositions` never fires until a test
 * calls the element itself. `MarkdownContentView.test.ts` does the same, and for
 * the same reason.
 */
function renderContentView(element: any): any {
  const view = contentViewOf(element)
  view.type(view.props)
  return view
}

/** The scrollbox, reached the way `contentViewOf` reaches it. */
function scrollboxIn(element: any): any {
  return elements(contentColumnOf(element)?.props?.children).find((child: any) => child.type === "scrollbox")
}

/**
 * The table of contents: the root's second box, the one that is not the content.
 *
 * Found by position rather than by a marker prop. A `data-` or `id` prop would be
 * easier to select, but it would be a prop that exists only for tests, and the day
 * somebody renames it in the markup these go quiet without failing. The two boxes
 * are the whole of the sidebar's identity -- it is the second column -- so asking
 * for the second column is asking for the thing itself.
 */
function tocOf(element: any): any {
  return elements(element?.props?.children).filter((child: any) => child.type === "box")[1]
}

/** The sidebar's rows, as text, label included. */
function tocRowsOf(element: any): string[] {
  return elements(tocOf(element)?.props?.children).map(textOf)
}

/** One sidebar row's span, which is where the highlight lives. */
function tocRowStyle(element: any, row: number): Record<string, string | true> | undefined {
  const entry = elements(tocOf(element)?.props?.children)[row]
  return elements(entry?.props?.children).find((child: any) => child.type === "span")?.props?.style
}

/**
 * A stand-in for the ScrollBoxRenderable, with a `scrollTop` a test can move.
 *
 * The two plain fields are the ones the scrollbar's own setter does its
 * arithmetic on (`scrollSize` and `viewportSize` are both really members of
 * `ScrollBarRenderable`), and `scrollTo` transcribes that setter rather than
 * storing the number it was given, so a test that scrolls the viewer sees the
 * same clamping the host would apply.
 */
function attachScrollbox(element: any, scrollTop = 0, scrollSize = 200, viewportSize = 20) {
  const asked: number[] = []
  // A plain field rather than a getter, with the component holding the live
  // number. The viewer reads `box.scrollTop` to work out which heading the
  // reader is at, so it has to be readable *after* `scrollTo` has run and
  // clamped it -- a getter over a `const` would throw on the assignment
  // `ScrollBarRenderable`'s own setter does.
  const box = {
    scrollSize,
    viewportSize,
    scrollTop,
    asked,
    scrollTo(n: number) {
      asked.push(n)
      // ScrollBarRenderable.set scrollPosition, @opentui/core index.node.js
      // line 13855.
      this.scrollTop = Math.round(Math.min(Math.max(0, n), this.scrollSize - this.viewportSize))
    },
  }
  scrollboxIn(element).props.ref(box)
  return box
}

describe("a markdown file", () => {
  it("renders markdown files through a scrollbox and the block layout", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(WIDE_TERMINAL), { theme: mdTheme })
    const children = elements(contentColumnOf(element)?.props?.children)
    expect(children.some((child: any) => child.type === "scrollbox")).toBe(true)
    expect(contentViewOf(element)).toBeTruthy()
  })

  it("hands the layout the parsed blocks, and no syntaxStyle", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(WIDE_TERMINAL), { theme: mdTheme })
    const view = contentViewOf(element)

    /*
     * The blocks are parsed by `markdownParser` and the rows come from
     * `markdownLayout`, which is the whole reason the native `<markdown>` renderable
     * is gone: it laid its own blocks out and would not say where anything was.
     */
    expect(view.props.blocks.map((block: any) => block.type)).toEqual(["heading", "paragraph"])

    /*
     * The absence is the assertion, and it is the one that keeps the previous
     * attempt at this feature from coming back in a different shape.
     *
     * `SyntaxStyle` is a native handle keyed by tree-sitter scope names, consulted
     * only by the tree-sitter pipeline inside `MarkdownRenderable`. Nothing in this
     * layout tokenizes with tree-sitter -- blocks come from `marked` and fences
     * from Prism -- so a handle passed here would be a handle the component
     * silently ignores, and a caller who believed it was doing something would be
     * wrong about the colours for as long as the file was open.
     *
     * `MarkdownContentView.test.ts` holds a `@ts-expect-error` over the prop, which
     * catches the type. This catches the call site, which is the half the type
     * cannot see: a `syntaxStyle` spread in as an untyped extra would compile
     * either way.
     */
    expect("syntaxStyle" in view.props).toBe(false)
    expect(view.props.contentWidth).toBeGreaterThan(0)
  })

  it("leaves code files on the Prism path", () => {
    const path = makeFile("a.ts", "const a = 1\n")
    const element = mount(path, 5, createMockRenderer(WIDE_TERMINAL), { theme: mdTheme })
    const children = contentChildrenOf(element)
    expect(children.some((child: any) => child.type === MarkdownContentView)).toBe(false)
    expect(children.some((child: any) => child.type === "scrollbox")).toBe(false)
    expect(rowsOf(element)).toEqual(["1 │ const a = 1"])
  })

  it("shows the file name alone in the markdown header, with no line range", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(WIDE_TERMINAL), { theme: mdTheme })
    expect(headerOf(element)).toBe("readme.md")
  })

  it("still renders markdown when the theme carries nothing usable", () => {
    // Review Focus #2: a thin theme buys an uncoloured preview, never a return to
    // raw markdown source -- which is the complaint this feature exists to fix.
    //
    // The theme has nothing to do with that decision any more, and that is the
    // point: the layout's palette is fixed in `markdownLayout.ts`, so no theme at
    // all and a thin one both render, and neither can send the reader back to
    // raw markdown source. What is left to assert is that the block layout is
    // chosen by the file's extension alone.
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(WIDE_TERMINAL), { theme: {} })
    expect(contentViewOf(element)).toBeTruthy()
    // The Prism rows are gone with them: the only thing after the header is the
    // scrollbox, which renders no text of its own in the stub.
    expect(rowsOf(element)).toEqual([""])
  })

  it("still renders markdown when there is no theme at all", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(WIDE_TERMINAL), {})
    expect(contentViewOf(element)).toBeTruthy()
    // Same reasoning as the thin theme, one step further out: an absent theme
    // never reaches the layout at all, because the layout's colours are its own.
  })

  it("carries the truncation notice in the markdown header", () => {
    // A duplicated branch can drift. The text path pins its own notice, so the
    // markdown copy needs the same assertion or a change to one would leave the
    // other claiming something the reader can check.
    const path = makeFile("big.md", "x\n".repeat(MAX_VIEW_LINES + 1))
    const element = mount(path, 5, createMockRenderer(WIDE_TERMINAL), { theme: mdTheme })

    expect(headerOf(element)).toContain(`first ${MAX_VIEW_LINES} lines`)
  })

  it("bounds the markdown path to the rows the panel measured", () => {
    /*
     * The row budget, asserted on the one branch that used to read it for
     * nothing.
     *
     * `flexGrow={1}` only produces a bounded viewport if the host stretches the
     * claim's element out to the panel area, and nothing in this repo has ever
     * observed that it does. Left to its natural height the root box gives the
     * scrollbox no viewport, `scrollSize - viewportSize` is 0, and the
     * scrollbar's own setter clamps every keypress back to 0 -- markdown
     * scrolling is inert on every file while the panel still clips to its top
     * rows. The text path is immune because it slices rows to fit either way;
     * this one does not slice, which is the whole point of having it.
     *
     * The height arrives through a getter over a signal, exactly as
     * babel-preset-solid compiles `height={viewerHeight()}` in the plugin's JSX.
     * The re-mount below is what stands in for the reconciler re-reading that
     * JSX, and it is what separates a live read from a value snapshotted when
     * the body first ran.
     *
     * The bound is read off the content column rather than off the root. When
     * this test was written the markdown branch returned one box that carried
     * `height` itself; `19f6f38` put a centring `<box flexDirection="row">`
     * around the columns and moved the height down onto them, so the root has no
     * extent of its own and asserting on it would assert nothing. The content
     * column is the box the scrollbox lives in, and it is the one whose height
     * bounds the viewport. The sidebar carries the same height when there is one
     * -- pinned in "gives the sidebar the panel's full height" below.
     */
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const renderer = createMockRenderer()
    const [height, setHeight] = createSignal(12)
    const props: any = {
      path,
      context: makeContext(renderer, path),
      get height() {
        return height()
      },
    }

    const element = (FileViewer as any)(props)
    expect(contentColumnOf(element).props.height).toBe(12)
    // The other half of the bound. Either alone leaves the viewport
    // undetermined: a height with no grow gives a fixed box that may not fill
    // the panel, and a grow with no height gives a box with no measured extent.
    const scrollbox = scrollboxIn(element)
    expect(scrollbox?.props.flexGrow).toBe(1)

    setHeight(5)
    const resized = (FileViewer as any)(props)

    expect(contentColumnOf(resized).props.height).toBe(5)
    expect(scrollboxIn(resized)?.props.flexGrow).toBe(1)
  })

  it("keeps the header's row out of the scrollbox's shrink", () => {
    /*
     * The break: OpenTUI renderables default to `flexShrink: 1`, and a
     * fixed-height column whose children's flex bases overflow it shrinks both
     * children in proportion to those bases. The scrollbox's basis is `auto` --
     * its content height -- so any document taller than the panel overflows the
     * column, the scrollbox's basis dominates the shrink, and it fills the box
     * from y=0 over the header's row: the live symptom is the filename and the
     * first line of the file sharing a row, and the overlap changing as you
     * scroll.
     *
     * Measured, not theorised: `scripts/probe-markdown-layout.ts` runs this
     * exact tree through the real renderer and captured `linem1.md` as row 0
     * before the fix and a clean `readme.md` / `line 1` pair after it. The unit
     * suite cannot see geometry -- OpenTUI is stubbed here -- so what it pins is
     * the pair of props that carries the bound, and the probe is what pins the
     * bound's effect. Short files fit either way, which is why this reads as a
     * bug in long files only.
     */
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(), { theme: mdTheme })
    const children = contentChildrenOf(element)

    const header = children.find((child: any) => child.type === "text")
    const scrollbox = children.find((child: any) => child.type === "scrollbox")
    // The header's row is not negotiable...
    expect(header?.props.flexShrink).toBe(0)
    // ...and the scrollbox's size comes from the container, never its content.
    expect(scrollbox?.props.flexBasis).toBe(0)
  })
})

/*
 * The writer handed out on mount, and the split the markdown branch puts in it.
 *
 * The plugin holds this writer for the whole time the viewer is open, so it is
 * the only channel the arrow keys have. Which writer it gets is therefore the
 * whole of the markdown path's scrolling: hand the keymap the signal writer on
 * a `.md` file and every press moves a number nothing reads.
 */
describe("the writer handed to the keymap", () => {
  /*
   * A stand-in for the ScrollBoxRenderable, handed over the way the reconciler
   * hands a ref.
   *
   * It exposes only what the real renderable has, and that restriction is the
   * whole point. The first version of this fake also carried a `maxScrollTop`
   * property, the adapter clamped against it, and every test passed -- while the
   * real `maxScrollTop` is a local `const` inside five of the host's methods and
   * `this.maxScrollTop` appears nowhere, so the clamp was `Math.min(next,
   * undefined)` and `scrollTo(NaN)` blanked the panel. A stub that invents the
   * member the code is wrong about cannot catch the code being wrong about it.
   *
   * So: `scrollTop` and `scrollTo` only, plus the two plain fields the scrollbar's
   * own setter does its arithmetic on -- `scrollSize` and `viewportSize` both
   * really are members of `ScrollBarRenderable` -- and `scrollTo` transcribes
   * that setter rather than storing the number it was given. The clamp under test
   * is therefore the host's arithmetic, not a number this file asserts.
   */
  function fakeScrollBox(scrollTop: number, scrollSize: number, viewportSize: number, asked: number[]) {
    return {
      scrollTop,
      scrollSize,
      viewportSize,
      scrollTo(n: number) {
        asked.push(n)
        // ScrollBarRenderable.set scrollPosition, @opentui/core index.node.js
        // line 13855.
        this.scrollTop = Math.round(Math.min(Math.max(0, n), this.scrollSize - this.viewportSize))
      },
    }
  }

  /**
   * The scrollbox element.
   *
   * Delegates to the file-level `scrollboxIn`, which walks the content column
   * rather than the root. This local name is kept because the two tests below
   * read better against it, but there is one implementation: a second traversal
   * here would be a second thing that can disagree with the markup.
   */
  function scrollboxOf(element: any): any {
    return scrollboxIn(element)
  }

  it("hands the markdown path a writer that drives the scrollbox", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const renderer = createMockRenderer()
    let writer: any
    const element = mount(path, 5, renderer, {
      theme: mdTheme,
      scrollTo: (fn: any) => (writer = fn),
    })

    // Forty rows of content in a ten-row viewport, so there is plenty of room and
    // the clamp is not what decides this answer.
    const asked: number[] = []
    const box = fakeScrollBox(7, 40, 10, asked)
    scrollboxOf(element).props.ref(box)
    const framesBefore = renderer.frames()

    // The plugin always calls with an updater over the previous position, which is
    // what scrollByLine produces.
    writer((prev: number) => prev + 1)

    expect(asked).toEqual([8])
    expect(box.scrollTop).toBe(8)
    expect(renderer.frames()).toBeGreaterThan(framesBefore)
  })

  it("passes the markdown scroll through and lets the scrollbox clamp it", () => {
    /*
     * The clamp is not the adapter's, and this is the test that says so.
     *
     * The box is already at the bottom -- thirty rows of content in a ten-row
     * viewport, so twenty is as far as it can go -- and one more `down` asks for
     * twenty-one. Both halves matter: the adapter must hand the box the value it
     * was asked for rather than a bound it invented, and the box must be what puts
     * it back in range. Re-introduce an adapter-side clamp against a property the
     * renderable does not have and the recorded value is NaN here.
     */
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    let writer: any
    const element = mount(path, 5, createMockRenderer(), {
      theme: mdTheme,
      scrollTo: (fn: any) => (writer = fn),
    })
    const asked: number[] = []
    const box = fakeScrollBox(20, 30, 10, asked)
    scrollboxOf(element).props.ref(box)

    writer((prev: number) => prev + 1)

    // Asked for 21 -- unclamped, because the adapter does not clamp -- and left
    // at 20, which is the clamp that actually runs.
    expect(asked).toEqual([21])
    expect(box.scrollTop).toBe(20)
  })

  it("still hands the text path its own offset signal", () => {
    // The markdown branch must not steal the Prism path's writer. The offset is not
    // readable back out of the stub's static description, so this asserts the
    // writer really is the component's signal by watching it ask for a frame --
    // which is the only observable effect the component's own scroll has.
    const path = makeFile("a.ts", "const a = 1\nconst b = 2\n")
    const renderer = createMockRenderer()
    let writer: any
    mount(path, 5, renderer, { scrollTo: (fn: any) => (writer = fn) })
    const before = renderer.frames()

    writer((prev: number) => prev + 1)

    expect(renderer.frames()).toBeGreaterThan(before)
  })
})

/*
 * The table of contents.
 *
 * Everything here is about a feature that was reverted once. The first attempt
 * computed its own row numbers and disagreed with the screen on every block
 * whose height depends on a detail -- a blank separator, a table's rule row, a
 * nested quote -- so the highlight named the wrong section and a jump landed on
 * the wrong row. What replaces it reads its rows from the one layout that draws
 * the document, and most of the assertions below are about that being true.
 */

describe("the table of contents beside a markdown file", () => {
  it("lists every heading, indented two columns per level", () => {
    const path = makeFile("readme.md", "# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 20)

    // The label is the first row; the headings follow it.
    expect(tocRowsOf(element)).toEqual(["Contents", "One", "  Two", "    Three"])
  })

  it("puts the headings in document order, not in block order", () => {
    // A heading with no text is a heading block and no TOC entry, so numbering
    // the sidebar off the blocks would put every row after it one out. `##` below
    // is empty and must not appear at all.
    const path = makeFile("readme.md", "# One\n\ntext\n\n##\n\n## Two\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 20)

    expect(tocRowsOf(element)).toEqual(["Contents", "One", "  Two"])
  })

  it("takes its rows from the layout's own positions, not from the blocks", () => {
    /*
     * The single most important assertion in this file.
     *
     * The positions are what the layout produced for the width the rows were
     * drawn at, and they are handed over by `MarkdownContentView` rather than
     * recomputed here. If this ever reads as `[[0, 0], [1, 2]]` -- the
     * paragraph-then-heading shape a block index would give -- the viewer has
     * started calculating row numbers of its own, and that is the exact defect
     * that got this feature reverted the first time.
     */
    const path = makeFile("readme.md", "# One\n\ntext\n\n## Two\n\ntext\n")
    const { element, headings } = mountCapturingHeadings(path, 20)

    renderContentView(element)

    // Row 0 is the first heading, row 1 the blank separator, row 2 the paragraph,
    // row 3 the separator, row 4 the second heading.
    expect([...(headings().positions().entries())]).toEqual([
      [0, 0],
      [1, 4],
    ])
  })

  it("highlights the heading the reader is at, and no other", () => {
    /*
     * Pinned as a limitation, because it is one and because it is the reason the
     * two halves are asserted apart rather than together.
     *
     * The stub builds `props.children` once, at mount, and the layout has not
     * handed any positions over at that point -- `onHeadingPositions` fires from
     * `MarkdownContentView`'s own effect, which a test has to invoke by hand. So
     * the sidebar as described by the stub carries the state the component had
     * before the document was laid out, where the active heading is `-1` and
     * nothing is marked. Re-running the component rebuilds the children with the
     * positions present, which is what the host's reconciler does and the stub
     * cannot.
     *
     * What is asserted here is that nothing is highlighted off `-1`. The other
     * half -- that a heading which IS active comes back marked -- is
     * `tocEntryStyle`'s test below, and the wiring between them is the
     * `activeHeading` assertions in "the heading state handed to the keymap".
     */
    const path = makeFile("readme.md", "# One\n\ntext\n\n## Two\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 20)

    const marked = elements(tocOf(element)?.props?.children)
      .map((_, row) => tocRowStyle(element, row))
      .filter((style) => style?.reverse === true)

    expect(marked).toHaveLength(0)
  })

  it("marks no heading at all when the layout has handed over nothing yet", () => {
    // `-1` is what `findActiveHeading` returns for a document with no headings,
    // and it is not a key into the positions map. Nothing may be highlighted off
    // it, and nothing may be looked up with it.
    const path = makeFile("readme.md", "# One\n\ntext\n\n## Two\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 20)

    // Deliberately NOT running the content view, so the positions stay empty.
    for (let row = 1; row < tocRowsOf(element).length; row++) {
      expect(tocRowStyle(element, row)).toEqual({ fg: "dim" })
    }
  })

  it("gives no sidebar to a document with no headings", () => {
    const path = makeFile("readme.md", "just a paragraph\n\nand another\n")
    const { element } = mountCapturingHeadings(path, 20)

    // One box: the content column. A frame saying nothing beside the document
    // is 30 columns spent on nothing.
    expect(elements(element?.props?.children).filter((child: any) => child.type === "box")).toHaveLength(1)
  })

  it("scrolls the window to keep the active heading in view", () => {
    // Nine headings in a four-row window: the sidebar cannot show them all, and
    // the active one has to be inside whatever it shows.
    const source = Array.from({ length: 9 }, (_, i) => `# H${i + 1}\n\ntext ${i}\n`).join("\n")
    const path = makeFile("long.md", source)
    const { element, headings } = mountCapturingHeadings(path, 5)
    renderContentView(element)

    const box = attachScrollbox(element, 0, 400, 20)

    // At the top, the window starts at the first heading and shows the first four.
    expect(tocRowsOf(element).slice(1)).toEqual(["H1", "H2", "H3", "H4"])
    expect(headings().active()).toBe(0)

    /*
     * Scroll to the last heading and check two things.
     *
     * The active index follows the box, which is the part that is observable
     * here: the sidebar asks `findActiveHeading` against the offset the renderable
     * really reports rather than against the number that was asked for, so this
     * holds even when the two differ. The window that follows is asserted through
     * `tocWindowStart` directly, because the stub cannot rebuild `props.children`
     * after a scroll -- see `MarkdownContentView.test.ts` for the same limit stated
     * in full.
     */
    const lastRow = headings().positions().get(8)!
    box.scrollTo(lastRow)

    expect(box.scrollTop).toBe(lastRow)
    expect(headings().active()).toBe(8)
    // Window of four, active at 8: it ends on the active heading, at 5.
    expect(tocWindowStart(headings().active(), 9, 4)).toBe(5)
  })

  it("widens for a long heading and stops at forty columns", () => {
    const short = makeFile("a.md", "# Title\n\ntext\n")
    const long = makeFile("b.md", `# ${"x".repeat(36)}\n\ntext\n`)
    const capped = makeFile("c.md", `# ${"x".repeat(90)}\n\ntext\n`)

    expect(tocOf(mountCapturingHeadings(short, 20).element).props.width).toBe(30)
    // 36 columns of heading is under the 40 ceiling, so the sidebar grows to it.
    expect(tocOf(mountCapturingHeadings(long, 20).element).props.width).toBe(36)
    // A heading longer than the ceiling is truncated, not given its own width.
    expect(tocOf(mountCapturingHeadings(capped, 20).element).props.width).toBe(40)
  })

  it("reads the offset off the renderable rather than from its own copy", () => {
    /*
     * The getter's correctness, which is the half that was always true.
     *
     * A mouse wheel over the scrollbox moves it without the adapter running. The
     * question a keypress asks -- "where is the reader?" -- is therefore asked
     * against a number this component never wrote, and the only way to answer it
     * correctly is to read the renderable at the moment the question is asked.
     * A design that kept its own copy of the offset would answer with the position
     * from before the wheel.
     *
     * This is *not* the same as the sidebar following the wheel, and the frame
     * test below is that. This one only says the number is the right number.
     *
     * The box's two sides are plain fields precisely so a test can move it the way
     * the host would. A getter over a `let` throws on the assignment the
     * scrollbar's own setter does, which is what it did while this was written.
     */
    const path = makeFile("readme.md", "# One\n\na\n\n## Two\n\nb\n\n### Three\n\nc\n")
    const { element, headings } = mountCapturingHeadings(path, 20)
    renderContentView(element)
    const box = attachScrollbox(element, 0, 400, 20)

    expect(headings().active()).toBe(0)
    box.scrollTop = 8
    expect(headings().active()).toBe(2)
  })

  it("reads the offset live, so a wheel scroll is answered without a repaint", () => {
    /*
     * What this actually verifies: `active()` reads the *renderable*, not a
     * number this component kept.
     *
     * The box is moved the way a wheel moves it -- `ScrollBoxRenderable.onMouseEvent`
     * accumulates a delta and assigns `this.scrollTop`, running nothing here -- and
     * `active()` answers from that new position with no adapter call, no signal
     * write and no frame in between. A design that mirrored the offset into a
     * signal would still be answering from before the wheel. That is the property,
     * and it is what Task 5's keypresses depend on.
     *
     * What this does NOT verify, and an earlier revision of this test claimed it
     * did: that the *sidebar* follows the wheel. It cannot, and the reason is the
     * stub. `props.children` is built once, at mount -- before the layout has
     * handed over any positions, when `activeHeading()` is `-1` -- so no sidebar
     * row is ever `reverse` in the described tree at any scroll position. The
     * `active()` assertion below reads through `markdownOffset()` straight to
     * `box.scrollTop`, so it passes whether or not the frame listener exists.
     * Replace the listener's body with a no-op and this test still goes green,
     * which is exactly why it is retitled rather than left claiming otherwise.
     *
     * The listener's own behaviour is pinned by the two tests below, which were
     * checked by mutation: replace the listener body with a no-op and they fail.
     */
    const path = makeFile("readme.md", "# One\n\na\n\n## Two\n\nb\n\n### Three\n\nc\n")
    const renderer = createMockRenderer(WIDE_TERMINAL)
    const { element, headings } = mountCapturingHeadings(path, 20, { renderer })
    renderContentView(element)
    const box = attachScrollbox(element, 0, 400, 20)

    expect(headings().active()).toBe(0)

    // A wheel, not a keypress: the box moves and nothing in the plugin runs.
    box.scrollTop = 8

    // Asked again with no repaint in between, the answer is the new one. The rows
    // `## Two` and `### Three` sit at 4 and 8 in this layout, so 8 is heading 2.
    expect(headings().active()).toBe(2)

    // And back again, because the same getter has to work in both directions --
    // a value cached on the way up only is still a stale value.
    box.scrollTop = 0
    expect(headings().active()).toBe(0)
  })

  it("registers a frame listener, and it is the markdown path that registers it", () => {
    /*
     * The registration itself, which is the part the test above cannot see.
     *
     * The frame listener is what makes the *sidebar* follow a wheel: a document
     * that scrolled has to be painted, and `CliRenderEvents.FRAME` fires after
     * every frame that renders, so the listener is the only thing the plugin
     * controls that a wheel scroll moves. The scrollbox has no scroll event of
     * its own to subscribe to -- see the note in `FileViewer.tsx` for what the
     * host source actually shows, which is not what an earlier version of it
     * claimed.
     *
     * So: a markdown viewer registers one, a code file registers none, and
     * that asymmetry is the observable. Verified by mutation -- delete the
     * `renderer.on?.("frame", resync)` line and this fails.
     */
    const markdown = makeFile("readme.md", "# One\n\ntext\n")
    const code = makeFile("a.ts", "const a = 1\n")

    const withSidebar = createMockRenderer(WIDE_TERMINAL)
    mountCapturingHeadings(markdown, 20, { renderer: withSidebar })

    const withoutSidebar = createMockRenderer(WIDE_TERMINAL)
    mountCapturingHeadings(code, 20, { renderer: withoutSidebar })

    expect(withSidebar.frameListeners()).toBeGreaterThan(0)
    expect(withoutSidebar.frameListeners()).toBe(0)
  })

  it("does not write the offset on every frame of an unmoved scrollbox", () => {
    /*
     * A frame arrives sixty times a second and most of them change nothing.
     *
     * Writing the signal unconditionally would re-run the repaint effect sixty
     * times a second for a sidebar that has not moved -- the kind of cost that
     * shows up as a plugin making the whole host feel slower, which is worse than
     * the feature it buys. The listener compares before it writes.
     */
    const path = makeFile("readme.md", "# One\n\na\n\n## Two\n\nb\n\n### Three\n\nc\n")
    const renderer = createMockRenderer(WIDE_TERMINAL)
    const { element } = mountCapturingHeadings(path, 20, { renderer })
    renderContentView(element)
    attachScrollbox(element, 0, 400, 20)

    for (let i = 0; i < 10; i++) renderer.fireFrame()
    const after = renderer.frames()

    for (let i = 0; i < 10; i++) renderer.fireFrame()

    // Ten more frames, and not one of them asked for another frame. The count
    // before them is the mount's, which is what makes this a real measurement
    // rather than a comparison of two identical snapshots.
    expect(renderer.frames()).toBe(after)
  })

  it("does not listen for frames on the code path", () => {
    /*
     * Half of the registration asymmetry, and the half that costs something.
     *
     * The Prism path has no sidebar, no scrollbox and no heading state, so a
     * per-frame listener there would be the plugin's cost for nothing -- read and
     * compare, sixty times a second, forever, to learn nothing.
     *
     * Overlaps with the positive half asserted in "registers a frame listener,
     * and it is the markdown path that registers it" above. Kept as its own test
     * because it is the one that would be deleted first if this ever grew a
     * second frame listener, and because deleting it would leave the *absence*
     * unpinned -- a test that only ever checks a thing exists passes just as
     * happily when it has quietly started existing everywhere.
     */
    const path = makeFile("a.ts", "const a = 1\n")
    const renderer = createMockRenderer(WIDE_TERMINAL)
    mount(path, 5, renderer)

    expect(renderer.frameListeners()).toBe(0)
  })

  it("gives an empty markdown file no sidebar and no active heading", () => {
    // A zero-byte `.md` has no blocks, so no headings, so no sidebar -- and an
    // active heading of `-1`. The empty positions map is also what a real
    // document with no headings produces, so this is the same answer for the same
    // reason rather than a special case.
    const path = makeFile("empty.md", "")
    const { element, headings } = mountCapturingHeadings(path, 20)

    expect(elements(element?.props?.children).filter((child: any) => child.type === "box")).toHaveLength(1)
    expect(headings().active()).toBe(-1)
  })

  it("stays drawable in a panel with no rows", () => {
    // `props.height` is zero before the panel has measured itself. The sidebar
    // still draws its label and at least one heading, because a window of zero
    // rows is a sidebar with nothing in it and `tocWindowStart` floors at one
    // rather than starting the window below the heading it was asked to show.
    const path = makeFile("readme.md", "# One\n\n## Two\n\n### Three\n")
    const { element } = mountCapturingHeadings(path, 0)

    expect(tocRowsOf(element)).toEqual(["Contents", "One"])
  })

  it("takes the columns it uses out of the content column", () => {
    const path = makeFile("readme.md", "# One\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 20, { renderer: createMockRenderer(120) })

    const sidebar = tocOf(element).props.width
    const content = contentColumnOf(element).props.width

    // The two columns have to add up to the terminal. A content box that still
    // claimed the full width would push the sidebar off the right edge.
    expect(content + sidebar).toBe(120)
    // And the layout is handed the content column's own width, so the rows are
    // wrapped for the space they are drawn in rather than for a number nobody
    // measured.
    expect(contentViewOf(element).props.contentWidth).toBe(content)
  })

  it("states both columns' widths rather than letting them be negotiated", () => {
    /*
     * The two `flexShrink={0}`s.
     *
     * OpenTUI renderables default to `flexShrink: 1`, and the header/scrollbox
     * pair above carries the same lesson already: a shrink took columns out of
     * the content and put the layout's row numbers out of step with the screen.
     * The failure here is the same one by another route -- a sidebar one column
     * narrower than the content column expects means the document is wrapped for
     * `contentWidth()` and drawn in fewer columns, and every heading row the
     * positions map recorded is then a row the reader does not see it on.
     *
     * `showToc` is the primary guard and refuses to draw a sidebar that does not
     * fit at all. These two say the same thing from the layout side, for the case
     * where the box's own width and the terminal's disagree about whether it fits.
     */
    const path = makeFile("readme.md", "# One\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 20)

    expect(contentColumnOf(element).props.flexShrink).toBe(0)
    expect(tocOf(element).props.flexShrink).toBe(0)
  })

  it("spends the panel's rows on the sidebar, label included", () => {
    // The sidebar's label row and its heading rows have to fit inside the height
    // the panel measured, or the sidebar either draws past the bottom of the
    // panel or wastes a row. One row is the label; the rest are headings.
    const path = makeFile("readme.md", "# One\n\n## Two\n\n### Three\n\n#### Four\n")
    const { element } = mountCapturingHeadings(path, 3)

    // Height 3: the label, and two headings. The fourth is outside the window.
    expect(tocRowsOf(element)).toEqual(["Contents", "One", "  Two"])
  })

  it("gives the sidebar the panel's full height", () => {
    // Its own height, matching the content column's. A sidebar shorter than the
    // content next to it reads as a panel that ran out of room.
    const path = makeFile("readme.md", "# One\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 17)

    expect(tocOf(element).props.height).toBe(17)
    expect(contentColumnOf(element).props.height).toBe(17)
  })

  it("gives every heading a row that says its name, in document order", () => {
    /*
     * The join between the layout's heading list and the sidebar's rows, as far
     * as this stub can see it.
     *
     * What is pinned: each heading's *text* lands on the row at its index. The
     * row is found by its text and then compared against the index, so the
     * sidebar drawing its headings in the wrong order, skipping one, or repeating
     * one all fail here. That is a real gap -- two lists joined only by their
     * shared order -- and it is closed.
     *
     * What is NOT pinned, and an earlier version of this comment claimed it was:
     * that the row carries the *index* the sidebar's highlight is computed from.
     * `renderTocRow(heading, start + offset)` is what turns a window position
     * back into a heading index, and changing it to `start + offset + 1` passes
     * this test -- and the one below -- because both locate rows by text. Under
     * this stub the row-to-index join is unobservable: the sidebar's rows are
     * frozen at mount, before any positions exist, so `activeHeading()` is `-1`
     * and no row is ever `reverse`.
     *
     * That is not a gap a better test closes here; it is the stub having no
     * reconciler. Task 6's manual testing against a live host is the only thing
     * that can confirm a jump lands on the heading it names.
     */
    const source = "# Alpha\n\ntext\n\n## Beta\n\ntext\n\n### Gamma\n\ntext\n"
    const path = makeFile("readme.md", source)
    const { element, headings } = mountCapturingHeadings(path, 20)
    renderContentView(element)

    // Row 0 of the sidebar is the label, so the headings start at row 1. Sourced
    // from the document rather than written out, so a change to the fixture cannot
    // silently make the expectations describe a different document.
    const expected = source.match(/^#+ (.+)$/gm)!.map((line) => line.replace(/^#+ /, ""))

    for (let index = 0; index < expected.length; index++) {
      // The row a reader would say names this heading: the one whose text is this
      // heading's text. Trimmed because the drawn row is the indent plus the text,
      // and the indent is a function of the level rather than part of the name.
      const row = tocRowsOf(element).findIndex((text) => text.trim() === expected[index])
      // Not `index + 1` as a lookup: the row the text was *found* at has to be the
      // row the index says, and a shift in either direction fails here.
      expect(row).toBe(index + 1)
      // And the layout really does have an entry for that index, so the two lists
      // are the same length -- the failure where they are not is a sidebar showing
      // a heading the layout has no row for.
      expect(headings().positions().has(index)).toBe(true)
    }

    // The window is what makes rows and indices line up at all: it slices
    // `headings` by position and re-adds the offset to every index, so a window
    // that started one heading late would renumber every row below it.
    expect(tocWindowStart(0, 3, 10)).toBe(0)
  })

  it("marks at most one row, whichever heading is active", () => {
    /*
     * The highlight side of the same join, stated as the limit rather than as the
     * mechanism.
     *
     * `active()` is an index into the layout's numbering and the sidebar marks a
     * row. An earlier version of this claimed to pin "the assertion that the
     * offset is added rather than assumed away"; it did not, and neither does
     * this. Under the stub no row is ever `reverse` -- the sidebar was drawn
     * before any positions existed -- so what is left to say is the thing that
     * must hold in that frozen state and in every other: one active index marks
     * one row and never two, because `renderTocRow` compares its own index
     * against `activeHeading()` and two rows claiming equality would mean two rows
     * were handed the same index.
     *
     * The window arithmetic that would shift that index is pinned separately in
     * `tocWindowStart`'s own tests, which are pure and can be.
     */
    const source = Array.from({ length: 9 }, (_, i) => `# H${i}\n\ntext ${i}\n`).join("\n")
    const path = makeFile("long.md", source)
    const { element, headings } = mountCapturingHeadings(path, 5)
    renderContentView(element)
    const box = attachScrollbox(element, 0, 400, 20)

    // Height 5: the label and four heading rows, which is the window as drawn.
    expect(tocRowsOf(element)).toEqual(["Contents", "H0", "H1", "H2", "H3"])

    const entries = () => elements(tocOf(element)?.props?.children).slice(1)
    const markedRows = () =>
      entries().filter((entry: any) =>
        elements(entry?.props?.children).some((span: any) => span?.props?.style?.reverse === true),
      ).length

    // Whichever heading the reader is at -- including each in turn -- no two rows
    // are ever marked, and the sidebar keeps naming the headings it drew.
    for (const index of [0, 1, 2, 3]) {
      box.scrollTo(headings().positions().get(index)!)
      expect(headings().active()).toBe(index)
      expect(markedRows()).toBeLessThanOrEqual(1)
    }

    // And the rows still say what they said, so nothing above disturbed them.
    expect(tocRowsOf(element)).toEqual(["Contents", "H0", "H1", "H2", "H3"])
  })
})

describe("a terminal too narrow for a table of contents", () => {
  it("drops the sidebar rather than squeezing the content", () => {
    const path = makeFile("readme.md", "# One\n\ntext\n")
    // Thirty columns of sidebar plus thirty of content is sixty; forty leaves
    // ten for the document, which is below the floor.
    const { element } = mountCapturingHeadings(path, 20, { renderer: createMockRenderer(40) })

    expect(elements(element?.props?.children).filter((child: any) => child.type === "box")).toHaveLength(1)
    // The content gets the whole terminal, not the terminal minus a sidebar that
    // is no longer being drawn.
    expect(contentColumnOf(element).props.width).toBe(40)
  })

  it("draws no sidebar at all when the terminal width was never measured", () => {
    // The renderer reports no width. Guessing would mean picking a width nothing
    // measured and drawing a sidebar that may not fit, which pushes content off
    // the screen; the content alone is always safe.
    const path = makeFile("readme.md", "# One\n\ntext\n")
    const { element } = mountCapturingHeadings(path, 20, { renderer: createMockRenderer(0) })

    expect(elements(element?.props?.children).filter((child: any) => child.type === "box")).toHaveLength(1)
  })

  it("keeps a sidebar in a terminal that fits both", () => {
    // The boundary case, one column either side of the floor.
    const roomy = makeFile("a.md", "# One\n\ntext\n")
    const tight = makeFile("b.md", "# Two\n\ntext\n")

    expect(elements(mountCapturingHeadings(roomy, 20, { renderer: createMockRenderer(60) }).element?.props?.children).filter((c: any) => c.type === "box")).toHaveLength(2)
    expect(elements(mountCapturingHeadings(tight, 20, { renderer: createMockRenderer(59) }).element?.props?.children).filter((c: any) => c.type === "box")).toHaveLength(1)
  })

  it("drops the sidebar when the reader's own width setting is the smaller one", () => {
    /*
     * I1: `MIN_CONTENT_WIDTH` was bypassable through `filetree.set-width`.
     *
     * The check used to compare the sidebar's room against the *terminal*, which
     * is right only while `maxWidth` is never the smaller of the two. It is a
     * persisted user setting, so it very much can be: a reader who has asked for
     * 50 columns of markdown on a 200-column terminal has plenty of screen and a
     * content column of twenty, which is exactly what the floor exists to prevent.
     * The terminal has all the room in the world and the document has none.
     *
     * Every narrow-terminal test in this file passed while this was true, because
     * all of them used the default `maxWidth` -- the one configuration where the
     * two numbers agree.
     */
    const path = makeFile("readme.md", "# One\n\ntext\n")
    const at = (terminal: number, maxWidth: number) =>
      mountCapturingHeadings(path, 20, {
        maxWidth,
        renderer: createMockRenderer(terminal),
      })

    // Terminal is roomy; the reader's setting is not. No sidebar.
    expect(at(200, 50).element && elements(at(200, 50).element.props.children).filter((c: any) => c.type === "box")).toHaveLength(1)
    expect(elements(at(200, 40).element.props.children).filter((c: any) => c.type === "box")).toHaveLength(1)
    // Terminal barely roomy, setting smaller still.
    expect(elements(at(80, 30).element.props.children).filter((c: any) => c.type === "box")).toHaveLength(1)
    // And with no sidebar the content gets the reader's setting, not the terminal.
    expect(contentColumnOf(at(200, 50).element).props.width).toBe(50)
  })

  it("keeps a sidebar when the reader's setting leaves room for one", () => {
    // The other side of I1's boundary, so the fix is not "always hide on a set
    // width". Sixty columns of preference is thirty of content beside a thirty-column
    // sidebar, which is the floor exactly.
    const path = makeFile("readme.md", "# One\n\ntext\n")
    const at = (maxWidth: number) =>
      mountCapturingHeadings(path, 20, { maxWidth, renderer: createMockRenderer(200) })

    expect(elements(at(60).element.props.children).filter((c: any) => c.type === "box")).toHaveLength(2)
    expect(contentColumnOf(at(60).element).props.width).toBe(30)
    // One column under and it is gone.
    expect(elements(at(59).element.props.children).filter((c: any) => c.type === "box")).toHaveLength(1)
    expect(contentColumnOf(at(59).element).props.width).toBe(59)
  })
})

describe("a terminal that changes width", () => {
  it("re-lays the document and moves the sidebar with it", () => {
    /*
     * The resize, end to end.
     *
     * Three things have to happen in order and none of them can be skipped: the
     * width the layout is given changes, the layout recomputes and hands over
     * different positions, and the sidebar is rebuilt against the new width. A
     * resize that moved the columns but left the positions describing the old
     * layout would put every highlight one wrap out of place -- the reader
     * scrolls to a section and the sidebar lights up a different one.
     *
     * The remount below is what stands in for the reconciler re-reading the JSX,
     * which is the same trick `bounds the markdown path to the rows the panel
     * measured` uses for `height`. The stub builds `props.children` once, so a
     * signal change cannot reach the tree that is already built, and re-running
     * the component is the closest a test gets to the real thing.
     */
    const source = "# One\n\naaa bbb ccc ddd eee fff ggg hhh iii jjj\n\n## Two\n\nmore text\n"
    const path = makeFile("readme.md", source)

    const at = (terminalWidth: number) => {
      const renderer = createMockRenderer(0)
      Object.defineProperty(renderer, "width", { get: () => terminalWidth, configurable: true })
      let headingState: any
      const element = (FileViewer as any)({
        path,
        get height() {
          return 20
        },
        get maxWidth() {
          return 150
        },
        context: { renderer },
        onHeadings: (s: any) => {
          headingState = s
        },
      })
      renderContentView(element)
      return { element, headings: () => headingState, renderer }
    }

    const wide = at(120)
    const widePositions = [...wide.headings().positions().entries()]
    // The paragraph between the headings wraps onto one row at this width, so the
    // second heading sits at 4.
    expect(widePositions).toEqual([
      [0, 0],
      [1, 4],
    ])

    const narrow = at(40)
    const narrowPositions = [...narrow.headings().positions().entries()]

    // The narrow terminal cannot fit content plus a 30-column sidebar, so the
    // sidebar is gone and the content has the whole thing.
    expect(narrowPositions).toEqual(widePositions)
    expect(tocOf(narrow.element)).toBeUndefined()
    expect(contentColumnOf(narrow.element).props.width).toBe(40)
    expect(contentViewOf(narrow.element).props.contentWidth).toBe(40)

    /*
     * A frame was asked for on the way. The renderer is demand-driven and a
     * resize changes nothing Solid repaints on its own, so this is the assertion
     * that the panel does not sit there showing the old width's document -- the
     * stale-panel shape this repo has paid for four times.
     */
    expect(narrow.renderer.frames()).toBeGreaterThan(0)
  })

  it("re-wraps the document when the terminal narrows but a sidebar still fits", () => {
    /*
     * The same resize with a document long enough that the wrap actually moves a
     * heading. This is the case the feature exists for: at the wide width the
     * paragraph between the headings is one row and `## Two` lands on row 4; at
     * the narrow width it is three rows and `## Two` lands on row 6. A positions
     * map that did not move would send a jump to the wrong row -- which is
     * precisely the defect that got the first attempt at this feature reverted.
     */
    const source = "# One\n\naaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp qqq rrr sss\n\n## Two\n\nmore text\n"
    const path = makeFile("readme.md", source)

    const at = (terminalWidth: number) => {
      const renderer = createMockRenderer(0)
      Object.defineProperty(renderer, "width", { get: () => terminalWidth, configurable: true })
      let headingState: any
      const element = (FileViewer as any)({
        path,
        get height() {
          return 20
        },
        get maxWidth() {
          return 150
        },
        context: { renderer },
        onHeadings: (s: any) => {
          headingState = s
        },
      })
      renderContentView(element)
      return { element, positions: () => headingState.positions() }
    }

    // 120 and 61: both leave at least the 30-column content floor after a
    // 30-column sidebar, so both have a sidebar and both are different widths.
    const wide = at(120)
    const narrow = at(61)
    expect(tocOf(narrow.element)).toBeTruthy()
    expect(contentViewOf(narrow.element).props.contentWidth).toBeLessThan(
      contentViewOf(wide.element).props.contentWidth,
    )
    // And the positions moved with it: the paragraph between the headings wraps
    // onto more rows at the narrower width, so `## Two` starts lower.
    expect(narrow.positions().get(1)).toBeGreaterThan(wide.positions().get(1)!)
  })
})

describe("the heading state handed to the keymap", () => {
  it("hands over the positions and the active heading on a markdown file", () => {
    const path = makeFile("readme.md", "# One\n\ntext\n\n## Two\n\ntext\n")
    const { element, headings } = mountCapturingHeadings(path, 20)
    renderContentView(element)

    expect(typeof headings().positions).toBe("function")
    expect(typeof headings().active).toBe("function")
    expect([...(headings().positions().entries())]).toEqual([
      [0, 0],
      [1, 4],
    ])
  })

  it("hands over getters, so a reader always sees the current layout", () => {
    /*
     * Not values, and this is the difference between a working keymap and a
     * broken one after the first resize.
     *
     * The positions are replaced whenever the layout recomputes. A map captured
     * at mount describes the layout the panel opened with, so a jump to "the
     * next heading" after a resize would scroll to a row from the width the
     * reader no longer has. The value here is read twice, with a layout in
     * between, and the second reading is the one that moved.
     *
     * The paragraph is long enough that narrowing the content column really does
     * push the second heading down. A document whose headings never move would
     * let a stale map through this test untouched, which is the whole failure.
     */
    const path = makeFile("readme.md", "# One\n\naaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll\n\n## Two\n\ntext\n")
    const { element, headings } = mountCapturingHeadings(path, 20)
    const view = renderContentView(element)
    const first = headings().positions()

    // Re-lay at a much narrower width, which is what a resize does.
    Object.defineProperty(view.props, "contentWidth", { get: () => 10, configurable: true })
    view.type(view.props)
    const second = headings().positions()

    // A fresh map every time -- `layoutBlocks` allocates one per call -- so a
    // caller holding the old one is not mutated under it.
    expect(second).not.toBe(first)
    // And the row numbers really are different, so a snapshot would have been
    // describing the wrong document.
    expect(second.get(1)).toBeGreaterThan(first.get(1)!)
  })

  it("reports -1 as the active heading when the document has none", () => {
    /*
     * The `-1` is a real answer, and it is the one a keymap has to be able to
     * carry without treating it as an index. `findActiveHeading` hands it back
     * for an empty map and the viewer passes it through unchanged rather than
     * resolving it to a heading or to zero -- resolving it to zero would send
     * `alt+up` from the top of a headingless document to its first line.
     */
    const path = makeFile("readme.md", "just prose\n\nand more prose\n")
    const { headings } = mountCapturingHeadings(path, 20)

    expect(headings().active()).toBe(-1)
    expect(headings().positions().size).toBe(0)
  })

  it("hands over nothing at all for a code file", () => {
    // A code file has no headings, and a keymap that found an `onHeadings` here
    // would bind alt+up/down to a document with nothing to navigate.
    const path = makeFile("a.ts", "const a = 1\n")
    let called = false
    mount(path, 5, createMockRenderer(WIDE_TERMINAL), {
      onHeadings: () => {
        called = true
      },
    })

    expect(called).toBe(false)
  })
})

describe("the repaint the sidebar depends on", () => {
  it("asks for a frame when the reader moves to a different heading", () => {
    /*
     * The renderer is demand-driven, and a keypress that moves the scrollbox does
     * not by itself ask for anything. The scroll adapter asks for one directly,
     * and the repaint effect asks for one again because `activeHeading` moved --
     * the second is what redraws the *sidebar*, which the first does not know
     * about. Drop `activeHeading()` from the effect's reads and the highlight
     * lags one keypress behind the document, with no error anywhere.
     */
    const path = makeFile("readme.md", "# One\n\ntext\n\n## Two\n\ntext\n\n### Three\n\ntext\n")
    const renderer = createMockRenderer(WIDE_TERMINAL)
    let writer: any
    const { element } = mountCapturingHeadings(path, 20, {
      renderer,
      scrollTo: (fn: any) => (writer = fn),
    })
    renderContentView(element)
    const box = attachScrollbox(element, 0, 400, 20)
    const before = renderer.frames()

    writer((prev: number) => prev + 8)

    expect(box.scrollTop).toBe(8)
    expect(renderer.frames()).toBeGreaterThan(before)
  })

  it("keeps the code path's own repaint untouched", () => {
    /*
     * The sidebar's reads are inside `if (markdown)`. A code file has no
     * positions, no active heading and no sidebar, and the effect that repaints
     * its rows must keep asking for frames on exactly the inputs it did before.
     * This is the regression guard for the branch itself: hoisting those reads
     * out of the `if` would work, but it would also subscribe the code path to
     * three signals it has no business watching.
     */
    const path = makeFile("a.ts", "const a = 1\nconst b = 2\nconst c = 3\n")
    const renderer = createMockRenderer(WIDE_TERMINAL)
    let writer: any
    mount(path, 5, renderer, { scrollTo: (fn: any) => (writer = fn) })
    const before = renderer.frames()

    writer((prev: number) => prev + 1)

    expect(renderer.frames()).toBeGreaterThan(before)
  })
})

describe("tocWindowStart", () => {
  it("keeps the active heading inside the window", () => {
    // Ten headings, a four-row window. The active one lands on the last row when
    // it is below and the first when it is above, and moves as little as it can
    // either way.
    expect(tocWindowStart(0, 10, 4)).toBe(0)
    expect(tocWindowStart(3, 10, 4)).toBe(0)
    expect(tocWindowStart(4, 10, 4)).toBe(1)
    expect(tocWindowStart(9, 10, 4)).toBe(6)
  })

  it("stays at the top when there is no active heading", () => {
    // `-1` is not an index into anything. Treated as one it would clamp to zero
    // here by luck, but the whole point is that it is not treated as one at all:
    // the function returns before any arithmetic runs on it.
    expect(tocWindowStart(-1, 10, 4)).toBe(0)
  })

  it("does not scroll past the end of a list", () => {
    // A window that started past the last entry would draw blank rows below the
    // last heading, which reads as content that is missing.
    expect(tocWindowStart(9, 10, 20)).toBe(0)
    expect(tocWindowStart(3, 10, 10)).toBe(0)
  })

  it("handles a zero-row window without dividing or looping", () => {
    // `props.height` can be zero before the panel has measured itself. A zero-row
    // window has no "last row" to put the active heading on, and the arithmetic
    // has to say something rather than return `NaN` or `-Infinity`.
    expect(tocWindowStart(5, 10, 0)).toBe(5)
    expect(tocWindowStart(5, 0, 0)).toBe(0)
  })
})

describe("tocEntryStyle", () => {
  it("inverts the active row and dims every other", () => {
    // Reverse rather than a colour, because a colour has to be legible against
    // whatever background the reader is running and `reverse` works on any.
    expect(tocEntryStyle(true)).toEqual({ style: { reverse: true, bold: true } })
    expect(tocEntryStyle(false)).toEqual({ style: { fg: "dim" } })
  })

  it("hands out a fresh object each call", () => {
    /*
     * `setProperty` ORs attributes in: `node.attributes |= createTextAttributes(value)`.
     * A shared constant would accumulate -- every row after the highlighted one
     * would inherit its highlight, and un-highlighting would not take.
     */
    const first = tocEntryStyle(true)
    const second = tocEntryStyle(true)
    expect(first).not.toBe(second)
    expect(first.style).not.toBe(second.style)
  })
})
