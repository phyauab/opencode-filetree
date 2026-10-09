# Markdown Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the file viewer opens a `.md` file, render it as formatted markdown (headings, lists, code blocks, tables, bold/italic) instead of raw text. Code files keep the existing Prism path unchanged.

**Architecture:** `MarkdownRenderable` from `@opentui/core`, reached through the `<markdown>` intrinsic element that `@opentui/solid` exposes. Markdown is a self-managing renderable — it parses and lays out its own blocks — so it cannot go through the viewer's line-by-line span pipeline. It is wrapped in a `<scrollbox>` which owns clipping and scrolling, and the existing keymap drives that scrollbox through an adapter. Colours come from the host theme via `SyntaxStyle.fromTheme()`, which is the decision the user made.

**Tech Stack:** SolidJS (OpenTUI), `@opentui/core` (`MarkdownRenderable`, `SyntaxStyle`), Bun test, babel-preset-solid.

**Spec:** This document. Written from a brainstorming session on 2026-10-09; the technical facts below were read out of the host binary and `@opentui/core`, not guessed.

## Global Constraints

- **Branch is `sidebar-placement`.** Work here; do not merge to `master` until the sidebar placement itself is accepted.
- **`import ... from "@opentui/core"` is safe and mandatory.** OpenCode installs a Bun plugin that rewrites bare `@opentui/core` specifiers in every non-`node_modules` source file to the host's already-loaded module instance. That is why a plugin can call `SyntaxStyle.fromTheme()` and get a style backed by the *same* native render library the renderer owns — a second copy would `dlopen` a second native library and every handle would point into the wrong heap. Use a plain static import; the rewrite is regex-based over `from "…"` and will not follow a computed or dynamic specifier.
- **`SyntaxStyle` is constructed, never newed.** The public constructor takes `(RenderLib, SyntaxStyleHandle)` — a raw native pointer, unusable from JS. The supported entry points are `SyntaxStyle.create()` (empty, no arguments, what the host itself falls back to) and `SyntaxStyle.fromTheme(scopes)`.
- **The host does NOT hand a plugin a `SyntaxStyle` or a `TreeSitterClient`.** `Context` has neither, and neither does `CliRenderer`. The plugin must build its own. The one host route to live instances (`ctx.markdown.registerCodeBlockRenderer`) only covers code blocks inside a host-owned markdown renderable and is not usable here.
- **`treeSitterClient` is deliberately omitted from the `<markdown>` props.** `MarkdownOptions.treeSitterClient` is optional, and `CodeRenderable`'s constructor already defaults it to `getTreeSitterClient()` — a process-global singleton. Passing it explicitly buys nothing.
- **`ctx.theme` is typed as an unresolved import.** `@opencode/theme` is an optional peer of `@opencode/plugin` and is not installed, so `Context["theme"]` resolves to an unresolved module under `skipLibCheck`. Declare a local structural type for the tokens this feature reads rather than importing the host's type.
- **Tests run against stubs** (`bunfig.toml` preloads `scripts/test-stubs.ts`). `@opentui/core` is NOT currently stubbed and must be added — loading the real one in a Bun test would pull in native FFI. The stub only has to satisfy `SyntaxStyle.fromTheme`, `SyntaxStyle.create` and `getTreeSitterClient`.
- **Every state change must request a repaint** via `context.renderer.requestRender()`. The renderer is demand-driven; this is the bug class that cost four earlier fix attempts. The markdown scroll adapter must ask for a frame itself.
- **Never gate keys on renderer focus.** Use plugin-owned state. The existing `viewerOpen` flag is the precedent.
- **Copy conventions:** existing code comments explain *why*, are written in full sentences, and record what was tried and why it failed. Match that density.

## Host facts this plan depends on

Verified by reading `@opentui/core` and the opencode binary. Do not re-derive them; if an implementation step contradicts one, stop and say so.

**`ctx.theme` shape** (resolved at runtime; `$hue.*` references are already substituted):

