# Filetree Sidebar Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenCode TUI plugin that renders an IntelliJ-navigable file tree in the sidebar, with arrow-key navigation and Enter-to-open-in-editor.

**Architecture:** Standard OpenCode TUI plugin (`@opencode/plugin/tui`) with SolidJS components. Registers into `sidebar.content` slot. File system is read reactively with `fs.watch` for auto-refresh. Keyboard input handled via a keymap layer targeted at the sidebar.

**Tech Stack:** TypeScript, SolidJS, OpenTUI (`@opentui/solid`), Node.js `fs` module, OpenCode plugin SDK (`@opencode/plugin/tui`).

**Spec:** `docs/superpowers/specs/2026-10-06-filetree-plugin-design.md`

## Global Constraints

- Plugin ID: `filetree`
- Package name: `opencode-filetree`
- Module type: ESM (`"type": "module"`)
- OpenCode TUI import: `@opencode/plugin/tui` (resolved at runtime by OpenCode)
- OpenTUI peers: `@opentui/core >=0.5.8`, `@opentui/solid >=0.5.8`, `solid-js >=1.9.0`
- All file paths in the plugin are relative to `context.location.directory`
- Git status is best-effort — fail silently if not a git repo
- Expanded folder state persists across restarts via `context.storage`

## Review Focus

- **Large directories** (1000+ entries): lazy-load only when expanded; don't read contents of collapsed folders
- **Permission-denied directories**: show "permission denied" row, don't crash
- **Deleted files while navigating**: watch event triggers re-read; filter missing entries gracefully
- **Non-git projects**: git status commands fail silently; no indicators shown
- **Narrow terminal**: sidebar width is limited; truncate long file names with ellipsis

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/tui.ts` (stub)

**Interfaces:**
- Consumes: nothing
- Produces: `Plugin` export from `src/tui.ts` with `id: "filetree"`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "opencode-filetree",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/tui.ts",
    "./tui": "./src/tui.ts"
  },
  "dependencies": {
    "@opencode/plugin": "latest"
  },
  "peerDependencies": {
    "@opentui/core": ">=0.5.8",
    "@opentui/solid": ">=0.5.8",
    "solid-js": ">=1.9.0"
  },
  "devDependencies": {
    "typescript": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "strict": true,
    "outDir": "dist",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create plugin stub `src/tui.ts`**

```typescript
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    // TODO: register sidebar slot
  },
})
```

- [ ] **Step 4: Install dependencies**

Run: `bun install`
Expected: `node_modules/` created, no errors

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json src/tui.ts
git commit -m "chore: scaffold filetree plugin project"
```

---

### Task 2: File System Service

**Files:**
- Create: `src/fileSystem.ts`
- Create: `src/fileSystem.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `readDir(path: string): Promise<DirEntry[]>` — sorted entries (folders first, then files, alphabetical)
  - `DirEntry = { name: string; path: string; isDirectory: boolean }`
  - `watch(path: string, callback: () => void): () => void` — returns unsubscribe
  - `isGitRepo(path: string): Promise<boolean>`
  - `getGitStatus(path: string): Promise<Map<string, string>>` — maps relative path to status code
  - `resolvePath(base: string, relative: string): string`

- [ ] **Step 1: Write failing tests for `readDir` sorting**

```typescript
import { describe, it, expect } from "bun:test"
import { readDir } from "./fileSystem"

