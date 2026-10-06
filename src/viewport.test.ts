import { describe, it, expect } from "bun:test"
import { computeViewport, viewportHeight, visibleRowIndices, scrollForCursor } from "./viewport"

describe("viewportHeight", () => {
  it("uses the given height", () => {
    expect(viewportHeight(30)).toBe(30)
  })

  it("never drops below one row", () => {
    expect(viewportHeight(0)).toBe(1)
    expect(viewportHeight(-5)).toBe(1)
  })

  it("truncates a fractional height", () => {
    expect(viewportHeight(20.7)).toBe(20)
  })
})

describe("computeViewport", () => {
  it("shows everything when the tree fits", () => {
    expect(computeViewport(5, 2, 20, 0)).toEqual({ start: 0, end: 5 })
  })

  it("shows everything when the tree exactly fits", () => {
    expect(computeViewport(20, 19, 20, 0)).toEqual({ start: 0, end: 20 })
  })

  it("starts at the top with the cursor near the start", () => {
    expect(computeViewport(100, 5, 20, 0)).toEqual({ start: 0, end: 20 })
  })

  it("does not scroll when the cursor is already visible", () => {
    // Cursor sits at row 10 inside rows 0-19.
    expect(computeViewport(100, 10, 20, 0)).toEqual({ start: 0, end: 20 })
  })

  it("scrolls down when the cursor moves past the bottom", () => {
    // Row 25 needs rows 6-25.
    expect(computeViewport(100, 25, 20, 0)).toEqual({ start: 6, end: 26 })
  })

  it("carries a stored offset forward when the cursor stays visible", () => {
    // Stored offset 40, cursor 45: no change needed.
    expect(computeViewport(100, 45, 20, 40)).toEqual({ start: 40, end: 60 })
  })

  it("scrolls back up when the cursor moves above the window", () => {
    // Stored offset 40, cursor 5: jump so row 5 is at the top.
    expect(computeViewport(100, 5, 20, 40)).toEqual({ start: 5, end: 25 })
  })

  it("puts the cursor on the last row at the end of the tree", () => {
    const view = computeViewport(100, 99, 20, 0)
    expect(view).toEqual({ start: 80, end: 100 })
    expect(view.end).toBe(100)
  })

  it("never runs past the last row near the end", () => {
    const view = computeViewport(100, 99, 20, 90)
    expect(view.end).toBeLessThanOrEqual(100)
    expect(view.start).toBeGreaterThanOrEqual(0)
  })

  it("always includes the cursor", () => {
    for (let cursor = 0; cursor < 100; cursor++) {
      const view = computeViewport(100, cursor, 20, cursor > 5 ? cursor - 3 : 0)
      expect(view.start).toBeLessThanOrEqual(cursor)
      expect(view.end).toBeGreaterThan(cursor)
    }
  })

  it("tolerates a cursor past the end", () => {
    const view = computeViewport(10, 999, 5, 0)
    expect(view).toEqual({ start: 5, end: 10 })
  })

  it("handles a single-row viewport", () => {
    expect(computeViewport(100, 50, 1, 0)).toEqual({ start: 50, end: 51 })
  })

  it("handles an empty tree", () => {
    expect(computeViewport(0, 0, 20, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe("visibleRowIndices", () => {
  it("lists the rows in the window", () => {
    expect(visibleRowIndices(100, { start: 6, end: 26 })).toHaveLength(20)
    expect(visibleRowIndices(100, { start: 6, end: 26 })[0]).toBe(6)
  })

  it("clamps to the tree bounds", () => {
    expect(visibleRowIndices(10, { start: 5, end: 50 })).toEqual([5, 6, 7, 8, 9])
  })

  it("returns nothing for an empty tree", () => {
    expect(visibleRowIndices(0, { start: 0, end: 20 })).toEqual([])
  })
})

describe("scrollForCursor", () => {
  it("returns 0 when the tree fits", () => {
    expect(scrollForCursor(5, 3, 20)).toBe(0)
  })

  it("puts the cursor on the last row", () => {
    expect(scrollForCursor(100, 50, 20)).toBe(31)
  })

  it("clamps at the end of the tree", () => {
    expect(scrollForCursor(100, 99, 20)).toBe(80)
  })
})