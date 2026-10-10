/**
 * Layout probe for the markdown branch of the file viewer -- the executable
 * reproduction of the header/content overlap, against the REAL renderer.
 *
 * Run it by hand: `bun scripts/probe-markdown-layout.ts` (needs node_modules;
 * loads the native render library the unit suite deliberately does not).
 *
 * Why a script and not a test: `scripts/test-stubs.ts` stubs `@opentui/core`
 * process-wide so `bun test` never loads the native library, and a test that
 * ran the real renderer next to that stub would pass or fail depending on
 * module load order. The unit suite pins the props that carry the bound
 * (`flexShrink={0}` on the header, `flexBasis={0}` on the scrollbox); this
 * script pins the bound's effect, which is the part only the real renderer can
 * show.
 *
 * The bug it was written for: OpenTUI renderables default to `flexShrink: 1`,
 * so a fixed-height column whose children's flex bases overflow it shrinks both
 * in proportion to those bases. The scrollbox's basis is `auto` -- its content
 * height -- so a document taller than the panel overflows the column, the
 * scrollbox's basis dominates, and it fills the box from y=0 over the header's
 * row while the markdown paints its first rows over the filename. Before the
 * fix the captured frame's first row read `linem1.md`; after it, row 0 is the
 * filename and row 1 is the first line, at rest and scrolled.
 */
import { createTestRenderer } from "@opentui/core/testing"
import { BoxRenderable, MarkdownRenderable, ScrollBoxRenderable, SyntaxStyle, RGBA, TextRenderable } from "@opentui/core"

/** Stands in for `viewerHeight()` = terminalHeight - VIEWER_ROWS_CHROME. */
const HEIGHT = 20
const WIDTH = 60

const style = SyntaxStyle.fromTheme([
  { scope: ["default"], style: { foreground: RGBA.fromHex("#abb2bf") } },
  { scope: ["markup.heading", "markup.heading.2"], style: { foreground: RGBA.fromHex("#e06c75"), bold: true } },
])

const setup = await createTestRenderer({ width: WIDTH, height: 24 })
const { renderer, renderOnce } = setup

// The markdown branch's tree, as `dist/viewer/FileViewer.js` builds it.
const root = new BoxRenderable(renderer, { flexDirection: "column", height: HEIGHT })
const header = new TextRenderable(renderer, {
  fg: "dim",
  wrapMode: "none",
  truncate: true,
  flexShrink: 0, // the fix: the header's row is not negotiable
})
header.content = "readme.md"
const box = new ScrollBoxRenderable(renderer, {
  flexGrow: 1,
  flexBasis: 0, // the fix: the box's size comes from the container, not content
})
box.add(
  new MarkdownRenderable(renderer, {
    content: Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n"),
    syntaxStyle: style,
    conceal: true,
    // Probe-only. The host's highlight worker draws the real thing; without it
    // the code blocks would never draw a character here, and streaming draws
    // the unstyled text immediately. Row geometry is all this probe reads.
    streaming: true,
  }),
)
root.add(header)
root.add(box)
renderer.root.add(root)

const settle = async () => {
  for (let i = 0; i < 4; i++) await renderOnce()
  await setup.waitForVisualIdle({})
}

const rows = () => setup.captureCharFrame().split("\n")

let failures = 0
const check = (label: string, ok: boolean, detail: string) => {
  if (!ok) failures++
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` -- ${detail}`}`)
}

await settle()

check("header keeps its measured row", header.y === 0 && header.height === 1, `header y=${header.y} h=${header.height}`)
check(
  "scrollbox sits below the header, bounded",
  box.y === 1 && box.height === HEIGHT - 1,
  `scrollbox y=${box.y} h=${box.height}`,
)
const atRest = rows()
check("row 0 is the filename", atRest[0]?.startsWith("readme.md") === true, JSON.stringify(atRest[0]))
check("row 1 is the first line of the file", atRest[1]?.startsWith("line 1") === true, JSON.stringify(atRest[1]))

box.scrollTo(5)
await settle()
const scrolled = rows()
check("row 0 stays the filename once scrolled", scrolled[0]?.startsWith("readme.md") === true, JSON.stringify(scrolled[0]))
check("scroll actually moved the content", box.scrollTop === 5, `scrollTop=${box.scrollTop}`)

console.log(failures === 0 ? "probe: geometry as designed" : `probe: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
