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