```ts
{
  text:   { base: string; feedback: {...} }
  syntax: { comment, keyword, function, variable, string, number, type, operator, punctuation }  // all string
  markdown: { text, heading, link, linkText, code, blockQuote, emphasis, strong, horizontalRule } // all string
}
```

**`SyntaxStyle.fromTheme(scopes)`** takes `ThemeTokenStyle[] = { scope: string[]; style: { foreground?, background?, bold?, italic?, underline?, dim? } }[]`. Colours are `ColorInput` — CSS name, hex string, or `RGBA`.

**The host's own theme→style bridge** (`dy()` in the binary) is the contract to replicate. Its full token table, in order:

```
["default"]                                        → text.base
["comment","comment.documentation"]                → syntax.comment,   italic
["string","symbol","character.special","character"]→ syntax.string
["number","boolean","constant","float"]            → syntax.number
["keyword.return","keyword.conditional",
 "keyword.repeat","keyword.coroutine"]             → syntax.keyword,   italic
["keyword.type"]                                   → syntax.type,      bold+italic
["keyword.function","function.method"]             → syntax.function
["keyword","keyword.import","string.escape",
 "string.regexp","tag.attribute","keyword.export"] → syntax.keyword
["operator","keyword.operator","punctuation.delimiter",
 "keyword.conditional.ternary"]                    → syntax.operator
["variable","variable.parameter","function.method.call",
 "function.call","property","parameter","field"]   → syntax.variable
["variable.member","function","constructor"]       → syntax.function
["type","module","class","namespace"]              → syntax.type
["type.definition"]                                → syntax.type,      bold
["punctuation","punctuation.bracket"]              → syntax.punctuation
["markup.heading","markup.heading.2".."markup.heading.6"] → markdown.heading, bold
["markup.heading.1"]                               → markdown.heading, bold+underline
["markup.bold","markup.strong"]                    → markdown.strong,  bold
["markup.italic"]                                  → markdown.emphasis, italic
["markup.list"]                                    → markdown.listItem
["markup.quote"]                                   → markdown.blockQuote, italic
["markup.raw","markup.raw.block"]                   → markdown.code
["markup.raw.inline"]                              → markdown.code, background: background.base
["markup.link","markup.link.url","string.special",
 "string.special.url"]                             → markdown.link, underline
["markup.link.label"]                              → markdown.linkText, underline
["label"]                                          → markdown.linkText
["spell","nospell"]                                → text.base
```

**`ScrollBoxRenderable`** exposes `scrollTop` (get/set), `scrollTo(position)` and `scrollBy(delta, unit)` where unit is `"absolute" | "viewport" | "content" | "step"`. Drive it with `scrollTo(row)`; clamp against its own `maxScrollTop` if `scrollTo` does not clamp itself.

**`MarkdownRenderable`** constructor is `(ctx, options)`, which is how every intrinsic element is built, so `<markdown>` through the reconciler follows the same path as `<box>` and `<text>`. It has reactive setters for `content`, `syntaxStyle`, `conceal` and friends. `conceal` defaults to `true`, which is what hides the `#`/`*`/backtick markers — the whole point of a preview.

## Review Focus

1. **A `.md` file must reach the markdown path and a non-`.md` file must not.** Pinned by an assertion on the rendered element types, not on the file's content.
2. **A missing or partial `ctx.theme` must not throw.** Every token is optional in practice; a theme that omits `markdown.code` still has to render.
3. **The existing Prism path must be untouched.** Its 24 `FileViewer` tests must pass unchanged.
4. **The scroll adapter must not dead-key.** Pressing `down` at the bottom of a long markdown file must not throw or jump.

---

### Task 1: `SyntaxStyle` from the host theme

**Files:**
- Create: `src/viewer/markdown.ts`
- Test: `src/viewer/markdown.test.ts`
- Modify: `scripts/test-stubs.ts` (shared — add the `@opentui/core` mock)

