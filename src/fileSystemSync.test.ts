import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises"
import { symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readDirSync, isGitRepoSync, getGitStatusSync } from "./fileSystem"
import { loadDirSync } from "./loader"

describe("synchronous reads", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "filetree-sync-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it("reads a directory", async () => {
    await writeFile(join(dir, "a.txt"), "")
    expect(readDirSync(dir).map((e) => e.name)).toEqual(["a.txt"])
  })

  it("sorts folders before files", async () => {
    await mkdir(join(dir, "z"))
    await writeFile(join(dir, "a.txt"), "")
    expect(readDirSync(dir).map((e) => e.name)).toEqual(["z", "a.txt"])
  })

  it("marks directories", async () => {
    await mkdir(join(dir, "sub"))
    expect(readDirSync(dir)[0].isDirectory).toBe(true)
  })

  it("throws for a missing directory", () => {
    expect(() => readDirSync(join(dir, "nope"))).toThrow()
  })

  it("detects a git repo", async () => {
    expect(isGitRepoSync(dir)).toBe(false)
    await mkdir(join(dir, ".git"))
    expect(isGitRepoSync(dir)).toBe(true)
  })

  it("returns an empty git status outside a repo", () => {
    expect(getGitStatusSync(dir).size).toBe(0)
  })

  it("treats a symlinked directory as a directory", async () => {
    const probe = join(tmpdir(), `filetree-probe-${process.pid}`)
    try {
      symlinkSync(probe, `${probe}-link`)
      rmSync(`${probe}-link`, { force: true })
    } catch {
      return // symlinks unsupported here
    }

    const real = join(dir, "real")
    await mkdir(real)
    await symlink(real, join(dir, "link"), "dir")
    expect(readDirSync(dir).find((e) => e.name === "link")?.isDirectory).toBe(true)
  })
})

describe("loadDirSync", () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "filetree-loadsync-"))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it("returns filtered entries", async () => {
    await mkdir(join(dir, "node_modules"))
    await mkdir(join(dir, "src"))
    const result = loadDirSync(readDirSync, dir)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entries.map((e) => e.name)).toEqual(["src"])
  })

  it("returns not found instead of throwing", () => {
    expect(loadDirSync(readDirSync, join(dir, "gone"))).toEqual({ ok: false, reason: "not found" })
  })
})