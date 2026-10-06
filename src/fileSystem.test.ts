import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDir } from "./fileSystem"

describe("readDir", () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "filetree-test-"))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it("sorts folders before files, alphabetically within each group", async () => {
    await writeFile(join(testDir, "zebra.txt"), "")
    await writeFile(join(testDir, "apple.txt"), "")
    await mkdir(join(testDir, "beta"))
    await mkdir(join(testDir, "alpha"))

    const entries = await readDir(testDir)
    const names = entries.map((e) => e.name)
    expect(names).toEqual(["alpha", "beta", "apple.txt", "zebra.txt"])
  })

  it("marks directories with isDirectory: true", async () => {
    await mkdir(join(testDir, "src"))
    await writeFile(join(testDir, "index.ts"), "")

    const entries = await readDir(testDir)
    const src = entries.find((e) => e.name === "src")
    const index = entries.find((e) => e.name === "index.ts")
    expect(src?.isDirectory).toBe(true)
    expect(index?.isDirectory).toBe(false)
  })

  it("returns full paths for entries", async () => {
    await writeFile(join(testDir, "test.txt"), "")

    const entries = await readDir(testDir)
    expect(entries[0].path).toBe(join(testDir, "test.txt"))
  })

  it("returns empty array for empty directory", async () => {
    const entries = await readDir(testDir)
    expect(entries).toEqual([])
  })
})
