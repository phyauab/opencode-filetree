import { describe, it, expect } from "bun:test"
import { resolveDirectory, describeEmpty, type EmptyReason } from "./emptyState"

/** Minimal stand-in for the parts of the plugin context that matter here. */
function makeContext(
  location: { directory: string } | undefined,
  fallback?: { directory: string },
) {
  return {
    location,
    data: { location: { default: () => fallback } },
  } as never
}

describe("resolveDirectory", () => {
  it("uses context.location when present", () => {
    expect(resolveDirectory(makeContext({ directory: "/proj" }))).toBe("/proj")
  })

  it("falls back to the data layer's default location", () => {
    expect(resolveDirectory(makeContext(undefined, { directory: "/fallback" }))).toBe("/fallback")
  })

  it("prefers location over the fallback", () => {
    const context = makeContext({ directory: "/proj" }, { directory: "/fallback" })
    expect(resolveDirectory(context)).toBe("/proj")
  })

  it("returns undefined when neither is available", () => {
    expect(resolveDirectory(makeContext(undefined))).toBeUndefined()
  })
})

describe("describeEmpty", () => {
  const cases: [EmptyReason, string][] = [
    [{ kind: "no-location" }, "no project directory"],
    [{ kind: "loading" }, "loading..."],
    [{ kind: "unreadable", reason: "permission denied" }, "unreadable: permission denied"],
    [{ kind: "empty" }, "no files"],
  ]

  for (const [reason, expected] of cases) {
    it(`reports "${expected}"`, () => {
      expect(describeEmpty(reason, 0, 20)).toBe(expected)
    })
  }

  it("distinguishes a panel too short to show rows", () => {
    expect(describeEmpty({ kind: "empty" }, 3, 0)).toBe("panel too short")
  })

  it("includes the resolved directory so a stuck tree is diagnosable", () => {
    expect(describeEmpty({ kind: "loading" }, 0, 20, "C:/proj")).toBe("loading (C:/proj)")
    expect(describeEmpty({ kind: "empty" }, 0, 20, "C:/proj")).toBe("no files (C:/proj)")
  })

  it("omits the directory when there is none", () => {
    expect(describeEmpty({ kind: "no-location" }, 0, 20, undefined)).toBe("no project directory")
  })
})