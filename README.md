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

Modified, added, and untracked files are marked `[M]`, `[A]`, and `[?]`. Git
status is read with `git status --porcelain` and is skipped outside a git
repository.

## Development

```
bun test          # 51 tests
bun run typecheck # tsc --noEmit
bun run build     # compile to dist/
```

`src/commands.ts` holds the keymap behaviour and is tested without a TUI;
`src/tui.tsx` is the thin OpenCode plugin entry that wires those commands to
keybinds.