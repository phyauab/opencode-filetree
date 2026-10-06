import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, writeFile, mkdir, rm, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDir, watch, isGitRepo, getGitStatus, resolvePath } from "./fileSystem"
import { computeVisibleNodes, moveCursor, toggleExpand } from "./FileTree"
import { createTreeState } from "./store"

describe("integration: end-to-end file tree", () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "filetree-integration-"))
    await mkdir(join(testDir, "src", "components"), { recursive: true })
    await writeFile(join(testDir, "README.md"), "# test")
    await writeFile(join(testDir, "src", "index.ts"), "export {}")
    await writeFile(join(testDir, "src", "components", "Button.tsx"), "export const B = 1")
  })

  afterEach(async () => {
    await chmod(testDir, 0o755).catch(() => {})
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it("reads the directory tree and renders visible nodes correctly", async () => {
    const entries = await readDir(testDir)
    expect(entries.map((e) => e.name)).toEqual(["src", "README.md"])

    const state = createTreeState()
    state.setEntries(entries)

    // root collapsed by default
    expect(state.visibleNodes()).toHaveLength(2)

    // expand src
    const srcChildren = await readDir(join(testDir, "src"))
    state.setChildrenMap(new Map([[join(testDir, "src"), srcChildren]]))
    state.setExpanded(new Set([testDir]))

    const visible = state.visibleNodes()
    expect(visible.map((v) => v.entry.name)).toEqual(["src", "README.md"])
  })

  it("navigates the full tree with expand/collapse", async () => {
    const entries = await readDir(testDir)
    const srcChildren = await readDir(join(testDir, "src"))
    const compChildren = await readDir(join(testDir, "src", "components"))

    const childrenMap = new Map([
      [join(testDir, "src"), srcChildren],
      [join(testDir, "src", "components"), compChildren],
    ])

    const state = createTreeState()
    state.setEntries(entries)
    state.setChildrenMap(childrenMap)
    state.setExpanded(new Set([testDir, join(testDir, "src")]))

    const names = state.visibleNodes().map((v) => v.entry.name)
    expect(names).toEqual(["src", "components", "index.ts", "README.md"])

    // select the components folder
    state.setCursor(1)
    expect(state.currentEntry()?.name).toBe("components")

    // expand it
    state.setExpanded((prev) => toggleExpand(join(testDir, "src", "components"), prev))
    expect(state.visibleNodes()).toHaveLength(5)
    expect(state.currentEntry()?.name).toBe("components")

    // collapse it again
    state.setExpanded((prev) => toggleExpand(join(testDir, "src", "components"), prev))
    expect(state.visibleNodes()).toHaveLength(4)
  })

  it("moves the cursor through every visible node without going out of bounds", async () => {
    const entries = await readDir(testDir)
    const srcChildren = await readDir(join(testDir, "src"))
    const childrenMap = new Map([[join(testDir, "src"), srcChildren]])

    const state = createTreeState()
    state.setEntries(entries)
    state.setChildrenMap(childrenMap)
    state.setExpanded(new Set([join(testDir, "src")]))

    const total = state.visibleNodes().length
    expect(total).toBe(4)

    // walk down past the end
    state.setCursor((c) => moveCursor(c, 1, total))
    state.setCursor((c) => moveCursor(c, 1, total))
    state.setCursor((c) => moveCursor(c, 1, total))
    expect(state.cursor()).toBe(total - 1)

    // walk up past the start
    for (let i = 0; i < 10; i++) state.setCursor((c) => moveCursor(c, -1, total))
    expect(state.cursor()).toBe(0)
  })

  it("handles a non-git directory without throwing", async () => {
    const isGit = await isGitRepo(testDir)
    const status = await getGitStatus(testDir)
    expect(isGit).toBe(false)
    expect(status.size).toBe(0)
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
})