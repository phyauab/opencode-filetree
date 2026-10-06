import { describe, it, expect } from "bun:test"
import { viewportHeightFor } from "./FileTree"

describe("viewportHeightFor", () => {
  it("takes the given share of the available height", () => {
    expect(viewportHeightFor(100, 0.6)).toBe(60)
  })

  it("never returns fewer than one row", () => {
    expect(viewportHeightFor(0, 0.6)).toBe(1)
    expect(viewportHeightFor(-10, 0.6)).toBe(1)
  })

  it("truncates a fractional result", () => {
    expect(viewportHeightFor(35, 0.6)).toBe(21)
  })

  it("handles a small terminal", () => {
    expect(viewportHeightFor(20, 0.6)).toBe(12)
  })

  it("survives a NaN height by returning one row", () => {
    expect(viewportHeightFor(Number.NaN, 0.6)).toBe(1)
  })
})