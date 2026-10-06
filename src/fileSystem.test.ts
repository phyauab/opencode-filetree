import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises"
import { symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readDir, parseGitStatus, isGitRepo, getGitStatus } from "./fileSystem"

/** True when the OS allows this process to create symlinks. */
function symlinksSupported(): boolean {
  const probe = join(tmpdir(), `filetree-symlink-probe-${process.pid}`)
  try {
    symlinkSync(probe, `${probe}-link`)
    rmSync(`${probe}-link`, { force: true })
    return true
  } catch {
    return false
  }
}

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
    expect(entries.find((e) => e.name === "src")?.isDirectory).toBe(true)
    expect(entries.find((e) => e.name === "index.ts")?.isDirectory).toBe(false)
  })

  it("returns full paths for entries", async () => {
    await writeFile(join(testDir, "test.txt"), "")
    const entries = await readDir(testDir)
    expect(entries[0].path).toBe(join(testDir, "test.txt"))
  })

  it("returns empty array for empty directory", async () => {
    expect(await readDir(testDir)).toEqual([])
  })

  // Windows requires elevated privileges (or developer mode) for symlinks, so
  // these cases are skipped where the OS refuses to create one.
  const itSymlink = symlinksSupported() ? it : it.skip

  itSymlink("treats a symlink to a directory as a directory", async () => {
    const real = join(testDir, "real")
    await mkdir(real)
    await writeFile(join(real, "inner.txt"), "")
    await symlink(real, join(testDir, "linkdir"), "dir")

    const entries = await readDir(testDir)
    expect(entries.find((e) => e.name === "linkdir")?.isDirectory).toBe(true)
  })

  itSymlink("treats a broken symlink as a file rather than throwing", async () => {
    await symlink(join(testDir, "does-not-exist"), join(testDir, "broken"), "file")
    const entries = await readDir(testDir)
    expect(entries.find((e) => e.name === "broken")?.isDirectory).toBe(false)
  })

  it("rejects when the directory does not exist", async () => {
    expect(readDir(join(testDir, "nope"))).rejects.toThrow()
  })
})

describe("parseGitStatus", () => {
  // Keys are absolute, so expectations resolve the same way on Windows.
  const at = (rel: string) => resolve("/repo", rel)

  it("keys entries by absolute path under the repo root", () => {
    const map = parseGitStatus("/repo", " M src/index.ts\nA  added.txt\n?? new.txt\n")
    expect(map.get(at("src/index.ts"))).toBe("M")
    expect(map.get(at("added.txt"))).toBe("A")
    expect(map.get(at("new.txt"))).toBe("?")
  })

  it("normalizes untracked ?? to ?", () => {
    const map = parseGitStatus("/repo", "?? untracked.txt\n")
    expect(map.get(at("untracked.txt"))).toBe("?")
  })

  it("handles NUL-separated output with -z", () => {
    const map = parseGitStatus("/repo", " M a.txt\0?? b.txt\0")
    expect(map.get(at("a.txt"))).toBe("M")
    expect(map.get(at("b.txt"))).toBe("?")
  })

  it("keeps paths containing spaces intact", () => {
    const map = parseGitStatus("/repo", "?? a file with spaces.txt\n")
    expect(map.get(at("a file with spaces.txt"))).toBe("?")
  })

  it("strips surrounding quotes from C-quoted paths", () => {
    const map = parseGitStatus("/repo", '?? "quoted name.txt"\n')
    expect(map.get(at("quoted name.txt"))).toBe("?")
  })

  it("uses the new path for rename records", () => {
    const map = parseGitStatus("/repo", "R  old.txt -> new.txt\n")
    expect(map.get(at("new.txt"))).toBe("R")
  })

  it("returns an empty map for empty output", () => {
    expect(parseGitStatus("/repo", "").size).toBe(0)
  })
})

describe("git detection", () => {
  let testDir: string

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "filetree-git-"))
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it("isGitRepo returns false without a .git directory", async () => {
    expect(await isGitRepo(testDir)).toBe(false)
  })

  it("getGitStatus returns an empty map outside a repo", async () => {
    expect((await getGitStatus(testDir)).size).toBe(0)
  })
})