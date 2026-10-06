import { describe, it, expect } from "bun:test"
import { isInsideRoot, restorablePaths } from "./layoutSync"

describe("isInsideRoot", () => {
  it("accepts a child path", () => {
    expect(isInsideRoot("C:/proj/src", "C:/proj")).toBe(true)
  })

  it("accepts a deeply nested path", () => {
    expect(isInsideRoot("C:/proj/src/components", "C:/proj")).toBe(true)
  })

  it("rejects the root itself", () => {
    expect(isInsideRoot("C:/proj", "C:/proj")).toBe(false)
  })

  it("rejects a sibling with a shared prefix", () => {
    expect(isInsideRoot("C:/project/src", "C:/proj")).toBe(false)
  })

  it("rejects a path outside the root", () => {
    expect(isInsideRoot("C:/proj/src", "D:/other")).toBe(false)
  })

  it("handles Windows separators", () => {
    expect(isInsideRoot("C:\\proj\\src", "C:\\proj")).toBe(true)
    expect(isInsideRoot("C:\\proj", "C:\\proj")).toBe(false)
  })

  it("handles a trailing separator on the root", () => {
    expect(isInsideRoot("C:/proj/src", "C:/proj/")).toBe(true)
  })
})

describe("restorablePaths", () => {
  const entries = [{ name: "src", path: "C:/proj/src", isDirectory: true }]

  it("keeps a directory inside the root", () => {
    expect(restorablePaths(["C:/proj/src"], entries, "C:/proj")).toEqual(["C:/proj/src"])
  })

  it("drops a path outside the project", () => {
    expect(restorablePaths(["C:\\proj\\src"], entries, "C:/proj")).toEqual([])
  })

  it("drops a path that is not in the root listing", () => {
    expect(restorablePaths(["C:/proj/gone"], entries, "C:/proj")).toEqual([])
  })

  it("drops a file, not only directories", () => {
    const withFile = [...entries, { name: "a.txt", path: "C:/proj/a.txt", isDirectory: false }]
    expect(restorablePaths(["C:/proj/a.txt"], withFile, "C:/proj")).toEqual([])
  })
})