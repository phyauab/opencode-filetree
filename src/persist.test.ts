import { describe, it, expect } from "bun:test"
import { readLayout, writeLayout, layoutKey } from "./persist"

describe("layoutKey", () => {
  it("namespaces the key by project directory", () => {
    expect(layoutKey("/proj")).toBe("filetree:layout:/proj")
  })

  it("gives different projects different keys", () => {
    expect(layoutKey("/a")).not.toBe(layoutKey("/b"))
  })
})

describe("readLayout", () => {
  it("returns an empty layout for undefined", () => {
    expect(readLayout(undefined)).toEqual({ expanded: [] })
  })

  it("returns an empty layout for a non-object", () => {
    expect(readLayout("nonsense")).toEqual({ expanded: [] })
    expect(readLayout(42)).toEqual({ expanded: [] })
  })

  it("returns an empty layout when expanded is not an array", () => {
    expect(readLayout({ expanded: "src" })).toEqual({ expanded: [] })
  })

  it("reads a stored layout", () => {
    expect(readLayout({ expanded: ["/proj/src"] })).toEqual({ expanded: ["/proj/src"] })
  })

  it("drops non-string members", () => {
    expect(readLayout({ expanded: ["/proj/src", 42, null] })).toEqual({ expanded: ["/proj/src"] })
  })
})

describe("writeLayout", () => {
  it("serializes a set", () => {
    expect(writeLayout(new Set(["/a", "/b"]))).toEqual({ expanded: ["/a", "/b"] })
  })

  it("round-trips through readLayout", () => {
    expect(readLayout(writeLayout(new Set(["/a"])))).toEqual({ expanded: ["/a"] })
  })

  it("serializes an empty set", () => {
    expect(writeLayout(new Set())).toEqual({ expanded: [] })
  })
})