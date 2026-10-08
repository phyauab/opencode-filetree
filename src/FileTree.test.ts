import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { computeVisibleNodes, moveCursor, toggleExpand, type VisibleNode } from "./treeLogic"
import { FileTree } from "./FileTree"
import { createTreeState, type TreeState } from "./store"
import type { DirEntry } from "./fileSystem"

function makeEntry(name: string, isDirectory: boolean): DirEntry {
  return { name, path: `/proj/${name}`, isDirectory }
}

describe("computeVisibleNodes", () => {
  it("returns root entries when no folders are expanded", () => {
    const entries = [makeEntry("src", true), makeEntry("index.ts", false)]
    const expanded = new Set<string>()
    const visible = computeVisibleNodes(entries, expanded)
    expect(visible).toHaveLength(2)
    expect(visible[0].entry.name).toBe("src")
    expect(visible[1].entry.name).toBe("index.ts")
  })

  it("includes children of expanded folders", () => {
    const entries = [makeEntry("src", true), makeEntry("index.ts", false)]
    const children: DirEntry[] = [makeEntry("app.ts", false)]
    const childrenMap = new Map([["/proj/src", children]])
    const expanded = new Set(["/proj/src"])
    const visible = computeVisibleNodes(entries, expanded, childrenMap)
    expect(visible).toHaveLength(3)
    expect(visible[0].entry.name).toBe("src")
    expect(visible[1].entry.name).toBe("app.ts")
    expect(visible[1].depth).toBe(1)
    expect(visible[2].entry.name).toBe("index.ts")
  })

  it("does not include children of collapsed folders", () => {
    const entries = [makeEntry("src", true), makeEntry("index.ts", false)]
    const children: DirEntry[] = [makeEntry("app.ts", false)]
    const childrenMap = new Map([["/proj/src", children]])
    const expanded = new Set<string>()
    const visible = computeVisibleNodes(entries, expanded, childrenMap)
    expect(visible).toHaveLength(2)
  })

  it("handles nested expansion", () => {
    const entries = [makeEntry("src", true)]
    const srcChildren: DirEntry[] = [makeEntry("components", true)]
    const componentsChildren: DirEntry[] = [makeEntry("Button.tsx", false)]
    const childrenMap = new Map([
      ["/proj/src", srcChildren],
      ["/proj/components", componentsChildren],
    ])
    const expanded = new Set(["/proj/src", "/proj/components"])
    const visible = computeVisibleNodes(entries, expanded, childrenMap)
    expect(visible).toHaveLength(3)
    expect(visible[0].entry.name).toBe("src")
    expect(visible[1].entry.name).toBe("components")
    expect(visible[2].entry.name).toBe("Button.tsx")
    expect(visible[2].depth).toBe(2)
  })
})

describe("moveCursor", () => {
  it("moves down", () => {
    expect(moveCursor(0, 1, 5)).toBe(1)
  })

  it("moves up", () => {
    expect(moveCursor(1, -1, 5)).toBe(0)
  })

  it("clamps at the bottom", () => {
    expect(moveCursor(4, 1, 5)).toBe(4)
  })

  it("clamps at the top", () => {
    expect(moveCursor(0, -1, 5)).toBe(0)
  })

  it("handles delta of 0", () => {
    expect(moveCursor(2, 0, 5)).toBe(2)
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

  it("does not mutate the original set", () => {
    const expanded = new Set<string>()
    toggleExpand("/proj/src", expanded)
    expect(expanded.has("/proj/src")).toBe(false)
  })
})

/*
 * Component tests. These mount FileTree against a real temporary directory, so
 * the directory read, the git status probe and the file watcher are the real
 * ones; only the host's storage and renderer are stood in for.
 */

const created: string[] = []

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

/** A project root holding one folder and one file, folders sorted first. */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "filetree-"))
  created.push(root)
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "a.ts"), "")
  return root
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits for `check` to hold, so a watcher test does not race the filesystem. */
async function eventually(check: () => boolean, timeout = 8000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(50)
  }
  return check()
}

/**
 * A stand-in for `storage.memory`.
 *
 * The host hands back a reactive proxy *object*, not a getter -- `readLayout`
 * rejects anything whose `typeof` is not "object" -- and the value outlives a
 * remount. Both matter: a getter here made every persisted layout read as empty,
 * which is how the stuck-folder bug below stayed invisible.
 */
function createMemoryStorage() {
  const values = new Map<string, any>()
  return {
    memory(key: string, options: { initial: unknown }) {
      if (!values.has(key)) values.set(key, options.initial)
      return [values.get(key), (mutate: (draft: any) => void) => mutate(values.get(key))]
    },
  }
}

