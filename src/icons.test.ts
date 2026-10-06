import { describe, it, expect } from "bun:test"
import { getFileIcon, getGitStatusIndicator } from "./icons"

describe("getFileIcon", () => {
  it("returns folder icon for directories", () => {
    expect(getFileIcon("src", true)).toBe("📁")
  })

  it("returns TypeScript icon for .ts files", () => {
    expect(getFileIcon("index.ts", false)).toBe("📘")
  })

  it("returns JSON icon for .json files", () => {
    expect(getFileIcon("package.json", false)).toBe("📋")
  })

  it("returns default icon for unknown extensions", () => {
    expect(getFileIcon("data.xyz", false)).toBe("📄")
  })

  it("handles files without extension", () => {
    expect(getFileIcon("Makefile", false)).toBe("📄")
  })
})

describe("getGitStatusIndicator", () => {
  it("returns empty string for undefined status", () => {
    expect(getGitStatusIndicator(undefined)).toBe("")
  })

  it("returns [M] for modified files", () => {
    expect(getGitStatusIndicator("M")).toBe(" [M]")
  })

  it("returns [A] for added files", () => {
    expect(getGitStatusIndicator("A")).toBe(" [A]")
  })

  it("returns [?] for untracked files", () => {
    expect(getGitStatusIndicator("?")).toBe(" [?]")
  })
})
