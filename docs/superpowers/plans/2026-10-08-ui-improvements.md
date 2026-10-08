# UI Improvements — Task List

Three user-requested improvements to the filetree plugin.

## 1. Visual indication for modified files
- [x] `src/icons.ts`: add `gitStatusColor(status)` — M=yellow, A=green, D=red, ?=cyan, R=magenta
- [x] `src/TreeNode.tsx`: apply the color as `fg` (selection `cyan` still wins)
- [x] Tests: `src/icons.test.ts` (color mapping), new `src/TreeNode.test.ts` (row fg, selection wins)

## 2. Keyboard shortcut for the panel
- [x] `src/tui.tsx`: `bind: "ctrl+e"` on `filetree.toggle` (free per host default keybinds)
- [x] Tests: replaced "binds no key" test with "binds ctrl+e" in `src/tui.test.ts`
- [x] README: usage section

## 3. Panel width (host-owned — no API)
- [x] README: "Panel width" section — drag left edge, persists, double-click resets, 42 cols ≈ sidebar

## Verification
- [x] `bun test` green (264 pass), `bun run typecheck` green, `bun run build` green
- [x] dist verified: `bind: "ctrl+e"` in tui.js, `gitStatusColor` in TreeNode.js/icons.js