/** A renderer that counts the frames the plugin asks for. */
function createMockRenderer() {
  const counter = { frames: 0 }
  return {
    height: 40,
    requestRender: () => {
      counter.frames++
    },
    frames: () => counter.frames,
  }
}

function mountFileTree(
  root: string,
  state: TreeState,
  storage = createMemoryStorage(),
  renderer: any = { height: 40, requestRender: () => {} },
) {
  const context: any = {
    location: { directory: root },
    data: { location: { default: () => ({ directory: root }) } },
    storage,
    renderer,
    ui: { format: { path: (p: string) => p } },
  }
  return (FileTree as any)({ state, context })
}

/** The box that owns the click handler, as the host's hit grid sees it. */
function clickableBox(element: any): any {
  if (element?.props?.onMouseDown) return element
  const children = element?.props?.children
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  for (const child of list) {
    if (!child || typeof child !== "object") continue
    const found = clickableBox(child)
    if (found) return found
  }
  return undefined
}

describe("asking the host to repaint", () => {
  // OpenTUI's renderer is demand-driven: it paints a frame when something asks
  // it to. Nothing in a plugin's state change does that on its own, so state
  // moved, Solid updated the rows, and no frame was ever scheduled -- the panel
  // went stale while the state underneath it was correct. That is the bug this
  // whole file exists to prevent.

  it("asks for a frame when the selection moves", () => {
    const root = makeProject()
    const state = createTreeState()
    const renderer = createMockRenderer()
    mountFileTree(root, state, createMemoryStorage(), renderer)
    const before = renderer.frames()

    state.setCursor(1)

    expect(renderer.frames()).toBeGreaterThan(before)
  })

  it("asks for a frame when a folder is expanded", () => {
    const root = makeProject()
    const state = createTreeState()
    const renderer = createMockRenderer()
    mountFileTree(root, state, createMemoryStorage(), renderer)
    const before = renderer.frames()

    state.setExpanded(new Set([join(root, "src")]))

    expect(renderer.frames()).toBeGreaterThan(before)
  })

  it("asks for a frame when a row is clicked", () => {
    const root = makeProject()
    const state = createTreeState()
    const renderer = createMockRenderer()
    const box = clickableBox(mountFileTree(root, state, createMemoryStorage(), renderer))
    const before = renderer.frames()

    box.props.onMouseDown({ y: 0 })

    expect(renderer.frames()).toBeGreaterThan(before)
  })

  it("asks for a frame when the rows are reloaded", () => {
    const root = makeProject()
    const state = createTreeState()
    const renderer = createMockRenderer()
    mountFileTree(root, state, createMemoryStorage(), renderer)
    const before = renderer.frames()

    state.reload()

    expect(renderer.frames()).toBeGreaterThan(before)
  })
})

describe("clicking a row", () => {
  it("selects the clicked row", () => {
    const root = makeProject()
    const state = createTreeState()
    const box = clickableBox(mountFileTree(root, state))

    box.props.onMouseDown({ y: 1 })

    expect(state.cursor()).toBe(1)
  })

  it("expands a clicked folder", () => {
    const root = makeProject()
    const state = createTreeState()
    const box = clickableBox(mountFileTree(root, state))

    // Row 0 is the folder: folders sort before files.
    box.props.onMouseDown({ y: 0 })

    expect([...state.expanded()]).toEqual([join(root, "src")])
  })

  it("collapses a clicked folder that is already open", () => {
    const root = makeProject()
    const state = createTreeState()
    const box = clickableBox(mountFileTree(root, state))

    box.props.onMouseDown({ y: 0 })
    expect([...state.expanded()]).toEqual([join(root, "src")])

    box.props.onMouseDown({ y: 0 })

    expect([...state.expanded()]).toEqual([])
  })

  it("leaves a clicked file unexpanded", () => {
    const root = makeProject()
    const state = createTreeState()
    const box = clickableBox(mountFileTree(root, state))

    box.props.onMouseDown({ y: 1 })

    expect([...state.expanded()]).toEqual([])
  })

  it("ignores a click below the last row", () => {
    const root = makeProject()
    const state = createTreeState()
    const box = clickableBox(mountFileTree(root, state))

    box.props.onMouseDown({ y: 40 })

    expect(state.cursor()).toBe(0)
    expect([...state.expanded()]).toEqual([])
  })

  it("ignores a click on the row-count hint below the rows", () => {
    const root = mkdtempSync(join(tmpdir(), "filetree-"))
    created.push(root)
    for (let i = 0; i < 60; i++) mkdirSync(join(root, `d${i}`))
    const state = createTreeState()
    const box = clickableBox(mountFileTree(root, state))

    // Only some rows fit, so the "N more below" hint is rendered inside the same
    // box and takes up a row of its own. Clicking it must not select or toggle
    // the tree entry that happens to sit at that index.
    const view = state.viewport()
    expect(view.end).toBeLessThan(state.visibleNodes().length)

    box.props.onMouseDown({ y: view.end })

    expect(state.cursor()).toBe(0)
    expect([...state.expanded()]).toEqual([])
  })
})

