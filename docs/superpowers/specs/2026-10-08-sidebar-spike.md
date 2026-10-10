# Spike: file tree in the session sidebar

**Branch:** `sidebar-placement` — throwaway, not a decision to keep.

**Question:** can the tree live in the main sidebar (below the "Context" card)
instead of a side panel, so it is always visible and never changes the layout?

## What the probe changes

- The slot claim moves from `session.panel` to `sidebar.content`. The host's own
  sidebar plugins register first, so the appended claim renders **below the
  "Context" card**, where asked.
- Keyboard gating moves from `panel.current()` to **focus**: the nav layer is
  enabled exactly while `renderer.currentFocusedRenderable` is the tree's root
  box or a descendant of it. Click a row to focus the tree; `esc` (or clicking
  elsewhere) hands the keyboard back.
- `ctrl+y` now *focuses* the tree (or blurs it when it already has focus) —
  there is nothing to open or close. (`ctrl+e` was tried first and silently did
  nothing: the host binds it as `input.line.end`, so the prompt editor consumed
  it. `ctrl+y` appears nowhere in the host's keybind map.)
- FileTree's existing repaint effect (`renderer.requestRender()`) is untouched;
  it is renderer-global, so it covers the sidebar too. This is the piece the
  original sidebar attempt lacked.

## How to test live

Build and install this branch the usual way (`bun run build`, then the plugin
shim in `~/.config/opencode/plugins/filetree/` pointing at this checkout's
`dist/tui.js`), restart OpenCode, open any session.

## What to look for

1. **Renders** below the "Context" card, with the git-status colors from the
   panel build still correct.
2. **Repaints**: move the cursor and confirm the `›` marker follows immediately;
   touch a file on disk (`echo x >> somefile`) and confirm rows re-read and
   status colors update — with the tree *unfocused*.
3. **Input scoping**:
   - click a row, then arrows/enter/`s`/`r` drive the tree;
   - with the tree focused, the **session list cursor does not move** on
     up/down, and the **prompt does not receive** those keys;
   - click back into the prompt / session list: arrows must behave normally
     again (the tree's layer is disabled);
   - `esc` returns focus to wherever it was.
4. **Layout feel**: the sidebar is one scroll container — expand a deep tree
   and watch what happens to the session list and Context card. Is the shared
   scrolling acceptable, or does the tree push everything else out of reach?
5. **Long names**: the sidebar is 42 columns. Are paths/names readable, or do
   they truncate to uselessness?

## Known unknowns / risks

- The host routes keys to the focused renderable; whether keymap *layers* also
  resolve while our box is focused is the main thing to verify (point 3). The
  panel build worked with a pure `enabled` gate, so the same shape is expected
  to work, but it is unproven for the sidebar.
- The tree's viewport windowing still uses full terminal height; in the sidebar
  it can be taller than the visible area and relies on the sidebar scrolling.

## Findings

_(filled in after the live run)_
