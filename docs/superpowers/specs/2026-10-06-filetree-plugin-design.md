# Filetree Sidebar Plugin — Design Spec

**Date:** 2026-10-06
**Status:** Draft

## Overview

An OpenCode TUI plugin that renders a navigable file tree in the sidebar. Users browse their project's file system with IntelliJ-style keyboard navigation and open files into their session or editor.

## Architecture

Standard OpenCode TUI plugin using `@opencode/plugin/tui` with SolidJS components (OpenTUI). The plugin registers into the `sidebar.content` slot and handles keyboard input through a keymap layer targeted at the sidebar.

### File Structure

```
filetree/
├── src/
│   ├── tui.ts          # Plugin entry — registers sidebar slot + keymap
│   ├── FileTree.tsx    # Main tree component
│   ├── TreeNode.tsx    # Individual node renderer
│   ├── fileSystem.ts   # Directory reading, watching, path utils
│   └── icons.ts        # File/folder icons + git status indicators
├── package.json
└── tsconfig.json
```

## Components

### `tui.ts` — Plugin Entry

- Calls `context.ui.slot({ append: "sidebar.content" })` to mount `<FileTree />`.
- Registers a keymap layer targeted at the sidebar with the navigation bindings below.
- Returns a cleanup function that unsubscribes from file system watchers.

### `FileTree.tsx` — Root Component

- Reads `context.location.directory` reactively.
- Calls `fileSystem.readDir()` on mount and whenever the directory changes.
- Manages expanded/collapsed state per directory path, persisted via `context.storage`.
- Maintains a flat list of visible nodes (based on expand state) and a cursor index for selection.
- Renders visible nodes with a scroll window that follows the cursor.
- Sets up `fs.watch` on the project root for auto-refresh.

### `TreeNode.tsx` — Node Renderer

- Renders a single row: indent guide, expand/collapse chevron (folders), icon, name, git status indicator.
- Highlights the selected row.
- Folders display `▸`/`▾` for collapsed/expanded state.

### `fileSystem.ts` — File System Service

Pure functions:

- `readDir(path)` — returns sorted entries (folders first, then files, alphabetical within each group).
- `watch(path, callback)` — sets up `fs.watch` recursively, returns unsubscribe function.
- `isGitRepo(path)` — checks for `.git` directory.
- `getGitStatus(path)` — runs `git status --porcelain`, returns a map of file paths to status codes.
- `resolvePath(base, relative)` — safely resolves a path within the project.

### `icons.ts` — Icon Mapping

- Maps file extensions to Unicode symbols (e.g., `📄` for `.ts`, `📁` for folders).
- Git status indicators: `M` (modified), `A` (added), `?` (untracked).

## Keymap

| Key | Action |
|-----|--------|
| `↑` / `↓` | Move selection up/down |
| `→` | Expand folder (or move into it if already expanded) |
| `←` | Collapse folder (or jump to parent if already collapsed) |
| `Enter` | Open file in `$EDITOR` |
| `ctrl+o` | Send file path to current session as a prompt |
| `r` | Refresh tree (re-read directory) |

## Data Flow

```
Plugin setup
  → register sidebar slot
    → <FileTree /> mounts
      → reads context.location.directory
        → fileSystem.readDir() → renders nodes
          → user presses ↑/↓ → keymap moves cursor
          → user presses →/← → toggle expand/collapse
          → user presses Enter → open file in $EDITOR
          → user presses ctrl+o → send path to session
          → fs.watch fires → re-read directory → tree updates
```

## Key Decisions

- **Opening files:** `enter` opens the file in `$EDITOR` (the user's configured external editor). `ctrl+o` sends the file path to the current session as a prompt (e.g., "Read {path}") so the agent can work with it.
- **Git status:** Shows modified/added/untracked indicators by running `git status --porcelain` and matching paths. Only active if `.git` exists in the project root.
- **Expanded state:** Persisted per-directory via `context.storage` so the tree remembers your layout across restarts.
- **Lazy loading:** Directory contents are only read when a folder is expanded, not on initial render. The root directory is expanded by default.
- **Scroll window:** Only visible nodes are rendered. The viewport scrolls to keep the cursor in view.

## Error Handling

- Permission-denied directories show a "permission denied" row instead of crashing.
- Deleted files/directories are handled gracefully — the watch event triggers a re-read; missing entries are filtered out.
- Git commands fail silently (no git repo = no indicators).
- Non-existent project directory shows an empty state message.

## Testing

- **Unit tests** for `fileSystem.ts`: sorting logic, path resolution, git status parsing.
- **Unit tests** for tree navigation: cursor movement, expand/collapse, scroll window calculation.
- **Integration:** load the plugin in OpenCode, verify the tree renders, navigates, and opens files correctly.

## Out of Scope

- File creation, renaming, or deletion from the panel.
- Fuzzy search or filtering.
- Multi-root worktree support.
- Drag-and-drop.
- Full-screen panel mode (potential future enhancement).