describe("mounting twice", () => {
  it("keeps the rows it already had instead of re-reading the root", () => {
    const root = makeProject()
    const state = createTreeState()

    mountFileTree(root, state)
    expect(state.entries().map((e) => e.name)).toEqual(["src", "a.ts"])

    // The host calls the slot render again every time the panel is mounted. If the
    // remount re-read the root it would pick this up, which is exactly the
    // directory walk and forked `git status` this is meant to avoid repeating.
    writeFileSync(join(root, "b.ts"), "")
    mountFileTree(root, state)

    expect(state.entries().map((e) => e.name)).toEqual(["src", "a.ts"])
  })

  it("keeps the rows when the root has become unreadable", () => {
    const root = makeProject()
    const state = createTreeState()

    mountFileTree(root, state)
    rmSync(root, { recursive: true, force: true })

    // A remount that re-reads the root blanks the panel: a network drive or a
    // checkout swapping directories should not empty the tree.
    mountFileTree(root, state)
    expect(state.entries().map((e) => e.name)).toEqual(["src", "a.ts"])
  })

  it("retries the root when the first read failed", () => {
    const root = makeProject()
    rmSync(root, { recursive: true, force: true })
    const state = createTreeState()

    mountFileTree(root, state)
    expect(state.entries()).toEqual([])

    // A failed read must not mark the root as loaded, or the panel tells the
    // user "no files" for a directory that has them, and nothing ever recovers
    // it because there is no watcher on a path that was missing.
    mkdirSync(root)
    writeFileSync(join(root, "a.ts"), "")
    mountFileTree(root, state)

    expect(state.entries().map((e) => e.name)).toEqual(["a.ts"])
  })

  it("does not re-open the last folder after the user collapses it", () => {
    const root = makeProject()
    const state = createTreeState()
    const storage = createMemoryStorage()
    const mount = () => mountFileTree(root, state, storage)

    mount()
    state.setExpanded(new Set([join(root, "src")]))

    // A remount re-runs the persist and restore effects, which is how the layout
    // reaches storage and how it is read back.
    mount()

    // The user collapses the one folder that was open.
    state.setExpanded(new Set<string>())
    mount()

    expect([...state.expanded()]).toEqual([])
  })

  it("keeps a collapsed folder collapsed across several remounts", () => {
    const root = makeProject()
    const state = createTreeState()
    const storage = createMemoryStorage()
    const mount = () => mountFileTree(root, state, storage)

    mount()
    state.setExpanded(new Set([join(root, "src")]))
    mount()
    state.setExpanded(new Set<string>())
    mount()
    mount()

    expect([...state.expanded()]).toEqual([])
  })

  it("still reopens a folder that really was left expanded", () => {
    const root = makeProject()
    const state = createTreeState()
    const storage = createMemoryStorage()
    const mount = () => mountFileTree(root, state, storage)

    mount()
    state.setExpanded(new Set([join(root, "src")]))
    mount()
    // A fresh session: a new tree state reads the stored layout.
    const next = createTreeState()
    mountFileTree(root, next, storage)

    expect([...next.expanded()]).toEqual([join(root, "src")])
  })

  it("still re-reads the root after an explicit refresh", () => {
    const root = makeProject()
    const state = createTreeState()

    mountFileTree(root, state)
    writeFileSync(join(root, "b.ts"), "")
    state.reload()
    mountFileTree(root, state)

    // A refresh must re-arm the read, otherwise the panel keeps showing whatever
    // it had and the `r` key silently does nothing.
    expect(state.entries().map((e) => e.name)).toEqual(["src", "a.ts", "b.ts"])
  })

  it("picks up git status for a file added after the first mount", async () => {
    const root = makeProject()
    // `git init` alone needs no user config, and an untracked file already shows
    // up in `git status --porcelain`.
    execFileSync("git", ["init"], { cwd: root })
    const state = createTreeState()
    mountFileTree(root, state)

    expect(state.gitStatusMap().has(join(root, "a.ts"))).toBe(true)
    expect(state.gitStatusMap().has(join(root, "b.ts"))).toBe(false)

    // Only the first mount reads the root, so the watcher has to carry git status,
    // or a new file shows no badge until the user presses `r`.
    writeFileSync(join(root, "b.ts"), "")
    const refreshed = await eventually(() => state.gitStatusMap().has(join(root, "b.ts")))

    expect(refreshed).toBe(true)
  })
})