**Interfaces:**
- Consumes: `languageFor` from `./highlight`.
- Produces:
  ```ts
  /** The subset of `ctx.theme` this feature reads. Structural, because the host's
   *  own theme type is an unresolved optional peer. */
  export type MarkdownTheme = {
    text?: { base?: string }
    syntax?: Partial<Record<"comment" | "keyword" | "function" | "variable" | "string" | "number" | "type" | "operator" | "punctuation", string>>
    markdown?: Partial<Record<"heading" | "strong" | "emphasis" | "code" | "blockQuote" | "link" | "linkText" | "listItem", string>>
  }

  /** True for the extensions the viewer renders as markdown rather than as code. */
  export function isMarkdown(path: string): boolean

  /**
   * A `SyntaxStyle` built from the host theme, or `SyntaxStyle.create()` when the
   * theme carries nothing usable. Memoised on the token values, so opening
   * several files costs one construction and a theme change is picked up.
   */
  export function buildSyntaxStyle(theme: MarkdownTheme | undefined): SyntaxStyle
  ```

- [ ] **Step 1: Write the failing test**

Create `src/viewer/markdown.test.ts`:

```ts
import { describe, it, expect } from "bun:test"
import { isMarkdown, buildSyntaxStyle } from "./markdown"
import { SyntaxStyle } from "@opentui/core"

/** The scopes the stubbed SyntaxStyle recorded, keyed for lookup. */
const scopesOf = (style: any): Map<string, any> => {
  const map = new Map<string, any>()
  for (const entry of style.scopes) for (const scope of entry.scope) map.set(scope, entry.style)
  return map
}

const fullTheme = {
  text: { base: "#ffffff" },
  syntax: {
    comment: "#5c6370", keyword: "#c678dd", function: "#61afef", variable: "#abb2bf",
    string: "#98c379", number: "#d19a66", type: "#e5c07b", operator: "#56b6c2",
    punctuation: "#abb2bf",
  },
  markdown: {
    heading: "#e06c75", strong: "#e06c75", emphasis: "#e5c07b", code: "#98c379",
    blockQuote: "#5c6370", link: "#61afef", linkText: "#61afef", listItem: "#e5c07b",
  },
}

describe("isMarkdown", () => {
  it("is true for md and markdown", () => {
    expect(isMarkdown("README.md")).toBe(true)
    expect(isMarkdown("docs/notes.markdown")).toBe(true)
  })

  it("is false for every other extension", () => {
    expect(isMarkdown("a.ts")).toBe(false)
    expect(isMarkdown("a.mdx")).toBe(false)
    expect(isMarkdown("Makefile")).toBe(false)
  })
})

describe("buildSyntaxStyle", () => {
  it("maps the host's syntax tokens onto the scopes the host itself uses", () => {
    const scopes = scopesOf(buildSyntaxStyle(fullTheme))
    expect(scopes.get("comment")).toEqual({ foreground: "#5c6370", italic: true })
    expect(scopes.get("keyword")).toEqual({ foreground: "#c678dd" })
    expect(scopes.get("string")).toEqual({ foreground: "#98c379" })
    expect(scopes.get("number")).toEqual({ foreground: "#d19a66" })
    expect(scopes.get("function")).toEqual({ foreground: "#61afef" })
    expect(scopes.get("punctuation")).toEqual({ foreground: "#abb2bf" })
  })

  it("maps the markdown tokens onto the markup scopes", () => {
    const scopes = scopesOf(buildSyntaxStyle(fullTheme))
    expect(scopes.get("markup.heading")).toEqual({ foreground: "#e06c75", bold: true })
    expect(scopes.get("markup.heading.1")).toEqual({ foreground: "#e06c75", bold: true, underline: true })
    expect(scopes.get("markup.bold")).toEqual({ foreground: "#e06c75", bold: true })
    expect(scopes.get("markup.italic")).toEqual({ foreground: "#e5c07b", italic: true })
    expect(scopes.get("markup.quote")).toEqual({ foreground: "#5c6370", italic: true })
    expect(scopes.get("markup.raw")).toEqual({ foreground: "#98c379" })
  })

  it("returns the empty style when there is no theme at all", () => {
    expect(buildSyntaxStyle(undefined)).toBe(SyntaxStyle.create())
  })

  it("skips tokens the theme does not carry instead of guessing colours", () => {
    const scopes = scopesOf(buildSyntaxStyle({ syntax: { comment: "#111111" } }))
    expect(scopes.get("comment")).toEqual({ foreground: "#111111", italic: true })
    expect(scopes.has("string")).toBe(false)
    expect(scopes.has("markup.heading")).toBe(false)
  })

  it("memoises on the token values, so a theme change is picked up", () => {
    const first = buildSyntaxStyle(fullTheme)
    expect(buildSyntaxStyle(fullTheme)).toBe(first)
    const second = buildSyntaxStyle({ ...fullTheme, syntax: { ...fullTheme.syntax, keyword: "#ff0000" } })
    expect(second).not.toBe(first)
    expect(scopesOf(second).get("keyword")).toEqual({ foreground: "#ff0000" })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/viewer/markdown.test.ts`
