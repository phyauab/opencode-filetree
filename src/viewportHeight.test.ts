import { describe, it, expect } from "bun:test"
import { viewportHeightFor, heightForTerminal } from "./viewport"

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

  it("survives a NaN height", () => {
    expect(viewportHeightFor(Number.NaN, 0.6)).toBe(1)
  })
})

describe("heightForTerminal", () => {
  it("reserves room for the rest of the sidebar", () => {
    // 40 rows minus 14 reserved, at a 60% share.
    expect(heightForTerminal(40)).toBe(15)
  })

  it("scales with the terminal", () => {
    expect(heightForTerminal(100)).toBe(51)
  })

  it("still gives one row on a tiny terminal", () => {
    expect(heightForTerminal(4)).toBe(1)
  })
})