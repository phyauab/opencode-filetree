import { describe, it, expect } from "bun:test"
import { maxScroll, scrollByLine, scrollByPage } from "./scroll"

describe("maxScroll", () => {
  it("is zero when everything fits", () => {
    expect(maxScroll(10, 40)).toBe(0)
  })

  it("leaves the last screenful at the bottom", () => {
    expect(maxScroll(100, 40)).toBe(60)
  })

  it("never goes negative for a zero-height area", () => {
    expect(maxScroll(100, 0)).toBe(99)
  })

  it("is zero for an empty file", () => {
    expect(maxScroll(0, 40)).toBe(0)
  })
})

describe("scrollByLine", () => {
  // Review Focus #5: a runaway keypress must clamp, not run off the end.
  it("clamps at the end however far it is pushed", () => {
    expect(scrollByLine(0, 5000, 100, 40)).toBe(60)
  })

  // A file that fits the panel has no scrollable range at all, so the runaway
// keypress must land on 0 rather than on a non-zero offset.
it("cannot scroll a file that fits, however far it is pushed", () => {
  expect(scrollByLine(0, 5000, 12, 40)).toBe(0)
})

it("clamps at the start for a negative delta", () => {
    expect(scrollByLine(10, -5000, 100, 40)).toBe(0)
  })

  it("moves one line", () => {
    expect(scrollByLine(10, 1, 100, 40)).toBe(11)
  })
})

describe("scrollByPage", () => {
  it("moves half a screen", () => {
    expect(scrollByPage(0, 1, 100, 40)).toBe(20)
  })

  it("moves backwards", () => {
    expect(scrollByPage(20, -1, 100, 40)).toBe(0)
  })

  it("uses at least one line for a tiny viewport", () => {
    expect(scrollByPage(0, 1, 100, 1)).toBe(1)
  })

  it("clamps like the line step", () => {
    expect(scrollByPage(0, 1, 30, 40)).toBe(0)
  })
})