Expected: FAIL — `Cannot find module './markdown'`, and `@opentui/core` is not stubbed so the import of `SyntaxStyle` may fail first. Both are expected; add the stub before re-running.

- [ ] **Step 3: Add the `@opentui/core` stub to `scripts/test-stubs.ts`**

Append to the existing file, after the `@opentui/solid/jsx-dev-runtime` mock:

```ts
/**
 * `@opentui/core`, for the markdown preview.
 *
 * The real package loads a native render library over FFI, which a unit test has
 * no business doing, and the plugin is never supposed to ship its own copy. This
 * stands in for exactly the three members the viewer calls.
 *
 * `fromTheme` records the scope list it was handed rather than interpreting it,
 * which is what lets a test assert the theme→scope mapping without a renderer.
 */
mock.module("@opentui/core", () => ({
  SyntaxStyle: {
    fromTheme: (scopes: unknown[]) => ({ __stub: "SyntaxStyle.fromTheme", scopes }),
    create: () => ({ __stub: "SyntaxStyle.create", scopes: [] }),
  },
  getTreeSitterClient: () => ({ __stub: "TreeSitterClient" }),
}))
```

Leave a short comment noting nothing else in the suite imports this module yet.

- [ ] **Step 4: Run the test to verify it still fails**

Run: `bun test src/viewer/markdown.test.ts`
Expected: FAIL — `Cannot find module './markdown'`.

- [ ] **Step 5: Implement `src/viewer/markdown.ts`**

`isMarkdown` delegates to `languageFor(path) === "markdown"` — `highlight.ts` already maps `md` and `markdown`, and one owner of the extension table beats two. Note in a comment that `.mdx` is deliberately NOT markdown: `languageFor` does not map it, and Prism's markdown grammar would mis-tokenise JSX.

`buildSyntaxStyle`:

1. If `theme` is undefined, or carries none of the tokens the table reads, return `SyntaxStyle.create()` — the host's own fallback, and the only answer that is valid with no theme.
2. Otherwise walk the token table from **Host facts** above, pushing one `{ scope, style }` per row **whose every source token is present**. A row with a missing token is skipped whole rather than half-filled — a heading that gets a colour but loses its `bold` is worse than a heading in the default style.
3. Memoise: keep a module-level `{ key, style }` cache. `key` is a joined string of the token values in a fixed order (so a changed token changes the key). Return the cached style when the key matches.
4. Wrap the whole body in try/catch and fall back to `SyntaxStyle.create()`. A malformed theme must not take the panel down.

Comment the memoisation honestly: `SyntaxStyle` holds a native handle and has a `destroy()` this never calls, so a theme change leaks one style. That is bounded by the number of theme changes in a session and is the same trade the host makes.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/viewer/markdown.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Run the whole suite**

Run: `bun test`
Expected: all pass except the 4 pre-existing `verify-no-local-opentui` failures, which are NOT yours (the controller verified `node_modules/@opentui/core` and `node_modules/solid-js` are physically present and were resolved by an earlier lockfile). The new `@opentui/core` mock must not disturb them.

- [ ] **Step 8: Commit**

```bash
git add scripts/test-stubs.ts src/viewer/markdown.ts src/viewer/markdown.test.ts
git commit -m "feat(viewer): build a SyntaxStyle from the host theme for markdown"
```

---

