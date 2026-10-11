import { createEffect, createSignal, type Component } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import type { MarkdownBlock } from "./markdownParser"
import { layoutBlocks, spanProps } from "./markdownLayout"

/**
 * The markdown row layout, and the component that draws it.
 *
 * This is the component half of the replacement for `<markdown content={...} />`.
 * Everything that decides what the rows *are* lives in `markdownLayout.ts` --
 * the wrapping, the markers, the highlighting, and the heading positions -- and
 * this file is the part that needs a renderer: it turns that layout into text
 * nodes, and it is the part that knows a frame has to be asked for.
 *
 * The split is not cosmetic. `toc.ts` has to ask where a heading is, and the
 * only version of that question that can be trusted is the one the screen was
 * drawn from -- so it imports `layoutBlocks` from a module with no JSX in it
 * rather than from this one.
 */

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