describe("readDir", () => {
  it("sorts folders before files, alphabetically within each group", async () => {
    // Create a temp dir with mixed entries
    const dir = await mkdtemp(join(tmpdir(), "filetree-test-"))
    await writeFile(join(dir, "zebra.txt"), "")
    await writeFile(join(dir, "apple.txt"), "")
    await mkdir(join(dir, "beta"))
    await mkdir(join(dir, "alpha"))

    const entries = await readDir(dir)
    const names = entries.map((e) => e.name)
    expect(names).toEqual(["alpha", "beta", "apple.txt", "zebra.txt"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/fileSystem.test.ts`
Expected: FAIL — `readDir` not defined

- [ ] **Step 3: Implement `readDir` in `src/fileSystem.ts`**

```typescript
import { readdir } from "node:fs/promises"
import { join } from "node:path"

export type DirEntry = {
  name: string
  path: string
  isDirectory: boolean
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const items = await readdir(path, { withFileTypes: true })
  const entries: DirEntry[] = items.map((item) => ({
    name: item.name,
    path: join(path, item.name),
    isDirectory: item.isDirectory(),
  }))
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}
```

- [ ] **Step 4: Implement `watch` in `src/fileSystem.ts`**

```typescript
import { watch as fsWatch } from "node:fs"

export function watch(path: string, callback: () => void): () => void {
  const watcher = fsWatch(path, { recursive: true }, callback)
  return () => watcher.close()
}
```

- [ ] **Step 5: Implement `isGitRepo` in `src/fileSystem.ts`**

```typescript
import { existsSync } from "node:fs"

export async function isGitRepo(path: string): Promise<boolean> {
  return existsSync(join(path, ".git"))
}
```

- [ ] **Step 6: Implement `getGitStatus` in `src/fileSystem.ts`**

```typescript
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function getGitStatus(repoPath: string): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>()
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoPath })
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue
      const status = line.slice(0, 2).trim()
      const filePath = line.slice(3).trim()
      statusMap.set(filePath, status)
    }
  } catch {
    // Not a git repo or git not available — return empty map
  }
  return statusMap
}
```

- [ ] **Step 7: Implement `resolvePath` in `src/fileSystem.ts`**

```typescript
import { resolve, relative } from "node:path"

export function resolvePath(base: string, relative: string): string {
  return resolve(base, relative)
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `bun test src/fileSystem.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/fileSystem.ts src/fileSystem.test.ts
git commit -m "feat: add file system service with readDir, watch, git status"
```

---

### Task 3: Icon Mapping

**Files:**
- Create: `src/icons.ts`
- Create: `src/icons.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `getFileIcon(name: string, isDirectory: boolean): string` — returns a Unicode symbol
  - `getGitStatusIndicator(status: string | undefined): string` — returns a colored indicator string

- [ ] **Step 1: Write failing tests for `getFileIcon`**

```typescript
import { describe, it, expect } from "bun:test"
import { getFileIcon } from "./icons"

describe("getFileIcon", () => {
  it("returns folder icon for directories", () => {
    expect(getFileIcon("src", true)).toBe("📁")
  })

  it("returns TypeScript icon for .ts files", () => {
    expect(getFileIcon("index.ts", false)).toBe("📘")
  })

  it("returns default icon for unknown extensions", () => {
    expect(getFileIcon("data.xyz", false)).toBe("📄")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/icons.test.ts`
Expected: FAIL — `getFileIcon` not defined

- [ ] **Step 3: Implement `getFileIcon` in `src/icons.ts`**

```typescript
const EXTENSION_ICONS: Record<string, string> = {
  ts: "📘",
  tsx: "📘",
  js: "📒",
  jsx: "📒",
  json: "📋",
  md: "📝",
  css: "🎨",
  html: "🌐",
  png: "🖼️",
  jpg: "🖼️",
  svg: "🖼️",
  gitignore: "🔒",
  env: "🔒",
}

export function getFileIcon(name: string, isDirectory: boolean): string {
  if (isDirectory) return "📁"
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_ICONS[ext] ?? "📄"
}
```

- [ ] **Step 4: Implement `getGitStatusIndicator` in `src/icons.ts`**

```typescript
export function getGitStatusIndicator(status: string | undefined): string {
  if (!status) return ""
  if (status === "M") return " [M]"
  if (status === "A") return " [A]"
  if (status === "?") return " [?]"
  return ` [${status}]`
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/icons.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/icons.ts src/icons.test.ts
git commit -m "feat: add file icon and git status indicator mapping"
```

---

### Task 4: TreeNode Component

**Files:**
- Create: `src/TreeNode.tsx`

**Interfaces:**
- Consumes:
  - `getFileIcon(name: string, isDirectory: boolean): string` from `src/icons.ts`
  - `getGitStatusIndicator(status: string | undefined): string` from `src/icons.ts`
  - `DirEntry` type from `src/fileSystem.ts`
- Produces:
  - `TreeNode` component — props: `{ entry: DirEntry; depth: number; isSelected: boolean; isExpanded: boolean; gitStatus: string | undefined }`

- [ ] **Step 1: Implement `TreeNode` in `src/TreeNode.tsx`**

```typescript
import type { DirEntry } from "./fileSystem"
import { getFileIcon, getGitStatusIndicator } from "./icons"

type TreeNodeProps = {
  entry: DirEntry
  depth: number
  isSelected: boolean
  isExpanded: boolean
  gitStatus: string | undefined
}

export function TreeNode(props: TreeNodeProps) {
  const indent = "  ".repeat(props.depth)
  const chevron = props.entry.isDirectory ? (props.isExpanded ? "▾ " : "▸ ") : "  "
  const icon = getFileIcon(props.entry.name, props.entry.isDirectory)
  const gitIndicator = getGitStatusIndicator(props.gitStatus)
  const fg = props.isSelected ? "white" : undefined

  return (
    <text fg={fg}>
      {indent}
      {chevron}
      {icon} {props.entry.name}
      {gitIndicator}
    </text>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/TreeNode.tsx
git commit -m "feat: add TreeNode component"
```

---

### Task 5: FileTree Component

**Files:**
- Create: `src/FileTree.tsx`
- Create: `src/FileTree.test.ts`

**Interfaces:**
- Consumes:
  - `readDir`, `watch`, `isGitRepo`, `getGitStatus` from `src/fileSystem.ts`
  - `DirEntry` type from `src/fileSystem.ts`
  - `TreeNode` component from `src/TreeNode.tsx`
  - `usePlugin` from `@opencode/plugin/tui`
- Produces:
  - `FileTree` component — no props, uses `usePlugin()` for context

- [ ] **Step 1: Write failing tests for tree navigation logic**

```typescript
import { describe, it, expect } from "bun:test"
import { computeVisibleNodes, moveCursor, toggleExpand } from "./FileTree"

describe("computeVisibleNodes", () => {
  it("returns root entries when no folders are expanded", () => {
    const entries = [
      { name: "src", path: "/proj/src", isDirectory: true },
      { name: "index.ts", path: "/proj/index.ts", isDirectory: false },
    ]
    const expanded = new Set<string>()
    const visible = computeVisibleNodes(entries, expanded)
    expect(visible).toHaveLength(2)
  })

  it("includes children of expanded folders", () => {
    const entries = [
      { name: "src", path: "/proj/src", isDirectory: true },
      { name: "index.ts", path: "/proj/index.ts", isDirectory: false },
    ]
    const children = [
      { name: "app.ts", path: "/proj/src/app.ts", isDirectory: false },
    ]
    const expanded = new Set(["/proj/src"])
    const visible = computeVisibleNodes(entries, expanded, children)
    expect(visible).toHaveLength(3)
    expect(visible[1].name).toBe("app.ts")
  })
})

describe("moveCursor", () => {
  it("moves down and clamps at the bottom", () => {
    expect(moveCursor(0, 1, 5)).toBe(1)
    expect(moveCursor(4, 1, 5)).toBe(4)
  })
  it("moves up and clamps at the top", () => {
    expect(moveCursor(1, -1, 5)).toBe(0)
    expect(moveCursor(0, -1, 5)).toBe(0)
  })
})

describe("toggleExpand", () => {
  it("adds path to expanded set when collapsed", () => {
    const expanded = new Set<string>()
    const result = toggleExpand("/proj/src", expanded)
    expect(result.has("/proj/src")).toBe(true)
  })
  it("removes path from expanded set when expanded", () => {
    const expanded = new Set(["/proj/src"])
    const result = toggleExpand("/proj/src", expanded)
    expect(result.has("/proj/src")).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/FileTree.test.ts`
Expected: FAIL — functions not defined

- [ ] **Step 3: Implement navigation logic in `src/FileTree.tsx`**

```typescript
import { createSignal, createEffect, onCleanup, For, Show, type Component } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { readDir, watch, isGitRepo, getGitStatus, type DirEntry } from "./fileSystem"
import { TreeNode } from "./TreeNode"

// --- Pure navigation logic (exported for testing) ---

export type VisibleNode = {
  entry: DirEntry
  depth: number
}

export function computeVisibleNodes(
  rootEntries: DirEntry[],
  expanded: Set<string>,
  childrenMap?: Map<string, DirEntry[]>,
  depth: number = 0,
  result: VisibleNode[] = [],
): VisibleNode[] {
  for (const entry of rootEntries) {
    result.push({ entry, depth })
    if (entry.isDirectory && expanded.has(entry.path) && childrenMap?.has(entry.path)) {
      computeVisibleNodes(childrenMap.get(entry.path)!, expanded, childrenMap, depth + 1, result)
    }
  }
  return result
}

export function moveCursor(current: number, delta: number, max: number): number {
  return Math.max(0, Math.min(max - 1, current + delta))
}

export function toggleExpand(path: string, expanded: Set<string>): Set<string> {
  const next = new Set(expanded)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

// --- Component ---

export const FileTree: Component = () => {
  const context = usePlugin()
  const [entries, setEntries] = createSignal<DirEntry[]>([])
  const [childrenMap, setChildrenMap] = createSignal<Map<string, DirEntry[]>>(new Map())
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
  const [cursor, setCursor] = createSignal(0)
  const [gitStatusMap, setGitStatusMap] = createSignal<Map<string, string>>(new Map())

  createEffect(() => {
    const dir = context.location?.directory
    if (!dir) return

    // Initial load
    readDir(dir).then((result) => {
      setEntries(result)
      // Auto-expand root
      setExpanded(new Set([dir]))
    })

    // Git status
    isGitRepo(dir).then((isGit) => {
      if (isGit) getGitStatus(dir).then(setGitStatusMap)
    })

    // Watch for changes
    const unwatch = watch(dir, () => {
      readDir(dir).then(setEntries)
      isGitRepo(dir).then((isGit) => {
        if (isGit) getGitStatus(dir).then(setGitStatusMap)
      })
    })

    onCleanup(unwatch)
  })

  // Lazy-load children when a folder is expanded
  createEffect(() => {
    const currentExpanded = expanded()
    for (const path of currentExpanded) {
      if (!childrenMap().has(path)) {
        readDir(path).then((children) => {
          setChildrenMap((prev) => {
            const next = new Map(prev)
            next.set(path, children)
            return next
          })
        })
      }
    }
  })

  const visibleNodes = () => computeVisibleNodes(entries(), expanded(), childrenMap())

  return (
    <box>
      <For each={visibleNodes()}>
        {(node, index) => (
          <TreeNode
            entry={node.entry}
            depth={node.depth}
            isSelected={index() === cursor()}
            isExpanded={expanded().has(node.entry.path)}
            gitStatus={gitStatusMap().get(node.entry.path)}
          />
        )}
      </For>
    </box>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/FileTree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/FileTree.tsx src/FileTree.test.ts
git commit -m "feat: add FileTree component with navigation logic"
```

---

### Task 6: Plugin Entry — Keymap + Sidebar Slot

**Files:**
- Modify: `src/tui.ts`

**Interfaces:**
- Consumes:
  - `FileTree` component from `src/FileTree.tsx`
  - `moveCursor`, `toggleExpand` from `src/FileTree.tsx`
  - `Plugin` from `@opencode/plugin/tui`
- Produces: fully functional plugin with sidebar slot and keymap

- [ ] **Step 1: Implement full plugin in `src/tui.ts`**

```typescript
import { Plugin } from "@opencode/plugin/tui"
import { FileTree, moveCursor, toggleExpand } from "./FileTree"
import { createSignal } from "solid-js"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    const [cursor, setCursor] = createSignal(0)
    const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

    // Register sidebar slot
    context.ui.slot({
      append: "sidebar.content",
      render: () => <FileTree />,
    })

    // Register keymap for navigation
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "filetree.up",
          title: "Move up",
          bind: "up",
          run: () => {
            setCursor((c) => moveCursor(c, -1, 1000))
          },
        },
        {
          id: "filetree.down",
          title: "Move down",
          bind: "down",
          run: () => {
            setCursor((c) => moveCursor(c, 1, 1000))
          },
        },
        {
          id: "filetree.expand",
          title: "Expand folder",
          bind: "right",
          run: () => {
            // TODO: expand folder at cursor
          },
        },
        {
          id: "filetree.collapse",
          title: "Collapse folder",
          bind: "left",
          run: () => {
            // TODO: collapse folder at cursor
          },
        },
        {
          id: "filetree.open",
          title: "Open file in editor",
          bind: "enter",
          run: () => {
            // TODO: open file at cursor in $EDITOR
          },
        },
        {
          id: "filetree.send-to-session",
          title: "Send file to session",
          bind: "ctrl+o",
          run: () => {
            // TODO: send file path to session
          },
        },
        {
          id: "filetree.refresh",
          title: "Refresh tree",
          bind: "r",
          run: () => {
            // TODO: refresh tree
          },
        },
      ],
    }))

    return () => {
      // Cleanup
    }
  },
})
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `bunx tsc --noEmit`
Expected: No errors (TODOs are fine for now)

- [ ] **Step 3: Commit**

```bash
git add src/tui.ts
git commit -m "feat: register sidebar slot and keymap for filetree navigation"
```

---

### Task 7: Wire Up Navigation Actions

**Files:**
- Modify: `src/tui.ts`
- Modify: `src/FileTree.tsx`

**Interfaces:**
- Consumes: all previous
- Produces: fully functional plugin where all keymap commands work

- [ ] **Step 1: Lift cursor and expanded state into `tui.ts` and pass to `FileTree`**

Modify `FileTree.tsx` to accept optional props:

```typescript
type FileTreeProps = {
  cursor?: () => number
  setCursor?: (fn: (c: number) => number) => void
  expanded?: () => Set<string>
  setExpanded?: (fn: (prev: Set<string>) => Set<string>) => void
}
```

Use these props instead of local state when provided.

- [ ] **Step 2: Implement expand/collapse in `tui.ts`**

The `right` key handler should:
1. Get the visible nodes list
2. Find the entry at the current cursor position
3. If it's a directory, toggle its expanded state
4. If it's a file, do nothing

- [ ] **Step 3: Implement open-in-editor in `tui.ts`**

The `enter` key handler should:
1. Get the visible nodes list
2. Find the entry at the current cursor position
3. If it's a file, spawn `$EDITOR <path>` via `context.$`
4. If it's a directory, toggle expand instead

- [ ] **Step 4: Implement send-to-session in `tui.ts`**

The `ctrl+o` key handler should:
1. Get the visible nodes list
2. Find the entry at the current cursor position
3. Send `Read <path>` to the current session via `context.client.session.prompt()`

- [ ] **Step 5: Implement refresh in `tui.ts`**

The `r` key handler should trigger a re-read of the root directory.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/tui.ts src/FileTree.tsx
git commit -m "feat: wire up all navigation actions"
```

---

### Task 8: Integration Testing

**Files:**
- Create: `src/integration.test.ts`

**Interfaces:**
- Consumes: all previous
- Produces: verified working plugin

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect } from "bun:test"
import { readDir, computeVisibleNodes, moveCursor, toggleExpand } from "./index"

describe("integration", () => {
  it("reads a directory and computes visible nodes", async () => {
    const dir = process.cwd()
    const entries = await readDir(dir)
    expect(entries.length).toBeGreaterThan(0)

    const expanded = new Set([dir])
    const visible = computeVisibleNodes(entries, expanded)
    expect(visible.length).toBeGreaterThanOrEqual(entries.length)
  })

  it("navigation works end-to-end", () => {
    const expanded = new Set<string>()
    expect(moveCursor(0, 1, 10)).toBe(1)
    expect(toggleExpand("/test", expanded).has("/test")).toBe(true)
  })
})
```

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/integration.test.ts
git commit -m "test: add integration tests"
```

---

### Task 9: Manual Verification

**Files:** none

**Interfaces:**
- Consumes: all previous
- Produces: verified working plugin in OpenCode

- [ ] **Step 1: Build the plugin**

Run: `bun run build` (or `bunx tsc`)
Expected: `dist/` directory created with compiled JS

- [ ] **Step 2: Load in OpenCode**

Add to `opencode.json`:
```json
{
  "plugin": ["file:///C:/Users/clement/Desktop/AI/plugins/filetree"]
}
```

- [ ] **Step 3: Open OpenCode TUI and verify**

- [ ] Sidebar shows file tree
- [ ] Arrow keys navigate up/down
- [ ] Right arrow expands folders
- [ ] Left arrow collapses folders
- [ ] Enter opens file in editor
- [ ] Ctrl+o sends file to session
- [ ] R refreshes the tree
- [ ] Git status indicators appear (if in git repo)

- [ ] **Step 4: Fix any issues found**

- [ ] **Step 5: Commit fixes if any**

```bash
git add -A
git commit -m "fix: address manual verification issues"
```