### Task 2: The markdown render path in `FileViewer`

**Files:**
- Modify: `src/viewer/FileViewer.tsx`
- Test: `src/viewer/FileViewer.test.ts`

**Interfaces:**
- Consumes: `isMarkdown`, `buildSyntaxStyle` from `./markdown` (Task 1); `readForView` → `ViewFile`; `highlightLines`/`languageFor`; `maxScroll` from `./scroll`.

- [ ] **Step 1: Write the failing tests**

Add to `src/viewer/FileViewer.test.ts`, reusing the existing `mount`/`elements`/`rowsOf` helpers. The `mount` helper needs a `theme` argument threaded through to the context — extend it the same way `scrollTo` is threaded, defaulting to `undefined` so every existing call is unchanged:

```ts
it("renders markdown files through a scrollbox and a markdown element", () => {
  const path = makeFile("readme.md", "# Title\n\nsome text\n")
  const element = mount(path, 5, createMockRenderer(), undefined, {
    theme: { markdown: { heading: "#e06c75" } },
  })
  const children = elements(element?.props?.children)
  expect(children.some((child: any) => child.type === "markdown")).toBe(true)
  expect(children.some((child: any) => child.type === "scrollbox")).toBe(true)
})

it("passes the whole file to the markdown element and conceals the markers", () => {
  const path = makeFile("readme.md", "# Title\n\nsome text\n")
  const element = mount(path, 5, createMockRenderer(), undefined, {
    theme: { markdown: { heading: "#e06c75" } },
  })
  const md = elements(element?.props?.children).find((child: any) => child.type === "markdown")
  expect(md?.props.content).toBe("# Title\n\nsome text")
  expect(md?.props.conceal).toBe(true)
})

it("leaves code files on the Prism path", () => {
  const path = makeFile("a.ts", "const a = 1\n")
  const element = mount(path, 5, createMockRenderer(), undefined, {
    theme: { markdown: { heading: "#e06c75" } },
  })
  const children = elements(element?.props?.children)
  expect(children.some((child: any) => child.type === "markdown")).toBe(false)
  expect(children.some((child: any) => child.type === "scrollbox")).toBe(false)
  expect(rowsOf(element)).toEqual(["1 │ const a = 1"])
})

it("shows the file name alone in the markdown header, with no line range", () => {
  const path = makeFile("readme.md", "# Title\n\nsome text\n")
  const element = mount(path, 5, createMockRenderer(), undefined, {
    theme: { markdown: { heading: "#e06c75" } },
  })
  expect(headerOf(element)).toBe("readme.md")
})

it("falls back to the Prism path when the theme carries no markdown tokens", () => {
  // Review Focus #2: a theme that says nothing usable must not throw, and the
  // reader still gets to read the file.
  const path = makeFile("readme.md", "# Title\n\nsome text\n")
  const element = mount(path, 5, createMockRenderer(), undefined, { theme: {} })
  const children = elements(element?.props?.children)
  expect(children.some((child: any) => child.type === "markdown")).toBe(false)
  expect(rowsOf(element)).toEqual(["1 │ # Title", "2 │ ", "3 │ some text"])
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/viewer/FileViewer.test.ts`
Expected: FAIL on the five new tests.

- [ ] **Step 3: Implement the markdown path**

In the component body, after `const file = readForView(props.path)`:

```ts
const lines = file.kind === "text" ? file.lines : []
const markdown = isMarkdown(props.path) && file.kind === "text"
const syntaxStyle = markdown ? buildSyntaxStyle(themeOf(props.context)) : undefined
const asMarkdown = markdown && syntaxStyle !== undefined
const spans = asMarkdown ? [] : tokenize(lines, props.path)
```

`themeOf(context)` is a small local helper that returns `context.theme` typed as `MarkdownTheme | undefined`. It exists because `Context["theme"]` is an unresolved import — one cast in one place, with a comment saying so.

Then, in the returned JSX, *before* the existing text branch:

