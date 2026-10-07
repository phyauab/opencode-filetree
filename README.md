# opencode-filetree

A file tree panel for the OpenCode TUI sidebar. Navigate your project with the
arrow keys, open files in your editor.

## Install

```
bun install
bun run build
```

Then create `~/.config/opencode/plugins/filetree/` containing:

`tui.ts`

```ts
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport()

const mod = await import("/absolute/path/to/opencode-filetree/dist/tui.js")

export default mod.default
```

`package.json`

```json
{
  "name": "filetree-plugin-shim",
  "private": true,
  "type": "module",
  "dependencies": { "@opentui/solid": "0.5.14" }
}
```

Then run `bun install` in that directory and restart OpenCode. `opencode
plugin list` should show the plugin as `local`.

### Why the shim exists

OpenCode's V2 loader imports external plugins without first initialising OpenTUI
runtime plugin support, so plugin JSX gets a different `RendererContext` than the
host's and every element throws `No renderer found`
([anomalyco/opencode#37836](https://github.com/anomalyco/opencode/issues/37836)).
`ensureRuntimePluginSupport()` installs the hook that redirects the bundle's
imports onto the host's runtime.

OpenCode rewrites a fixed list of bare specifiers and
`@opentui/solid/runtime-plugin-support/configure` is not on it, which is why
`@opentui/solid` must be installed next to the shim.

### Build details that matter

- The bundle ships **no** copy of `solid-js` or `@opentui/solid`. Duplicates mean
  separate Solid context objects, which break the same way.
- Relative imports in `dist/` carry explicit `.js` extensions. Extensionless
  imports bypass OpenCode's specifier rewrite.

## Usage

Open the file tree panel from the command palette (`ctrl+p`, **File tree**, in the
"File tree" group) or the suggested list.

While the panel is open the host owns its input, so these keys go to the tree:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection |
| `→` | Expand folder |
| `←` | Collapse folder |
| `r` | Refresh |
| `esc` | Close the panel |

The selected row is marked with `›`. The tree also re-reads itself when files
change on disk.

## Why a panel and not the sidebar

This plugin originally rendered into the `sidebar.content` slot and registered
its own keymap layer. That does not work, and the reason is worth recording.

OpenCode documents `session.panel` as the surface for interactive plugin UI:
*"The host owns sizing, focus, and full-screen presentation."* The sidebar slot
carries only a `sessionID` — the plugin gets no ownership of input, focus, or
repaints.

Diagnostics proved the sidebar approach was a dead end. A trace file written by
the plugin showed, over a real session:

```
{"event":"row-click","index":1,"name":"superpowers","before":0}
{"event":"row-click-after","index":1,"after":1}
```

Every one of 28 clicks registered, the cursor updated correctly, and clicking a
folder really did expand it (the visible row count went 16 → 41). The panel just
never repainted to show it. The same held for keyboard input: keys arrived and
state changed, nothing was drawn.

Pushing an input mode made it worse — it took over the host's key routing, and
afterwards no key reached anything until the user clicked the UI. Moving renderer
focus took the prompt's cursor away and delayed typing on the way back. Both are
in the git history.

The panel slot exists precisely so the host drives rendering and input for
interactive plugin content, and a keymap layer created inside the panel component
is active only while the panel owns input.

## Files with git changes

Modified, added, deleted, and untracked files are marked `[M]`, `[A]`, `[D]`, and
`[?]`, with the status spelled out alongside. Git status is read with
`git status --porcelain -z` and is skipped outside a git repository.

Directories the tree skips by default: `node_modules`, `.git`, `dist`, `build`,
`out`, `.next`, `.turbo`, `.cache`, `__pycache__`, `.venv`, and any
dot-directory. Dotfiles like `.gitignore` and `.env` stay visible.

## Remembering your layout

Which folders you had open is remembered per project, so restarting OpenCode
returns the tree to the shape you left it. Folders that have since been deleted
are dropped from the remembered layout rather than restored as broken rows.

## Large trees

Only the rows that fit the sidebar are rendered, and the view follows the cursor
as you move. Projects with thousands of files scroll the same as small ones; the
"more above/below" hints tell you when the tree extends past the window.

## When something goes wrong

A directory that cannot be read — no permission, or deleted while open — shows
its reason inline instead of taking down the TUI. If `$EDITOR` cannot be
spawned, or a file cannot be sent to the session, you get an error toast rather
than a crash.

## Development

```
bun test          # 160 tests
bun run typecheck # tsc --noEmit
bun run build     # compile to dist/
```

Everything except `src/tui.tsx` and `src/FileTree.tsx` is free of TUI and
OpenTUI imports, so it is tested directly. `src/tui.tsx` is the thin plugin
entry that wires commands to keybinds; `src/FileTree.tsx` is the only component
that touches the terminal's dimensions.

| File | Role |
|------|------|
| `src/tui.tsx` | Plugin entry: sidebar slot, keymap layers, input mode |
| `src/FileTree.tsx` | Tree component, pure traversal logic, windowing |
| `src/commands.ts` | Keymap behaviour, editor spawn, session prompt |
| `src/store.ts` | Reactive tree state, cursor clamping, viewport |
| `src/viewport.ts` | Window calculation that keeps the cursor on screen |
| `src/persist.ts` | Layout serialization and storage keys |
| `src/layoutSync.ts` | When to restore and what to persist |
| `src/loader.ts` | Directory loading that never rejects |
| `src/fileSystem.ts` | `readDir`, `watch`, git status parsing |
| `src/fileTreeData.ts` | Hidden-entry filtering, error messages |
| `src/icons.ts` | Icons, git status labels, hidden-directory rules |
| `src/TreeNode.tsx` | One row of the tree |