import { describe, it, expect } from "bun:test"
import { createSignal } from "solid-js"
import { SyntaxStyle } from "@opentui/core"
import { MarkdownContentView, type MarkdownContentViewProps } from "./MarkdownContentView"
import { layoutBlocks } from "./markdownLayout"
import { parseMarkdown } from "./markdownParser"

/**
 * The component's own tests: the rows it draws, the callback it makes, and the
 * frame it asks for. Everything about *what* a row is lives in
 * `markdownLayout.test.ts`, and it is imported here from the layout module rather
 * than from the component's own file -- which is the import `toc.ts` will make,
 * and the one that does not drag a renderable along with it.
 */

/** Counts the frames the plugin asks for, the way FileViewer's own mock does. */
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

/**
 * Mounts the component through the stub JSX runtime.
 *
 * The stub builds a plain description of the tree instead of calling OpenTUI, so
 * the rows are inspectable without a renderer. The reactive tests below do not
 * come through here: they need a getter over a signal for `contentWidth` or
 * `blocks`, which is what babel-preset-solid compiles a caller's JSX into.
 */
function mount(source: string, contentWidth = 40) {
  const renderer = createMockRenderer()
  const positions: Map<number, number>[] = []
  const props = {
    blocks: parseMarkdown(source),
    contentWidth,
    context: { renderer },
    onHeadingPositions: (map: Map<number, number>) => positions.push(map),
  }
  return {
    element: (MarkdownContentView as any)(props),
    renderer,
    positions,
    lastPositions: () => positions[positions.length - 1],
  }
}

/** Every element in a `children` prop, however deeply nested. */
function elements(children: unknown): any[] {
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  return list.filter((child): child is any => Boolean(child) && typeof child === "object")
}

/** The text a node renders, following the stub's shape. */
function textOf(node: any): string {
  if (node === null || node === undefined) return ""
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(textOf).join("")
  return typeof node === "object" ? textOf(node.props?.children) : ""
}

/** The root box's children: one `<text>` per rendered row. */
function rowElements(element: any): any[] {
  return elements(element?.props?.children)
}

/** The rendered rows, as text. */
function textRows(element: any): string[] {
  return rowElements(element).map(textOf)
}

/** One row's coloured runs, as `{text, style}` pairs, in order. */
function spansOf(element: any, row: number): { text: string; style: Record<string, unknown> | undefined }[] {
  return elements(rowElements(element)[row]?.props?.children).map((span: any) => ({
    text: span.props.children,
    style: span.props.style,
  }))
}

