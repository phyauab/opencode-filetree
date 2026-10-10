# File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing `enter` on a file in the sidebar tree opens it in a read-only, syntax-highlighted viewer inside the terminal instead of spawning `$EDITOR`.

**Architecture:** Four new units under `src/viewer/`. Pure logic first (read-with-limits, highlight, scroll math) so each is testable without a TUI, then one Solid component that composes them. The viewer claims `session.panel` and renders only when `input.name` matches. `enter` replaces `spawnEditor` with an `openViewer` call; the external-editor path is deleted.

**Tech Stack:** SolidJS (OpenTUI), Prism.js (headless `tokenize`), Bun test, babel-preset-solid.

**Spec:** This document. Written from a brainstorming session on 2026-10-09; the decisions below are the record of that conversation, and the constraints in Global Constraints came out of reading the host binary rather than from the docs.

## Global Constraints

- **Branch is `sidebar-placement`.** Work here; do not merge to `master` until the sidebar placement itself is accepted.
- **`bun run build` is babel, not a bundler.** It compiles each `src/` file individually into `dist/`. Bare npm specifiers survive into `dist/` and resolve at runtime because `dist/` sits inside the repo with `node_modules` as an ancestor. Verified: `import Prism from "prismjs"` from a `dist/*.js` file resolves under Bun and `Prism.tokenize` is a function.
- **Prism is added as a real runtime `dependencies` entry.** This is the repo's first runtime dependency; `@opencode/plugin` stays types-only. `scripts/strip-opentui-runtime.mjs` only deletes files from `opentui-types-*` and `solid-types`, so Prism is untouched by the postinstall guard.
- **Prism must be used headless.** `Prism.highlightElement` needs a DOM and must never be called. `Prism.tokenize(code, grammar)` is the only entry point.
- **Language grammars are imported individually**, not via `prismjs` autoloader (`import "prismjs/components/prism-*"`), because the autoloader reaches for `document`.
- **New npm dependencies require a fresh `bun install`**, and the plugin does not work until it has run. README must say so.
- **Do not use promise-based file reads in component bodies.** The TUI plugin runtime does not reliably drain promise continuations — this is why `readDirSync` and `getGitStatusSync` exist. The viewer reads synchronously for the same reason.
- **Every state change must request a repaint** via `context.renderer.requestRender()`. The renderer is demand-driven; Solid updating state paints nothing on its own. This is the bug class that cost four earlier fix attempts.
- **Keymap layers that must win against host layers set `priority: 10`.** Layers resolve by `priority` descending then registration order (`n.priority - t.priority || n.order - t.order`). The host registers a layer gated on `currentFocusedEditor === null` which binds `down`/`up` for session and subagent navigation, and that getter is null for any non-editor renderable.
- **Never gate keys on renderer focus.** The host re-asserts focus on the prompt ~1s after the tree takes it. Use plugin-owned state. Focus is presentation only.
- **JSX must be compiled by `babel-preset-solid`, never `tsc`.** `tsc`'s JSX modes pass props as a plain object, which Solid's components cannot subscribe to; every `<Show>`/`<For>` built that way is inert.
- **Tests run against stubs** (`bunfig.toml` preloads `scripts/test-stubs.ts`). The stub `solid-js` provides `createSignal`/`createEffect`/`untrack`; the JSX runtime stub returns `{ type, props }` descriptions. Components are invoked as `element.type(element.props)` when a test needs their output. Host behaviour the stubs do not model (focus stealing, layer resolution, Prism) can only be verified by a live run — say so rather than implying a test covers it.
- **Copy conventions:** existing code comments explain *why*, are written in full sentences, and record what was tried and why it failed. Match that.

## Review Focus

The spec is silent on these, so each needs a test pinning it to the task that owns the code. Most likely to bite first.

1. **A file that is unreadable (permissions, deleted mid-session, a directory).** Expect a readable message in the viewer, not a crash or a blank panel.
2. **A file whose size is exactly at the byte cap, and one just over.** Expect the truncation notice to appear only when content was actually dropped.
3. **A single-line file with no trailing newline.** Expect one line rendered, not zero, and no phantom empty row.
4. **A file with no recognised language extension** (`.xyz`, no extension, `Makefile`). Expect plain text rendering and no throw — Prism throws on an unknown grammar if given one.
5. **Scroll past the end of a short file** (press `down` 5000 times on a 12-line file). Expect the offset to clamp at the last line, not run past and render nothing.

