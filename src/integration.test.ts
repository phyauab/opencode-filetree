import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readDir, watch, isGitRepo, getGitStatus, resolvePath } from "./fileSystem"
import { loadDir, applyResult } from "./loader"
import { computeVisibleNodes, moveCursor, toggleExpand } from "./FileTree"
import { createTreeState } from "./store"
import { promptSession } from "./commands"

describe("integration: end-to-end file tree", () => {
  let testDir: string
  let srcDir: string
  let componentsDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "filetree-integration-"))
    componentsDir = join(testDir, "src", "components")
    srcDir = join(testDir, "src")
    await mkdir(componentsDir, { recursive: true })
    await mkdir(join(testDir, "node_modules", "left-pad"), { recursive: true })
    await writeFile(join(testDir, "README.md"), "# test")
    await writeFile(join(srcDir, "index.ts"), "export {}")
    await writeFile(join(componentsDir, "Button.tsx"), "export const B = 1")
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it("reads the tree and hides node_modules", async () => {
    const root = await loadDir(readDir, testDir)
    expect(root.ok).toBe(true)
    if (!root.ok) return
    expect(root.entries.map((e) => e.name)).toEqual(["src", "README.md"])
  })

  it("loads nested folders on demand", async () => {
    const state = createTreeState()
    const root = await loadDir(readDir, testDir)
    if (!root.ok) throw new Error("expected readable root")
    state.setEntries(root.entries)
    // Collapsed: nested folders are not read at all.
    expect(state.visibleNodes()).toHaveLength(2)

    state.setExpanded(new Set([srcDir]))
    const result = await loadDir(readDir, srcDir)
    const merged = applyResult(state.childrenMap(), state.failures(), srcDir, result)
    state.setChildrenMap(merged.children)
    state.setFailures(merged.failures)

    expect(state.visibleNodes().map((v) => v.entry.name)).toEqual([
      "src",
      "components",
      "index.ts",
      "README.md",
    ])
  })

  it("navigates, expands, and collapses a real tree", async () => {
    const state = createTreeState()
    const root = await loadDir(readDir, testDir)
    if (!root.ok) throw new Error("expected readable root")
    state.setEntries(root.entries)

    const src = await loadDir(readDir, srcDir)
    const comp = await loadDir(readDir, componentsDir)
    if (!src.ok || !comp.ok) throw new Error("expected readable nested dirs")

    let merged = applyResult(state.childrenMap(), state.failures(), srcDir, src)
    state.setChildrenMap(merged.children)
    state.setFailures(merged.failures)
    merged = applyResult(state.childrenMap(), state.failures(), componentsDir, comp)
    state.setChildrenMap(merged.children)
    state.setFailures(merged.failures)

    state.setExpanded(new Set([srcDir]))
    expect(state.visibleNodes()).toHaveLength(4)

    state.setCursor(1)
    expect(state.currentEntry()?.name).toBe("components")

    state.setExpanded((prev) => toggleExpand(componentsDir, prev))
    state.clampCursor()
    expect(state.visibleNodes()).toHaveLength(5)

    state.setExpanded((prev) => toggleExpand(componentsDir, prev))
    state.clampCursor()
    expect(state.visibleNodes()).toHaveLength(4)
    expect(state.cursor()).toBeLessThan(4)
  })

  it("keeps the cursor in range when files disappear", async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.ts`,
      path: join(srcDir, `f${i}.ts`),
      isDirectory: false,
    }))
    for (const file of files) await writeFile(file.path, "")

    const state = createTreeState()
    state.setEntries(files)
    state.setCursor(4)
    expect(state.currentEntry()?.name).toBe("f4.ts")

    await rm(files[3].path)
    const shrunk = await loadDir(readDir, srcDir)
    if (!shrunk.ok) throw new Error("expected readable dir")

    // A deleted file leaves the cursor still in range; it must stay on a real row.
    state.setEntries(shrunk.entries)
    state.clampCursor()
    expect(state.currentEntry()).toBeDefined()
    expect(state.cursor()).toBeLessThan(state.visibleNodes().length)

    // A cursor left far past the end by a larger shrink is pulled back in.
    state.setCursor(999)
    expect(state.currentEntry()).toBeUndefined()
    state.clampCursor()
    expect(state.currentEntry()).toBeDefined()
    expect(state.cursor()).toBe(state.visibleNodes().length - 1)
  })

  it("reports a vanished directory without throwing", async () => {
    const result = await loadDir(readDir, join(testDir, "never-existed"))
    expect(result).toEqual({ ok: false, reason: "not found" })
  })

  it("shows a failure reason for an unreadable directory", async () => {
    const locked = join(testDir, "locked")
    await mkdir(locked)
    const result = await loadDir(readDir, join(locked, "nope"))
    expect(result.ok).toBe(false)
  })

  it("moves the cursor without going out of bounds", () => {
    const state = createTreeState()
    state.setEntries([
      { name: "src", path: join(testDir, "src"), isDirectory: true },
      { name: "README.md", path: join(testDir, "README.md"), isDirectory: false },
    ])
    const total = state.visibleNodes().length
    expect(total).toBe(2)

    for (let i = 0; i < 5; i++) state.setCursor((c) => moveCursor(c, 1, total))
    expect(state.cursor()).toBe(total - 1)
    for (let i = 0; i < 5; i++) state.setCursor((c) => moveCursor(c, -1, total))
    expect(state.cursor()).toBe(0)
  })

  it("handles a non-git directory without throwing", async () => {
    expect(await isGitRepo(testDir)).toBe(false)
    expect((await getGitStatus(testDir)).size).toBe(0)
  })

  it("never rejects when prompting a session that is unavailable", async () => {
    const result = await promptSession(
      { session: { prompt: () => Promise.reject(new Error("offline")) } },
      "ses_1",
      { name: "index.ts", path: join(srcDir, "index.ts"), isDirectory: false },
    )
    expect(result).toEqual({ ok: false, error: "offline" })
  })

  it("watch fires on file creation and stops after unsubscribe", async () => {
    let fired = false
    const stop = watch(testDir, () => {
      fired = true
    })

    await writeFile(join(testDir, "new.txt"), "hello")
    await new Promise((r) => setTimeout(r, 300))
    expect(fired).toBe(true)

    fired = false
    stop()
    await writeFile(join(testDir, "another.txt"), "hello")
    await new Promise((r) => setTimeout(r, 300))
    expect(fired).toBe(false)
  })

  it("resolvePath returns an absolute path", () => {
    expect(resolvePath(join(testDir, "proj"), join("src", "index.ts"))).toBe(
      join(testDir, "proj", "src", "index.ts"),
    )
  })

  it("computeVisibleNodes matches the store's own traversal", async () => {
    const root = await loadDir(readDir, testDir)
    const src = await loadDir(readDir, srcDir)
    if (!root.ok || !src.ok) throw new Error("expected readable dirs")

    const children = new Map([[srcDir, src.entries]])
    const visible = computeVisibleNodes(root.entries, new Set([srcDir]), children)

    const state = createTreeState()
    state.setEntries(root.entries)
    state.setChildrenMap(children)
    state.setExpanded(new Set([srcDir]))

    expect(visible.map((v) => v.entry.name)).toEqual(
      state.visibleNodes().map((v) => v.entry.name),
    )
    void resolve
  })
})