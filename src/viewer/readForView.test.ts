import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readForView, MAX_VIEW_LINES } from "./readForView"

const created: string[] = []
afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

function makeFile(contents: string | Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "viewer-"))
  created.push(root)
  const path = join(root, "f.txt")
  writeFileSync(path, contents)
  return path
}

describe("readForView", () => {
  it("reads a small text file into lines", () => {
    const result = readForView(makeFile("one\ntwo\nthree\n"))
    expect(result.kind).toBe("text")
    if (result.kind !== "text") return
    expect(result.lines).toEqual(["one", "two", "three"])
    expect(result.truncated).toBe(false)
  })

  it("reports one line for a file with no trailing newline", () => {
    const result = readForView(makeFile("only"))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["only"])
  })

  it("keeps an interior blank line and drops the trailing one", () => {
    const result = readForView(makeFile("a\n\nb\n"))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["a", "", "b"])
  })

  it("caps lines and says it truncated", () => {
    const result = readForView(makeFile("x\n".repeat(MAX_VIEW_LINES + 50)), { maxLines: 10 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toHaveLength(10)
    expect(result.truncated).toBe(true)
  })

  it("does not claim truncation when content fits exactly", () => {
    const result = readForView(makeFile("x\n".repeat(10)), { maxLines: 10, maxBytes: 1_000_000 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.truncated).toBe(false)
  })

  // Review Focus #2: the notice must depend on bytes actually being dropped,
  // so the cap has to be checked on both sides of the boundary.
  it("does not claim truncation for a file exactly at the byte cap", () => {
    const result = readForView(makeFile("y".repeat(100)), { maxBytes: 100 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["y".repeat(100)])
    expect(result.truncated).toBe(false)
  })

  it("claims truncation for a file one byte past the byte cap", () => {
    const result = readForView(makeFile("y".repeat(101)), { maxBytes: 100 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.truncated).toBe(true)
    // Exactly the cap survives: the cut lands on the cap, not near it, and a
    // reader that kept 99 or 101 bytes would still satisfy the assertion above.
    expect(result.lines).toEqual(["y".repeat(100)])
  })

  it("caps bytes and says it truncated", () => {
    const result = readForView(makeFile("y".repeat(5000)), { maxBytes: 100, maxLines: 1000 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.truncated).toBe(true)
    expect(result.lines[0]!.length).toBeLessThanOrEqual(100)
  })

  // The repo's working tree is CRLF (`git ls-files --eol` reports w/crlf on
  // FileTree.tsx, TreeNode.tsx and tui.tsx), so most files opened in this
  // project carry "\r\n". These pin that the CR never reaches a consumer.
  it("drops the carriage return from CRLF line endings", () => {
    const result = readForView(makeFile("a\r\nb\r\n"))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["a", "b"])
  })

  it("drops the CR from a CRLF interior blank line too", () => {
    const result = readForView(makeFile("a\r\n\r\nb\r\n"))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["a", "", "b"])
  })

  it("drops only the CR that pairs with the newline", () => {
    const result = readForView(makeFile("a\r\r\n"))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual(["a\r"])
  })

  it("detects binary content by a NUL byte", () => {
    const result = readForView(makeFile(Buffer.from([0x41, 0x00, 0x42])))
    expect(result.kind).toBe("binary")
  })

  it("returns an error for a path that does not exist", () => {
    const missing = join(tmpdir(), "definitely-not-here-9f3a")
    // The whole object, not just the kind: Review Focus #1 asks for a readable
    // message, and only `reason` carries it. A regression to String(error)
    // would still pass a kind-only assertion.
    expect(readForView(missing)).toEqual({ kind: "error", path: missing, reason: "not found" })
  })

  it("returns an error for a directory rather than throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "viewer-"))
    created.push(root)
    const sub = join(root, "sub")
    mkdirSync(sub)
    expect(readForView(sub)).toEqual({ kind: "error", path: sub, reason: "is a directory" })
  })

  it("reports totalLines as the lines present, not the file's real count", () => {
    const result = readForView(makeFile("x\n".repeat(40)), { maxLines: 10 })
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.totalLines).toBe(10)
  })

  it("reads an empty file as one empty line", () => {
    const result = readForView(makeFile(""))
    if (result.kind !== "text") throw new Error("expected text")
    expect(result.lines).toEqual([""])
    expect(result.truncated).toBe(false)
  })
})