---

### Task 1: Capped file reading with binary detection

**Files:**
- Create: `src/viewer/readForView.ts`
- Test: `src/viewer/readForView.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type ViewFile =
    | { kind: "text"; path: string; lines: string[]; truncated: boolean; totalLines: number }
    | { kind: "binary"; path: string }
    | { kind: "error"; path: string; reason: string }

  export const MAX_VIEW_BYTES = 512 * 1024
  export const MAX_VIEW_LINES = 2000

  export function readForView(path: string, limits?: {
    maxBytes?: number
    maxLines?: number
  }): ViewFile
  ```
  `truncated: true` means bytes or lines were dropped. `totalLines` is the count of lines *present*, not of the original file — the reader cannot know the true total without reading everything, and a wrong number in the header is worse than an honest "first 2000 lines".

- [ ] **Step 1: Write the failing test**

Create `src/viewer/readForView.test.ts` using `mkdtempSync`/`writeFileSync` in `tmpdir()` (match the pattern in `FileTree.test.ts`, including pushing every created path to a `created` array cleaned in `afterEach`):

```ts
import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readForView, MAX_VIEW_LINES } from "./readForView"

const created: string[] = []
afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

function makeFile(contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "viewer-"))
  created.push(root)
  const path = join(root, "f.txt")
  writeFileSync(path, contents)
  return path
}

describe("readForView", () => {
  it("reads a small text file into lines", () => {
    const result = readForView(makeFile("one\ntwo\nthree\n"))
    expect(result.kind).toBe("text")
    if (result.kind !== "text") return
    expect(result.lines).toEqual(["one", "two", "three"])
    expect(result.truncated).toBe(false)
  })

  it("reports one line for a file with no trailing newline", () => {
    const result = readForView(makeFile("only"))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["only"])
  })

  it("keeps an interior blank line and drops the trailing one", () => {
    const result = readForView(makeFile("a\n\nb\n"))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["a", "", "b"])
  })

  it("caps lines and says it truncated", () => {
    const result = readForView(makeFile("x\n".repeat(MAX_VIEW_LINES + 50)), { maxLines: 10 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })

  it("does not claim truncation when content fits exactly", () => {
    const result = readForView(makeFile("x\n".repeat(10)), { maxLines: 10, maxBytes: 1_000_000 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.truncated).toBe(false)
  })

  it("caps bytes and says it truncated", () => {
    const result = readForView(makeFile("y".repeat(5000)), { maxBytes: 100, maxLines: 1000 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.truncated).toBe(true)
    expect(result.lines[0]!.length).toBeLessThanOrEqual(100)
  })

  it("detects binary content by a NUL byte", () => {
    const result = readForView(makeFile(Buffer.from([0x41, 0x00, 0x42])))
    expect(result.kind).toBe("binary")
  })

  it("returns an error for a path that does not exist", () => {
    const result = readForView(join(tmpdir(), "definitely-not-here-9f3a"))
    expect(result.kind).toBe("error")
  })

  it("returns an error for a directory rather than throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "viewer-"))
    created.push(root)
    mkdirSync(join(root, "sub"))
    const result = readForView(join(root, "sub"))
    expect(result.kind).toBe("error")
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/viewer/readForView.test.ts`
Expected: FAIL — `Cannot find module './readForView'`.

- [ ] **Step 3: Implement `readForView` in `src/viewer/readForView.ts`**

Synchronous throughout (`readFileSync`, `statSync`), for the runtime reason in Global Constraints. Export `MAX_VIEW_BYTES` and `MAX_VIEW_LINES` as the values above. Read at most `maxBytes`; treat a NUL byte inside the bytes actually read as binary. Split on `\n`, drop one trailing empty element if the text ended with a newline, then slice to `maxLines` and set `truncated` when either cap removed something. Catch every throw and return `{ kind: "error", reason }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/viewer/readForView.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/readForView.ts src/viewer/readForView.test.ts
git commit -m "feat(viewer): read files for display with byte, line and binary caps"
```

---

### Task 2: Prism highlighting, headless

