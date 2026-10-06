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

The tree is always visible in the sidebar. It is driven by the mouse:

| Action | How |
|--------|-----|
| Select a row | Click it |
| Expand / collapse a folder | Click it |

The selected row is marked with `›`.

The tree also re-reads itself when files change on disk.

## No keyboard bindings

The plugin registers **no** keys at all, on purpose.

Keyboard navigation was implemented and removed. The keys arrived correctly and
the tree's state updated correctly — a diagnostic log showed the cursor moving
from index 0 to 1 and the clamp effect re-running on every change — but OpenCode
2.0.24 never repainted the updated rows. Nothing about the tree's logic was at
fault; the host does not repaint plugin components in response to keymap
commands in this build.

Two earlier approaches made things worse and are recorded in the git history:

- **Pushing an input mode** (`keymap.mode.push`) took over the host's key
  routing entirely. Afterwards no key reached anything, and only clicking the UI
  recovered.
- **Moving renderer focus** to the tree delivered the keys but left the prompt
  without its cursor, with a delay before typing worked again.

A mouse event makes the host render a frame, so clicks are reliable where
keymap commands were not. Registering no keymap layer also means the plugin
cannot interfere with typing or with any key you use.

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