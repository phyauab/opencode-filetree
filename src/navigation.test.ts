import { describe, it, expect } from "bun:test"
import { createTreeState } from "./store"

describe("createTreeState", () => {
  it("returns currentEntry at the cursor position", () => {
    const state = createTreeState()
    state.setEntries([
      { name: "src", path: "/proj/src", isDirectory: true },
      { name: "index.ts", path: "/proj/index.ts", isDirectory: false },
    ])

    state.setCursor(0)
    expect(state.currentEntry()?.name).toBe("src")

    state.setCursor(1)
    expect(state.currentEntry()?.name).toBe("index.ts")
  })

  it("returns undefined when cursor is out of bounds", () => {
    const state = createTreeState()
    state.setEntries([{ name: "src", path: "/proj/src", isDirectory: true }])
    state.setCursor(5)
    expect(state.currentEntry()).toBeUndefined()
  })

  it("returns undefined when there are no entries", () => {
    const state = createTreeState()
    expect(state.currentEntry()).toBeUndefined()
  })

  it("clampCursor pulls the cursor back when the tree shrinks", () => {
    const state = createTreeState()
    const children = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}.ts`,
      path: `/proj/src/f${i}.ts`,
      isDirectory: false,
    }))
    state.setEntries([{ name: "src", path: "/proj/src", isDirectory: true }])
    state.setChildrenMap(new Map([["/proj/src", children]]))
    state.setExpanded(new Set(["/proj/src"]))

    state.setCursor(10)
    expect(state.currentEntry()?.name).toBe("f9.ts")

    // The tree shrinks underneath the cursor, as it does when files are deleted.
    state.setChildrenMap(new Map([["/proj/src", children.slice(0, 2)]]))
    expect(state.currentEntry()).toBeUndefined()

    state.clampCursor()
    expect(state.currentEntry()?.name).toBe("f1.ts")
  })

  it("clampCursor resets to 0 when the tree empties", () => {
    const state = createTreeState()
    state.setEntries([{ name: "src", path: "/proj/src", isDirectory: true }])
    state.setCursor(3)

    state.setEntries([])
    state.clampCursor()
    expect(state.cursor()).toBe(0)
  })

  it("clampCursor leaves an in-range cursor alone", () => {
    const state = createTreeState()
    state.setEntries([
      { name: "a", path: "/proj/a", isDirectory: false },
      { name: "b", path: "/proj/b", isDirectory: false },
    ])
    state.setCursor(1)
    state.clampCursor()
    expect(state.cursor()).toBe(1)
  })

  it("renders only the rows that fit, following the cursor", () => {
    const state = createTreeState()
    state.setEntries(
      Array.from({ length: 100 }, (_, i) => ({
        name: `f${i}.ts`,
        path: `/proj/f${i}.ts`,
        isDirectory: false,
      })),
    )
    state.setViewportHeight(20)

    expect(state.viewport()).toEqual({ start: 0, end: 20 })

    state.setCursor(50)
    expect(state.viewport()).toEqual({ start: 31, end: 51 })
  })

  it("keeps the view still while the cursor moves within it", () => {
    const state = createTreeState()
    state.setEntries(
      Array.from({ length: 100 }, (_, i) => ({
        name: `f${i}.ts`,
        path: `/proj/f${i}.ts`,
        isDirectory: false,
      })),
    )
    state.setViewportHeight(20)

    state.setCursor(50)
    // Window covers indices 31..50 inclusive.
    const first = state.viewport()
    expect(first).toEqual({ start: 31, end: 51 })

    state.setCursor(35)
    expect(state.viewport()).toEqual(first)
    state.setCursor(50)
    expect(state.viewport()).toEqual(first)
  })

  it("always renders the cursor row", () => {
    const state = createTreeState()
    state.setEntries(
      Array.from({ length: 200 }, (_, i) => ({
        name: `f${i}.ts`,
        path: `/proj/f${i}.ts`,
        isDirectory: false,
      })),
    )
    state.setViewportHeight(15)

    for (let cursor = 0; cursor < 200; cursor++) {
      state.setCursor(cursor)
      const view = state.viewport()
      expect(view.start).toBeLessThanOrEqual(cursor)
      expect(view.end).toBeGreaterThan(cursor)
    }
  })

  it("renders everything when the tree fits the panel", () => {
    const state = createTreeState()
    state.setEntries([
      { name: "a.ts", path: "/proj/a.ts", isDirectory: false },
      { name: "b.ts", path: "/proj/b.ts", isDirectory: false },
    ])
    state.setViewportHeight(20)
    expect(state.viewport()).toEqual({ start: 0, end: 2 })
  })

  it("reflects a shrinking panel height", () => {
    const state = createTreeState()
    state.setEntries(
      Array.from({ length: 100 }, (_, i) => ({
        name: `f${i}.ts`,
        path: `/proj/f${i}.ts`,
        isDirectory: false,
      })),
    )
    state.setViewportHeight(40)
    state.setCursor(0)
    expect(state.viewport().end).toBe(40)

    state.setViewportHeight(10)
    expect(state.viewport()).toEqual({ start: 0, end: 10 })
  })

  it("reflects expanded folders in visibleNodes", () => {
    const state = createTreeState()
    state.setEntries([{ name: "src", path: "/proj/src", isDirectory: true }])
    state.setChildrenMap(
      new Map([["/proj/src", [{ name: "app.ts", path: "/proj/src/app.ts", isDirectory: false }]]]),
    )

    state.setExpanded(new Set<string>())
    expect(state.visibleNodes()).toHaveLength(1)

    state.setExpanded(new Set(["/proj/src"]))
    expect(state.visibleNodes()).toHaveLength(2)
  })
})