**Files:**
- Modify: `package.json` (add `prismjs` to `dependencies`)
- Create: `src/viewer/highlight.ts`
- Test: `src/viewer/highlight.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type HighlightSpan = { text: string; color?: string }
  export type HighlightedLine = HighlightSpan[]

  /** Tokenizes `code` as `language`, returning one span list per line.
   *  Returns a single plain span per line for an unknown language. */
  export function highlightLines(code: string, language: string | undefined): HighlightedLine[]

  /** Maps a file name to a Prism grammar name, or undefined if unrecognised. */
  export function languageFor(fileName: string): string | undefined
  ```
  Colors are OpenTUI color names (`"cyan"`, `"yellow"`, `"magenta"`, `"green"`, `"dim"`, `undefined` for default) so they match the rest of the plugin and the host theme.

- [ ] **Step 1: Add the dependency**

Run: `bun add prismjs`
Expected: `package.json` `dependencies` gains `"prismjs"`, `bun.lock` updates. Commit the lockfile with this task.

- [ ] **Step 2: Write the failing test**

Create `src/viewer/highlight.test.ts`:

```ts
import { describe, it, expect } from "bun:test"
import { highlightLines, languageFor } from "./highlight"

const flat = (line: { text: string }[]) => line.map((s) => s.text).join("")

describe("languageFor", () => {
  it("maps the extensions this repo is written in", () => {
    expect(languageFor("a.ts")).toBe("typescript")
    expect(languageFor("a.tsx")).toBe("tsx")
    expect(languageFor("a.js")).toBe("javascript")
    expect(languageFor("a.json")).toBe("json")
    expect(languageFor("a.md")).toBe("markdown")
    expect(languageFor("a.py")).toBe("python")
    expect(languageFor("a.css")).toBe("css")
    expect(languageFor("a.sh")).toBe("bash")
  })

  it("returns undefined for anything unrecognised", () => {
    // Review Focus #4: an unknown grammar must not reach Prism, which throws.
    expect(languageFor("a.xyz")).toBeUndefined()
    expect(languageFor("Makefile")).toBeUndefined()
    expect(languageFor("noextension")).toBeUndefined()
  })
})

describe("highlightLines", () => {
  it("returns one span list per line", () => {
    const lines = highlightLines("const a = 1\nconst b = 2", "typescript")
    expect(lines).toHaveLength(2)
    expect(flat(lines[0]!)).toBe("const a = 1")
  })

  it("colours a keyword differently from plain text", () => {
    const lines = highlightLines("const a = 1", "typescript")
    const keyword = lines[0]!.find((s) => s.text.includes("const"))
    expect(keyword?.color).toBeTruthy()
  })

  it("falls back to plain text for an unknown language", () => {
    const lines = highlightLines("hello", "not-a-language")
    expect(lines).toEqual([[{ text: "hello", color: undefined }]])
  })

  it("treats undefined language as plain text", () => {
    expect(highlightLines("hello", undefined)).toEqual([[{ text: "hello", color: undefined }]])
  })

  it("does not throw on content the grammar cannot parse", () => {
    expect(() => highlightLines("}{ unterminated ???", "json")).not.toThrow()
  })

  it("preserves an empty line as an empty span list", () => {
    expect(highlightLines("a\n\nb", "typescript")[1]).toEqual([])
  })

  it("returns nothing for empty input", () => {
    expect(highlightLines("", "typescript")).toEqual([])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/viewer/highlight.test.ts`
Expected: FAIL — `Cannot find module './highlight'`.

- [ ] **Step 4: Implement `highlight.ts`**

Import `Prism` from `"prismjs"` plus individual grammars:
`components/prism-typescript`, `components/prism-tsx`, `components/prism-javascript`, `components/prism-json`, `components/prism-markdown`, `components/prism-python`, `components/prism-css`, `components/prism-bash`.

Add a comment recording *why* individual imports: the autoloader touches `document`, which does not exist here.

`languageFor` switches on the lowercased extension (with `Makefile`/`Dockerfile`-style exact-name handling optional but must return `undefined`, never throw).