```tsx
if (asMarkdown) {
  return (
    <box flexDirection="column">
      <text fg="dim" wrapMode="none" truncate>{basename(props.path)}</text>
      <scrollbox flexGrow={1} ref={captureMarkdownBox}>
        <markdown content={lines.join("\n")} syntaxStyle={syntaxStyle} conceal />
      </scrollbox>
    </box>
  )
}
```

Rules for this step:

- **`captureMarkdownBox` must be one closure per mount.** Declare `let markdownBox: unknown` in the body and `const captureMarkdownBox = (el: unknown) => { markdownBox = el }` next to it. The body runs once per mount, so the closure is created once — this is the same lesson as `FileTree`'s `captureRoot`, which re-subscribed per render until the ref was made stable. Say so in the comment.
- **The header for markdown carries the name and the truncation notice, never a line range.** The rendered height of markdown is not the file's line count — a paragraph wraps, a list gains markers, blocks are separated by blank rows — so `start+1-last of total` would be a number the reader cannot map to anything on screen. When `file.truncated`, append `— first N lines` exactly as the text path does.
- **`conceal` is explicit**, matching its default of `true`, so a reader is not left to work out whether the markers are hidden.
- **`treeSitterClient` is not passed.** `CodeRenderable` defaults it to the process-global singleton; passing it buys nothing.
- **Do not touch the text path's JSX.** Its 24 existing tests must pass unchanged (Review Focus #3).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/viewer/FileViewer.test.ts`
Expected: PASS — the original 24 plus the 5 new.

- [ ] **Step 5: Run the whole suite, typecheck and build**

Run: `bun test && bun run typecheck && bun run build`
Expected: all clean except the 4 pre-existing `verify-no-local-opentui` failures.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/FileViewer.tsx src/viewer/FileViewer.test.ts
git commit -m "feat(viewer): render markdown files through MarkdownRenderable"
```

---

### Task 3: Drive the scrollbox from the existing keymap

**Files:**
- Modify: `src/viewer/FileViewer.tsx`
- Modify: `src/tui.tsx`
- Test: `src/viewer/FileViewer.test.ts`
- Test: `src/tui.test.ts`

**Interfaces:**
- Consumes: the `scrollTo?: (setOffset: Setter<number>) => void` prop, unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/viewer/FileViewer.test.ts`:

```ts
it("hands the markdown path a writer that drives the scrollbox", () => {
  const path = makeFile("readme.md", "# Title\n\nsome text\n")
  let writer: any
  const element = mount(path, 5, createMockRenderer(), {
    scrollTo: (fn: any) => (writer = fn),
  }, { theme: { markdown: { heading: "#e06c75" } } })

  // A stand-in for the ScrollBoxRenderable, handed over the way the reconciler
  // hands a ref.
  const scrolled: number[] = []
  const box = elements(element?.props?.children).find((child: any) => child.type === "scrollbox")
  const fake = { scrollTop: 7, maxScrollTop: 100, scrollTo: (n: number) => scrolled.push(n) }
  box.props.ref(fake)

  // The plugin always calls with an updater over the previous position, which is
  // what scrollByLine produces.
  writer((prev: number) => prev + 1)
  expect(scrolled).toEqual([8])
})

it("clamps the markdown scroll against the scrollbox's own maximum", () => {
  const path = makeFile("readme.md", "# Title\n\nsome text\n")
  let writer: any
  const element = mount(path, 5, createMockRenderer(), {
    scrollTo: (fn: any) => (writer = fn),
  }, { theme: { markdown: { heading: "#e06c75" } } })
  const scrolled: number[] = []
  const box = elements(element?.props?.children).find((child: any) => child.type === "scrollbox")
  box.props.ref({ scrollTop: 100, maxScrollTop: 100, scrollTo: (n: number) => scrolled.push(n) })

  writer((prev: number) => prev + 1)
  expect(scrolled).toEqual([100])
})

it("still hands the text path its own offset signal", () => {
  const path = makeFile("a.ts", "const a = 1\nconst b = 2\n")
  let writer: any
  const element = mount(path, 5, createMockRenderer(), { scrollTo: (fn: any) => (writer = fn) })
  writer((prev: number) => prev + 1)
  expect(rowsOf(element)).toEqual(["2 │ const b = 2"])
})
```

