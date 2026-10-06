import { describe, it, expect } from "bun:test"
import { restorePaths, persistPaths, shouldRestore, isRestorable } from "./layoutSync"

const ROOT = [
  { name: "src", path: "/proj/src", isDirectory: true },
  { name: "README.md", path: "/proj/README.md", isDirectory: false },
]

describe("restorePaths", () => {
  it("reads stored paths", () => {
    expect(restorePaths({ expanded: ["/proj/src"] })).toEqual(["/proj/src"])
  })

  it("returns nothing for missing data", () => {
    expect(restorePaths(undefined)).toEqual([])
  })
})

describe("persistPaths", () => {
  it("serializes the current expansion", () => {
    expect(persistPaths(new Set(["/proj/src", "/proj/docs"]))).toEqual([
      "/proj/src",
      "/proj/docs",
    ])
  })
})

describe("shouldRestore", () => {
  it("does not restore before the root has loaded", () => {
    expect(shouldRestore({ expanded: ["/proj/src"] }, new Set(), false)).toBe(false)
  })

  it("does not restore when nothing was stored", () => {
    expect(shouldRestore({ expanded: [] }, new Set(), true)).toBe(false)
    expect(shouldRestore(undefined, new Set(), true)).toBe(false)
  })

  it("restores when stored paths are absent from the current expansion", () => {
    expect(shouldRestore({ expanded: ["/proj/src"] }, new Set(), true)).toBe(true)
  })

  it("does not restore when the expansion already matches", () => {
    expect(shouldRestore({ expanded: ["/proj/src"] }, new Set(["/proj/src"]), true)).toBe(false)
  })

  it("restores when the expansion has a different size", () => {
    expect(shouldRestore({ expanded: ["/proj/src"] }, new Set(["/proj/a", "/proj/b"]), true)).toBe(
      true,
    )
  })
})

describe("isRestorable", () => {
  it("accepts a directory in the tree", () => {
    expect(isRestorable("/proj/src", ROOT)).toBe(true)
  })

  it("rejects a file", () => {
    expect(isRestorable("/proj/README.md", ROOT)).toBe(false)
  })

  it("rejects a path that is gone", () => {
    expect(isRestorable("/proj/deleted", ROOT)).toBe(false)
  })
})