`highlightLines` walks `Prism.tokenize(code, Prism.languages[language])` and regroups the flat token stream back into per-line span lists by splitting span text on `\n`. Map token types to colors in one `TOKEN_COLORS: Record<string, string>` object — `comment` and `prolog`/`doctype` to `"dim"`, `keyword` to `"magenta"`, `string` to `"green"`, `number`/`boolean` to `"yellow"`, `function` to `"cyan"`, `operator`/`punctuation` to `undefined`. Anything unmapped gets `undefined`, which renders in the theme default. Wrap the whole body in try/catch and fall back to plain lines on any throw — a grammar that chokes on malformed input must not take the viewer down with it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/viewer/highlight.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Verify Prism survives the build as a bare specifier**

Run: `bun run build && Select-String -Path dist\viewer\highlight.js -Pattern 'from "prismjs"'`
Expected: a match. A missing match means something bundled it; that also works, but note it in the commit.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/viewer/highlight.ts src/viewer/highlight.test.ts
git commit -m "feat(viewer): highlight with Prism's headless tokenizer"
```

---

### Task 3: Scroll math for the viewer

**Files:**
- Create: `src/viewer/scroll.ts`
- Test: `src/viewer/scroll.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  /** Largest legal scroll offset: keeps at least one line on screen. */
  export function maxScroll(totalLines: number, visibleRows: number): number

  /** Offset after a line-step, clamped to [0, maxScroll]. */
  export function scrollByLine(scroll: number, delta: number, totalLines: number, visibleRows: number): number

  /** Offset after a page-step, clamped the same way. */
  export function scrollByPage(scroll: number, direction: -1 | 1, totalLines: number, visibleRows: number): number
  ```
  A half-page is `max(1, floor(visibleRows / 2))`. `visibleRows` below 1 is treated as 1, so a zero-height render area cannot produce a negative max.

- [ ] **Step 1: Write the failing test**

Create `src/viewer/scroll.test.ts`:

```ts
import { describe, it, expect } from "bun:test"
import { maxScroll, scrollByLine, scrollByPage } from "./scroll"

describe("maxScroll", () => {
  it("is zero when everything fits", () => {
    expect(maxScroll(10, 40)).toBe(0)
  })

  it("leaves the last screenful at the bottom", () => {
    expect(maxScroll(100, 40)).toBe(60)
  })

  it("never goes negative for a zero-height area", () => {
    expect(maxScroll(100, 0)).toBe(99)
  })

  it("is zero for an empty file", () => {
    expect(maxScroll(0, 40)).toBe(0)
  })
})

describe("scrollByLine", () => {
  // Review Focus #5: a runaway keypress must clamp, not run off the end.
  it("clamps at the end however far it is pushed", () => {
    expect(scrollByLine(0, 5000, 100, 40)).toBe(60)
  })

  it("clamps at the start for a negative delta", () => {
    expect(scrollByLine(10, -5000, 100, 40)).toBe(0)
  })

  it("moves one line", () => {
    expect(scrollByLine(10, 1, 100, 40)).toBe(11)
  })
})

