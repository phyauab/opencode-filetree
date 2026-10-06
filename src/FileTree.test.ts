import { describe, it, expect } from "bun:test"
import { computeVisibleNodes, moveCursor, toggleExpand, type VisibleNode } from "./treeLogic"
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
