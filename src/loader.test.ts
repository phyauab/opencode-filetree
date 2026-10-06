import { describe, it, expect } from "bun:test"
import { loadDir, applyResult, type ChildrenMap, type FailuresMap } from "./loader"
import { readDir, type DirEntry } from "./fileSystem"

const SRC = { name: "src", path: "/proj/src", isDirectory: true }
const INDEX = { name: "index.ts", path: "/proj/src/index.ts", isDirectory: false }

const failing = (code: string) => () =>
  Promise.reject(Object.assign(new Error("x"), { code }))

describe("loadDir", () => {
  it("returns entries on success", async () => {
    const result = await loadDir(async () => [SRC, INDEX], "/proj/src")
    expect(result).toEqual({ ok: true, entries: [SRC, INDEX] })
  })

  it("filters hidden entries", async () => {
    const result = await loadDir(
      async () => [SRC, { name: "node_modules", path: "/proj/node_modules", isDirectory: true }],
      "/proj",
    )
    expect(result.ok && result.entries.map((e) => e.name)).toEqual(["src"])
  })

  it("returns permission denied instead of throwing", async () => {
    const result = await loadDir(failing("EACCES"), "/proj/secret")
    expect(result).toEqual({ ok: false, reason: "permission denied" })
  })

  it("returns not found instead of throwing", async () => {
    const result = await loadDir(failing("ENOENT"), "/proj/gone")
    expect(result).toEqual({ ok: false, reason: "not found" })
  })

  it("never rejects for a real missing directory", async () => {
    const result = await loadDir(readDir, "/definitely/not/here/at/all")
    expect(result.ok).toBe(false)
  })
})

describe("applyResult", () => {
  const empty: ChildrenMap = new Map()
  const noFailures: FailuresMap = new Map()

  it("stores entries and clears a previous failure", () => {
    const withFailure: FailuresMap = new Map([["/proj/src", "permission denied"]])
    const { children, failures } = applyResult(empty, withFailure, "/proj/src", {
      ok: true,
      entries: [INDEX],
    })
    expect(children.get("/proj/src")).toEqual([INDEX])
    expect(failures.has("/proj/src")).toBe(false)
  })

  it("records a failure and drops stale children", () => {
    const withChildren: ChildrenMap = new Map([["/proj/src", [INDEX] as DirEntry[]]])
    const { children, failures } = applyResult(withChildren, noFailures, "/proj/src", {
      ok: false,
      reason: "permission denied",
    })
    expect(children.has("/proj/src")).toBe(false)
    expect(failures.get("/proj/src")).toBe("permission denied")
  })

  it("does not mutate the input maps", () => {
    const children: ChildrenMap = new Map()
    const failures: FailuresMap = new Map()
    applyResult(children, failures, "/proj/src", { ok: true, entries: [INDEX] })
    expect(children.size).toBe(0)
    expect(failures.size).toBe(0)
  })
})