describe("scrollByPage", () => {
  it("moves half a screen", () => {
    expect(scrollByPage(0, 1, 100, 40)).toBe(20)
  })

  it("moves backwards", () => {
    expect(scrollByPage(20, -1, 100, 40)).toBe(0)
  })

  it("uses at least one line for a tiny viewport", () => {
    expect(scrollByPage(0, 1, 100, 1)).toBe(1)
  })

  it("clamps like the line step", () => {
    expect(scrollByPage(0, 1, 30, 40)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/viewer/scroll.test.ts`
Expected: FAIL — `Cannot find module './scroll'`.

- [ ] **Step 3: Implement `scroll.ts`**

Three pure functions per the signatures. No JSX, no imports — same discipline as `treeLogic.ts`, which exists so navigation can be tested without the host.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/viewer/scroll.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/scroll.ts src/viewer/scroll.test.ts
git commit -m "feat(viewer): pure scroll math for the file view"
```

---

### Task 4: The `FileViewer` component

**Files:**
- Create: `src/viewer/FileViewer.tsx`
- Test: `src/viewer/FileViewer.test.ts`

**Interfaces:**
- Consumes: `readForView` → `ViewFile` (Task 1), `highlightLines` → `HighlightedLine[]` and `languageFor` → `string | undefined` (Task 2), `scrollByLine`/`scrollByPage`/`maxScroll` (Task 3), plus `Theme` from the host context for colors.
- Produces:
  ```ts
  export type FileViewerProps = {
    path: string
    /** Rows available for content, excluding the header and the gutter. */
    height: number
    theme: Theme
    context: Context
  }
  export const FileViewer: Component<FileViewerProps>
  export const VIEWER_ROWS_CHROME = 2 // header + gutter allowance
  ```
  The component owns `scroll` as a `createSignal<number>` and exposes no commands — Task 5 owns the keymap and needs a way to drive the offset, so `FileViewer` accepts an optional `scrollTo?: (fn: (prev: number) => number) => void` prop that Task 5 populates. Record in a comment why the offset lives inside the component while the keys live outside.

- [ ] **Step 1: Write the failing test**

Create `src/viewer/FileViewer.test.ts`. Mount through the stub JSX like `FileTree.test.ts` does — build a `context` with `renderer: { height, requestRender, currentFocusedRenderable: null }`, `location`, `data`, `storage.memory`, and `ui.format.path`, then call `(FileViewer as any)({ path, height, theme, context })` and walk `props.children` to find the row `<text>` elements. Assert on rendered row text:

```ts
// Cases:
//  - renders one row per visible line, with line numbers in the gutter
//  - shows a header carrying the file name and the line count
//  - says so when the file was truncated
//  - renders a readable message for kind "error"   (Review Focus #1)
//  - renders a readable message for kind "binary"  (Review Focus #1)
//  - renders plain rows for an unrecognised extension (Review Focus #4)
//  - asks the renderer for a frame when the scroll offset changes
//  - scrollTo(2) renders the window starting two lines down
```

Write these as real assertions using the values from Task 1–3; do not leave them as comments.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/viewer/FileViewer.test.ts`
Expected: FAIL — `Cannot find module './FileViewer'`.

- [ ] **Step 3: Implement `FileViewer.tsx`**

```tsx
<box flexDirection="column" ref={props.onRoot}>
  <text fg="dim" wrapMode="none" truncate>{header}</text>
  <Show when={file.kind === "text"} fallback={<text fg="dim">{messageFor(file)}</text>}>
    <For each={rows}>{(row) => <text ...>{row}</text>}</For>
  </Show>
</box>
```

Read with `readForView(props.path)` in the component body (synchronous). Tokenize with `highlightLines(lines.join("\n"), languageFor(path))` once, guarded so a throw cannot escape. Keep the plain text alongside the spans so the gutter can be built without walking tokens. Rows come from `lines.slice(scroll, scroll + visibleRows)`. The header carries the file name, the visible line range, and `— first N lines` when truncated. Join `scrollTo` if provided.

Add a `createEffect` that reads every visible input and calls `context.renderer.requestRender()` — same comment as `FileTree`'s repaint effect, and the same obligation.

Rows use `wrapMode="none"` and `truncate`, matching `TreeNode.tsx`; a wrapped code line would break the one-row-per-line mapping the gutter depends on.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/viewer/FileViewer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `bun test`
Expected: all pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/viewer/FileViewer.tsx src/viewer/FileViewer.test.ts
git commit -m "feat(viewer): render a file with a gutter, header and truncation notice"
```

---

### Task 5: Wire `enter` to the viewer and drop the external editor

**Files:**
- Modify: `src/commands.ts` (replace `openInEditor` with `openInViewer`)
- Modify: `src/commands.test.ts`
- Modify: `src/tui.tsx` (panel claim, viewer keymap layer, `nav.open`)
- Modify: `src/tui.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `FileViewer` and `VIEWER_ROWS_CHROME` (Task 4).
- Produces: `TreeCommandsDeps.openInViewer: (entry: DirEntry) => void` replacing `openInEditor`; `TreeCommands.open: () => void` (no longer returns a promise).

- [ ] **Step 1: Write the failing tests**

In `src/commands.test.ts`, replace the editor tests. `spawnEditor`, `parseEditorCommand` and `EditorResult` are deleted, so their tests go too:

```ts
//  - open() on a file calls openInViewer with that entry
//  - open() on a directory toggles expansion and does NOT call openInViewer
//  - open() with no cursor entry does nothing
```

In `src/tui.test.ts`:

```ts
//  - claims session.panel as well as sidebar.content
//  - enter on a file opens the viewer panel and does not spawn anything
//  - esc closes the viewer panel
//  - the viewer layer is off until a file is opened
//  - the viewer layer has priority > 0            (Global Constraints)
//  - the viewer layer's gate is plugin state, not renderer focus
//  - up/down/pageup/pagedown adjust the scroll offset and nothing else
```

`createMockContext` needs `ui.panel` (`open`/`close`/`current`) and a `ui.slot` that records the `session.panel` claim — it currently assumes `slots[0]` is the sidebar.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/commands.test.ts src/tui.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Rewire `commands.ts`**

Delete `parseEditorCommand`, `spawnEditor`, `EditorResult` and the `spawnEditor` import. Change `TreeCommandsDeps.openInEditor: (entry) => Promise<EditorResult>` to `openInViewer: (entry: DirEntry) => void`. `open()` returns `void`: call `deps.openInViewer(entry)` for a file, `toggle()` for a directory. Add a comment recording that the external-editor path was removed on request and where the code went, so it is not re-added blind.

- [ ] **Step 4: Rewire `tui.tsx`**

Add a second slot claim, `append: "session.panel"`, rendering `<Show>` only when `input.name === VIEWER_PANEL`. Track `viewerPath` and `viewerOpen` as plugin-owned booleans/signals — never gated on focus.

Replace `nav.open` with a call that sets `viewerPath` to the current entry's path, calls `context.ui.panel.open(VIEWER_PANEL)`, and sets `viewerOpen = true`.

Register a viewer keymap layer: `enabled: () => viewerOpen`, `priority: 10`, binding `up`/`down` to `scrollByLine(±1)`, `pageup`/`pagedown` to `scrollByPage(±1)`, and `escape` to close the panel and clear `viewerOpen`.

Where the tree's own `up`/`down` layer binds the same keys, the viewer layer must outrank it — the viewer layer's `priority: 10` plus its `enabled` gate only while open is what makes that true. Assert it in the test above so a future edit cannot quietly break the ordering.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test`
Expected: all pass, 0 fail.

- [ ] **Step 6: Update the README**

Replace the "open in `$EDITOR`" wording with the viewer. Add a note that the plugin now has a runtime dependency and needs `bun install` before the build will work. Document `enter`, `↑`/`↓`, `pageup`/`pagedown`, `esc`.

- [ ] **Step 7: Build and commit**

Run: `bun run typecheck && bun run build`
Expected: both clean.

```bash
git add src/commands.ts src/commands.test.ts src/tui.tsx src/tui.test.ts README.md
git commit -m "feat(viewer): enter opens the in-terminal viewer, drop the external editor"
```

---

### Task 6: Remove the temporary tracing

**Files:**
- Delete: `src/trace.ts`
- Modify: `src/tui.tsx`, `src/FileTree.tsx` (drop `trace(...)` calls and the now-unused `focusHolder` helpers)

**Interfaces:**
- Consumes: nothing. Produces: nothing.
- Traces are still load-bearing for the unverified arrow-key fix on `sidebar-placement`. Do this task only after the user has confirmed `↑`/`↓` move the tree cursor, and say so if that has not happened.

- [ ] **Step 1: Delete `src/trace.ts` and every call site**

Search for `trace(` in `src/`; remove all of them. Remove the now-unused `focusHolder` helpers in both files, and the `keysHeld`/`withinTree`/`holder` fields that existed only to feed the trace.

- [ ] **Step 2: Run the suite, typecheck and build**

Run: `bun test && bun run typecheck && bun run build`
Expected: all clean.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove the temporary shortcut tracing"
```

---

## Live Verification (not automatable)

The test stubs model none of the host behaviour this feature depends on. After the final task, verify by hand and report what was actually observed:

1. `bun install` has run; `bun run build` is clean.
2. Restart OpenCode fully (hot reload watches the shim, not `dist/`).
3. `ctrl+y` focuses the tree, `↑`/`↓` move its cursor.
4. `enter` on a source file opens the panel, coloured, with a gutter.
5. `↑`/`↓`/`pageup`/`pagedown` scroll; `esc` closes and returns keys to the tree.
6. Open a large file and confirm the truncation notice, and that the TUI does not visibly stall.
7. Open a binary file and confirm a readable message rather than a crash.