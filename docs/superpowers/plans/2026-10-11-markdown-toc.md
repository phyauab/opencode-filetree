# Plan: Markdown TOC Sidebar

## Goal
Add a table-of-contents sidebar to the markdown viewer that shows all section headings, highlights the active section, and supports keyboard navigation (alt+up/down) to jump between sections.

## Context
- The viewer is a fullscreen overlay in `src/viewer/FileViewer.tsx`
- Markdown is currently rendered via `MarkdownRenderable` (a black box that doesn't expose heading positions)
- The previous attempt at this feature was reverted because heading positions couldn't be mapped to scroll rows
- We're replacing `MarkdownRenderable` with a custom renderer that tracks positions
- Using `marked` library for parsing (battle-tested, 35k+ stars, synchronous API)

## Global Constraints
- SolidJS with JSX (compiled by babel-preset-solid, never tsc)
- OpenTUI renderer is demand-driven: every state change must call `context.renderer.requestRender()`
- Test stubs are honest: JSX builds `{type, props}` descriptions, `@opentui/core` is mocked
- Comments explain *why*, in full sentences
- Viewer layout: `flexDirection="row"` outer wrapper, `flexDirection="column"` content box
- Never gate keys on renderer focus; use plugin-owned state signals

## Tasks

### Task 1: Add `marked` dependency and create markdown parser utilities
**Files:**
- `package.json` — add `marked` dependency
- `src/viewer/markdownParser.ts` — new file

**Requirements:**
- Install `marked` (latest stable)
- Create `parseMarkdown(source: string): MarkdownBlock[]` that uses `marked.lexer()` to parse source into structured blocks
- Each block: `{ type: 'heading' | 'paragraph' | 'code' | 'list' | 'blockquote' | 'table' | 'hr' | 'html', level?: number, text?: string, tokens?: Token[], raw: string }`
- Create `extractHeadings(blocks: MarkdownBlock[]): HeadingInfo[]` that extracts heading info: `{ text: string, level: number, blockIndex: number }`
- Create `renderInline(inlineTokens: Token[]): InlineSpan[]` that converts marked inline tokens to renderable spans: `{ text: string, bold?: boolean, italic?: boolean, code?: boolean, link?: string }`
- Unit tests in `src/viewer/markdownParser.test.ts`

### Task 2: Create the custom markdown block renderer
**Files:**
- `src/viewer/MarkdownContentView.tsx` — new file

**Requirements:**
- Create a SolidJS component `MarkdownContentView` that takes `blocks: MarkdownBlock[]`, `contentWidth: number`, `syntaxStyle: SyntaxStyle`, and `onHeadingPositions: (positions: Map<number, number>) => void`
- Renders each block as terminal rows:
  - Headings: styled text (bold, colored by level), 1 row
  - Paragraphs: text with word-wrapping at `contentWidth`, N rows
  - Code blocks: use Prism syntax highlighting (reuse existing `highlightLines` from `highlight.ts`), N rows
  - Lists: items with markers (`- ` or `1. `), wrapped, N rows
  - Blockquotes: `>` prefix, wrapped, N rows
  - Tables: ASCII table with `|` separators, N rows
  - HR: `─` repeated to contentWidth, 1 row
- Tracks cumulative row count as it renders each block
- Calls `onHeadingPositions` with a map of `headingIndex -> startRow` whenever blocks or contentWidth changes
- Uses `createEffect` to call `context.renderer.requestRender()` when visible signals change
- Unit tests in `src/viewer/MarkdownContentView.test.ts`

### Task 3: Create TOC utilities
**Files:**
- `src/viewer/toc.ts` — new file

**Requirements:**
- Create `calculateHeadingPositions(blocks: MarkdownBlock[], contentWidth: number): Map<number, number>` — returns map of heading index to start row
- Create `findActiveHeading(positions: Map<number, number>, scrollOffset: number): number` — returns index of the last heading whose start row <= scrollOffset
- Create `findNextHeading(positions: Map<number, number>, currentIndex: number): number | null` — returns index of next heading
- Create `findPrevHeading(positions: Map<number, number>, currentIndex: number): number | null` — returns index of previous heading
- Pure functions, no side effects
- Unit tests in `src/viewer/toc.test.ts`

### Task 4: Integrate TOC sidebar into FileViewer
**Files:**
- `src/viewer/FileViewer.tsx` — modified
- `src/viewer/markdown.ts` — modified (add `marked`-based parsing, keep existing `buildSyntaxStyle`)

**Requirements:**
- Replace `<markdown content={...} />` with `<MarkdownContentView>` for markdown files
- Parse markdown source using `parseMarkdown` from Task 1
- Create TOC sidebar box to the right of content:
  - Width: 30 columns (or dynamic based on longest heading, capped at 40)
  - Shows all headings indented by level (2 spaces per level)
  - Highlights active heading (reverse video or bright color)
  - Auto-scrolls to keep active heading visible
- Wire `onHeadingPositions` callback to track heading positions
- Track active heading based on scroll offset using `findActiveHeading`
- Handle terminal resize: recalculate positions when contentWidth changes
- Keep existing code file path (Prism) unchanged
- Update `src/viewer/FileViewer.test.ts` with tests for the new sidebar

### Task 5: Add keyboard navigation
**Files:**
- `src/tui.tsx` — modified

**Requirements:**
- Add `alt+down` binding: jump to next heading (using `findNextHeading`)
- Add `alt+up` binding: jump to previous heading (using `findPrevHeading`)
- Only active when viewer is open and showing a markdown file
- Uses existing keymap layer (priority 20)
- After jumping, scrolls to the heading's recorded row position
- Add tests for the new key bindings

### Task 6: Integration tests and polish
**Files:**
- `src/viewer/FileViewer.test.ts` — additional tests

**Requirements:**
- Integration test: open a markdown file, verify TOC shows headings, simulate scroll, verify active heading updates
- Integration test: press alt+down, verify scroll jumps to next heading
- Integration test: press alt+up, verify scroll jumps to previous heading
- Integration test: resize terminal, verify heading positions recalculate
- Integration test: click TOC item, verify scroll jumps to that heading
- Verify no regressions in code file viewing path
- Run full test suite