describe("MarkdownContentView", () => {
  it("draws one row per row the layout produced", () => {
    const { element } = mount("# Title\n\nsome text\n")

    expect(textRows(element)).toEqual(["Title", "", "some text"])
  })

  it("draws each row as a text node of coloured spans", () => {
    const { element } = mount("# Title\n")
    const row = rowElements(element)[0]

    // `wrapMode="none"` is load-bearing: a row the terminal wrapped itself would
    // be two screen rows, and every heading row the TOC recorded would be
    // counting something the reader cannot see.
    expect(row.type).toBe("text")
    expect(row.props.wrapMode).toBe("none")
    expect(spansOf(element, 0)).toEqual([{ text: "Title", style: { fg: "#e06c75", bold: true } }])
  })

  it("leaves a span with nothing to say with no style at all", () => {
    const { element } = mount("plain text\n")
    const spans = spansOf(element, 0)

    // The wrapper cuts a run at its spaces, so this is three spans rather than
    // one. What matters is that none of them claims a colour or an attribute.
    expect(spans.map((span) => span.text).join("")).toBe("plain text")
    expect(spans.every((span) => span.style === undefined)).toBe(true)
  })

  it("hands the heading positions over on mount", () => {
    const { lastPositions } = mount("# One\n\ntext\n\n## Two\n")

    expect([...(lastPositions()?.entries() ?? [])]).toEqual([[0, 0], [1, 4]])
  })

  it("asks the renderer for a frame on mount", () => {
    const { renderer } = mount("# One\n")

    expect(renderer.frames()).toBe(1)
  })

  it("recomputes the positions and repaints when the width changes", () => {
    const source = "# One\n\naaa bbb ccc ddd eee fff\n\n## Two\n"
    const [width, setWidth] = createSignal(40)
    const renderer = createMockRenderer()
    const maps: Map<number, number>[] = []
    const props = {
      blocks: parseMarkdown(source),
      get contentWidth() {
        return width()
      },
      context: { renderer },
      onHeadingPositions: (map: Map<number, number>) => maps.push(map),
    }
    ;(MarkdownContentView as any)(props)

    expect(maps[maps.length - 1]!.get(1)).toBe(4)
    setWidth(12)

    /*
     * A getter, not a number: babel-preset-solid compiles the caller's JSX into
     * one, and the effect only subscribes to the width because it reads it. With
     * a plain number this whole test would pass its first two assertions on mount
     * and never run again.
     *
     * The rows on screen are not asserted, and the reason is the stub rather than
     * the component: bun compiles the JSX for a test into a plain object, so
     * `props.children` is an array built once at mount. What the host build
     * compiles this file into is `_$insert(el, () => layout().rows.map(...))` --
     * an accessor the reconciler re-calls -- and no test here can reach a
     * reconciler. The callback and the frame request are what a test can see, and
     * both are asserted above; the test below pins the limitation itself.
     */
    expect(maps.length).toBe(2)
    expect(maps[maps.length - 1]!.get(1)).toBe(5)
    expect(renderer.frames()).toBe(2)
  })

  it("cannot catch a stale tree red-handed, because the stub has no reconciler", () => {
    // Pinned so the limitation above is not rediscovered later: a resize really
    // does change the layout, and the stubbed element still describes the rows it
    // was built with.
    const source = "# One\n\naaa bbb ccc ddd eee fff\n\n## Two\n"
    const blocks = parseMarkdown(source)
    const [width, setWidth] = createSignal(40)
    const element = (MarkdownContentView as any)({
      blocks,
      get contentWidth() {
        return width()
      },
      context: { renderer: createMockRenderer() },
      onHeadingPositions: () => {},
    })

    expect(textRows(element)).toHaveLength(5)
    setWidth(12)
    expect(layoutBlocks(blocks, 12).rows).toHaveLength(6)
    // Still five: `props.children` is an array bun built once, and the accessor
    // that would rebuild it lives in the host build's `_$insert` call.
    expect(textRows(element)).toHaveLength(5)
  })

  it("hands over a fresh map each time, so a caller holding the old one is not mutated under it", () => {
    const maps: Map<number, number>[] = []
    const [width, setWidth] = createSignal(40)
    const props = {
      blocks: parseMarkdown("# One\n\naaa bbb ccc ddd eee\n"),
      get contentWidth() {
        return width()
      },
      context: { renderer: createMockRenderer() },
      onHeadingPositions: (map: Map<number, number>) => maps.push(map),
    }
    ;(MarkdownContentView as any)(props)
    setWidth(12)

    expect(maps[0]).not.toBe(maps[1])
  })

  it("re-lays the document when the blocks themselves change", () => {
    // The other half of what the effect reads. A getter for `blocks` is what a
    // caller that opened a different file hands over, and the positions have to
    // follow it exactly as they follow a resize.
    const maps: Map<number, number>[] = []
    const [source, setSource] = createSignal("# One\n\ntext\n")
    const props = {
      get blocks() {
        return parseMarkdown(source())
      },
      contentWidth: 40,
      context: { renderer: createMockRenderer() },
      onHeadingPositions: (map: Map<number, number>) => maps.push(map),
    }
    ;(MarkdownContentView as any)(props)

    expect([...(maps[0]!.entries())]).toEqual([[0, 0]])
    setSource("#\n\n# Two\n\nmore text\n")

    expect(maps).toHaveLength(2)
    // `#` has no text, so the only entry is the second heading -- which the
    // layout draws on row 2, after its own blank separator.
    expect([...(maps[1]!.entries())]).toEqual([[0, 2]])
  })

  it("draws an empty document as no rows, and says so with an empty map", () => {
    const { element, lastPositions } = mount("")

    expect(textRows(element)).toEqual([])
    expect([...(lastPositions()?.entries() ?? [])]).toEqual([])
  })

  it("does not take a `syntaxStyle`, and says so at compile time", () => {
    /*
     * The plan put `syntaxStyle: SyntaxStyle` on this component, and it is
     * deliberately not a prop. `SyntaxStyle` is a native handle keyed by
     * tree-sitter scope names, consulted by the tree-sitter pipeline inside
     * `MarkdownRenderable`; nothing in the layout tokenizes with tree-sitter --
     * blocks come from marked and code fences from Prism -- so there is no scope
     * to ask it about. Code fences take their colours from `highlightLines`, and
     * the rest of the chrome from the One Dark palette `highlight.ts` already
     * uses.
     *
     * The `@ts-expect-error` is the test. An unused directive is itself a compile
     * error, so the day someone adds the prop back this file stops compiling --
     * which is the outcome worth having, because the alternative is a caller
     * passing a handle this component would quietly ignore.
     */
    const props: MarkdownContentViewProps = {
      blocks: parseMarkdown("# One\n"),
      contentWidth: 40,
      context: { renderer: createMockRenderer() } as unknown as MarkdownContentViewProps["context"],
      onHeadingPositions: () => {},
    }
    // @ts-expect-error `syntaxStyle` is not part of MarkdownContentViewProps.
    const withStyle: MarkdownContentViewProps = { ...props, syntaxStyle: SyntaxStyle.create() }

    expect(Object.keys(props)).toEqual(["blocks", "contentWidth", "context", "onHeadingPositions"])
    expect(Object.keys(withStyle)).toContain("syntaxStyle")
  })
})