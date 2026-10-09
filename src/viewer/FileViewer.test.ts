import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"
import { FileViewer, VIEWER_ROWS_CHROME } from "./FileViewer"
import { MAX_VIEW_LINES } from "./readForView"

const created: string[] = []

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

function makeFile(name: string, contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "viewer-"))
  created.push(root)
  const path = join(root, name)
  writeFileSync(path, contents)
  return path
}

/** Counts the frames the plugin asks for, the way FileTree's own mock does. */
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
 * The text a node renders, following the stub's shape: children are strings,
 * spans, or arrays of either, at any depth.
 */
function textOf(node: any): string {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  return typeof node === "object" ? textOf(node.props?.children) : ""
}

/** The header line, which is always the first child of the root box. */
function headerOf(element: any): string {
  return textOf(elements(element?.props?.children)[0])
}

/**
 * The rendered content rows, which is everything after the header.
 *
 * A message row (error, binary) is included: it is drawn in the same slot, so
 * the assertions do not have to know which kind produced it.
 */
function rowsOf(element: any): string[] {
  return elements(element?.props?.children)
    .slice(1)
    .map(textOf)
}

/** The colours a row's own pieces carry, in order, so highlighting is assertable. */
function codeColorsOf(element: any): (string | undefined)[] {
  const row = elements(element?.props?.children)[1]
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
    // default rather than picking one out of the table.
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
    const row = elements(element?.props?.children)[1]
    const pieces = elements(row?.props?.children)
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
    for (const child of elements(element.props.children)) {
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
 * It exists to make the theme -> context -> style wiring observable, which is
 * otherwise invisible: the element renders either way. It says nothing about
 * which files count as markdown -- the extension decides that alone, through
 * `isMarkdown` -- so a thinner theme must never be read as "not markdown".
 */
const mdTheme = { markdown: { heading: "#e06c75" } }

/**
 * The markdown element, which is the scrollbox's only child.
 *
 * `elements` flattens arrays and does not descend into an element's own
 * `children`, so it stops at the scrollbox. Walking that one step here is what
 * Task 3's scroll adapter test has to do too, to reach `ref` on the same box.
 */
function markdownOf(element: any): any {
  const box = elements(element?.props?.children).find((child: any) => child.type === "scrollbox")
  return elements(box?.props?.children).find((child: any) => child.type === "markdown")
}

describe("a markdown file", () => {
  it("renders markdown files through a scrollbox and a markdown element", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(), { theme: mdTheme })
    const children = elements(element?.props?.children)
    expect(children.some((child: any) => child.type === "scrollbox")).toBe(true)
    expect(markdownOf(element)).toBeTruthy()
  })

  it("passes the whole file to the markdown element and conceals the markers", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(), { theme: mdTheme })
    const md = markdownOf(element)
    expect(md.props.content).toBe("# Title\n\nsome text")
    expect(md.props.conceal).toBe(true)

    /*
     * The whole theme -> context -> style wiring, asserted in the one place it
     * can be seen.
     *
     * It has to be asserted here because every other property of this path is
     * satisfied without it: if `mount` put `theme` on the component's props
     * instead of its context, `themeOf` would read `undefined` for every test,
     * `buildSyntaxStyle(undefined)` would hand back the host's empty style, the
     * `<markdown>` element would still render, and `rowsOf` would still be
     * `[""]`. All six markdown tests and all 24 pre-existing ones would pass.
     *
     * The stub's two entry points return distinguishable shapes -- `fromTheme`
     * records the scope list it was handed, `create()` returns an empty one --
     * so the discriminator says which branch built this style, and the scope row
     * says the token really reached the table rather than being lost on the way.
     */
    expect(md.props.syntaxStyle.__stub).toBe("SyntaxStyle.fromTheme")
    expect(md.props.syntaxStyle.scopes.some((row: any) => row.scope.includes("markup.heading"))).toBe(true)
  })

  it("leaves code files on the Prism path", () => {
    const path = makeFile("a.ts", "const a = 1\n")
    const element = mount(path, 5, createMockRenderer(), { theme: mdTheme })
    const children = elements(element?.props?.children)
    expect(children.some((child: any) => child.type === "markdown")).toBe(false)
    expect(children.some((child: any) => child.type === "scrollbox")).toBe(false)
    expect(rowsOf(element)).toEqual(["1 │ const a = 1"])
  })

  it("shows the file name alone in the markdown header, with no line range", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(), { theme: mdTheme })
    expect(headerOf(element)).toBe("readme.md")
  })

  it("still renders markdown when the theme carries nothing usable", () => {
    // Review Focus #2: a thin theme buys an uncoloured preview, never a return to
    // raw markdown source -- which is the complaint this feature exists to fix.
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(), { theme: {} })
    expect(markdownOf(element)).toBeTruthy()
    // The theme reached `buildSyntaxStyle` and was found to hold nothing the
    // table reads, so the host's own empty style came back -- the same branch a
    // theme that never arrived at all takes. A built-from-a-theme style here
    // would mean the empty theme had been read as a coloured one.
    expect(markdownOf(element).props.syntaxStyle.__stub).toBe("SyntaxStyle.create")
    // The Prism rows are gone with them: the only thing after the header is the
    // scrollbox, which renders no text of its own in the stub.
    expect(rowsOf(element)).toEqual([""])
  })

  it("still renders markdown when there is no theme at all", () => {
    const path = makeFile("readme.md", "# Title\n\nsome text\n")
    const element = mount(path, 5, createMockRenderer(), {})
    expect(markdownOf(element)).toBeTruthy()
    // Same fallback as the thin theme, by the same route: an absent theme and an
    // empty one both land in `SyntaxStyle.create()`, and neither is a reason to
    // show raw markdown source.
    expect(markdownOf(element).props.syntaxStyle.__stub).toBe("SyntaxStyle.create")
  })

  it("carries the truncation notice in the markdown header", () => {
    // A duplicated branch can drift. The text path pins its own notice, so the
    // markdown copy needs the same assertion or a change to one would leave the
    // other claiming something the reader can check.
    const path = makeFile("big.md", "x\n".repeat(MAX_VIEW_LINES + 1))
    const element = mount(path, 5, createMockRenderer(), { theme: mdTheme })

    expect(headerOf(element)).toContain(`first ${MAX_VIEW_LINES} lines`)
  })
})
