# opencode-filetree

A file tree panel for the OpenCode TUI sidebar. Navigate your project with the
arrow keys, open files in your editor.

## Install

Build the plugin, then register it in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///C:/path/to/opencode-filetree"]
}
```

Build with:

```
bun install
bun run build
```

For local development, point the config at the checkout and OpenCode will load
it directly:

```json
{
  "plugin": ["file:///C:/path/to/opencode-filetree/dist/tui.js"]
}
```

## Usage

Press `ctrl+f` to focus the file tree. While it has focus:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection |
| `→` | Expand folder |
| `←` | Collapse folder |
| `enter` | Open file in `$EDITOR` (defaults to `code`) |
| `ctrl+o` | Send the file path to the current session |
| `r` | Refresh the tree |
| `escape` | Return focus to the prompt |

The tree is always visible in the sidebar; only the keyboard focus moves.

## Files with git changes

Modified, added, deleted, and untracked files are marked `[M]`, `[A]`, `[D]`, and
`[?]`, with the status spelled out alongside. Git status is read with
`git status --porcelain -z` and is skipped outside a git repository.

Directories the tree skips by default: `node_modules`, `.git`, `dist`, `build`,
`out`, `.next`, `.turbo`, `.cache`, `__pycache__`, `.venv`, and any
dot-directory. Dotfiles like `.gitignore` and `.env` stay visible.

## When something goes wrong

A directory that cannot be read — no permission, or deleted while open — shows
its reason inline instead of taking down the TUI. If `$EDITOR` cannot be
spawned, or a file cannot be sent to the session, you get an error toast rather
than a crash.

## Development

```
bun test          # 112 tests
bun run typecheck # tsc --noEmit
bun run build     # compile to dist/
```

`src/commands.ts` and `src/loader.ts` hold the behaviour and are tested without
a TUI; `src/tui.tsx` is the thin OpenCode plugin entry that wires those
commands to keybinds.

| File | Role |
|------|------|
| `src/tui.tsx` | Plugin entry: sidebar slot, keymap layers, input mode |
| `src/FileTree.tsx` | Tree component and pure traversal logic |
| `src/commands.ts` | Keymap behaviour, editor spawn, session prompt |
| `src/store.ts` | Reactive tree state and cursor clamping |
| `src/loader.ts` | Directory loading that never rejects |
| `src/fileSystem.ts` | `readDir`, `watch`, git status parsing |
| `src/fileTreeData.ts` | Hidden-entry filtering, error messages |
| `src/icons.ts` | Icons, git status labels, hidden-directory rules |
| `src/TreeNode.tsx` | One row of the tree |