In `src/tui.test.ts`:

```ts
//  - opening a markdown file hands the keymap a line count that cannot clamp early
//  - opening a code file keeps the reader's own line count
```

Assert on whatever the mock records of `viewerLines`; if the mock cannot see it, assert instead that `openViewer` on a `.md` file and on a `.ts` file both open the panel, and say in the report that the sentinel is not covered by a test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/viewer/FileViewer.test.ts src/tui.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement the scroll adapter in `FileViewer.tsx`**

Replace the single `props.scrollTo?.(setScroll)` with a branch:

```ts
if (asMarkdown) {
  props.scrollTo?.(markdownScroll)
} else {
  props.scrollTo?.(setScroll)
}
```

`markdownScroll` is a `Setter<number>` that adapts. Its contract, in one comment: the plugin never says where to go, only how far — it hands an updater over a previous position, and the scrollbox is the source of truth for what that previous position is.

```ts
const markdownScroll: Setter<number> = (value) => {
  const box = markdownBox as { scrollTop: number; maxScrollTop: number; scrollTo(n: number): void } | undefined
  if (!box) return 0
  const updater = typeof value === "function" ? value : () => value
  const next = updater(box.scrollTop)
  // Clamp against the box's own maximum rather than trusting scrollTo to: the
  // viewer was handed a line count that deliberately cannot clamp (see
  // openViewer), so something has to, and this is the only side that knows the
  // rendered height.
  box.scrollTo(Math.max(0, Math.min(next, box.maxScrollTop)))
  context.renderer.requestRender()
  return next
}
```

- [ ] **Step 4: Make `openViewer` hand the keymap a line count that cannot clamp**

In `src/tui.tsx`, where `setViewerLines(...)` is called:

```ts
// Markdown renders as blocks, so its rendered height is not its line count and
// is not known until the renderable has laid out. A sentinel keeps
// scrollByLine's clamp from binding early and cutting the bottom off; the
// viewer's adapter clamps against the scrollbox's own maxScrollTop instead.
const rendered = file.kind === "text" ? file.totalLines : 0
setViewerLines(isMarkdown(entry.path) && file.kind === "text" ? Number.MAX_SAFE_INTEGER : rendered)
```

Import `isMarkdown` from `./viewer/markdown`. Comment why `Number.MAX_SAFE_INTEGER` and not a smaller guess: any guess risks clipping a long file, and the cost of the sentinel is one comparison.

- [ ] **Step 5: Run the suite, typecheck and build**

Run: `bun test && bun run typecheck && bun run build`
Expected: all clean except the 4 pre-existing failures.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/FileViewer.tsx src/tui.tsx src/viewer/FileViewer.test.ts src/tui.test.ts
git commit -m "feat(viewer): scroll markdown through the scrollbox from the existing keys"
```

---

## Live Verification (not automatable)

The test stubs model none of the host behaviour this feature depends on. After the final task, verify by hand and report what was actually observed:

1. `bun install` has run; `bun run build` is clean.
2. Restart OpenCode fully (hot reload watches the shim, not `dist/`).
3. `enter` on a `.md` file: headings render bold/coloured, lists are bulleted, blockquotes are indented, fenced code blocks are shaded and syntax-highlighted, and the `#`/`*`/backtick markers are gone.
4. `enter` on a `.ts` file: still One Dark Prism colours, gutter and header unchanged.
5. `↑`/`↓`/`pageup`/`pagedown` scroll the markdown; at the bottom they stop instead of throwing or going blank.
6. `esc` closes the viewer and returns the keys to the tree.
7. A long `.md` file (500+ lines) opens without a visible stall.
8. A `.md` file with a broken fence or malformed table renders without crashing.
9. Switch the OpenCode theme and reopen a `.md` file: the colours follow the new theme.

**The unverified assumption to watch:** `<markdown>` reached through the Solid reconciler has never been constructed in a real host. Every assertion above depends on it. If it throws, the panel breaks rather than degrading — check this first, and reverting is `git revert` of the two `feat(viewer)` commits above.
