import { describe, it, expect } from "bun:test"
import { getFileIcon, getGitStatusIndicator, describeGitStatus, isHidden } from "./icons"

describe("isHidden", () => {
  it("hides node_modules", () => {
    expect(isHidden("node_modules", true)).toBe(true)
  })

  it("hides .git", () => {
    expect(isHidden(".git", true)).toBe(true)
  })

  it("hides dot-directories", () => {
    expect(isHidden(".idea", true)).toBe(true)
  })

  it("keeps dotfiles like .gitignore visible", () => {
    expect(isHidden(".gitignore", false)).toBe(false)
  })

  it("keeps .env visible", () => {
    expect(isHidden(".env", false)).toBe(false)
  })

  it("shows ordinary source directories", () => {
    expect(isHidden("src", true)).toBe(false)
  })

  it("shows ordinary files", () => {
    expect(isHidden("index.ts", false)).toBe(false)
  })

  it("shows dist-like names that are files", () => {
    expect(isHidden("dist", false)).toBe(false)
  })
})

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

  it("returns [D] for deleted files", () => {
    expect(getGitStatusIndicator("D")).toBe(" [D]")
  })
})

describe("describeGitStatus", () => {
  it("describes each porcelain code", () => {
    expect(describeGitStatus("M")).toBe("modified")
    expect(describeGitStatus("A")).toBe("added")
    expect(describeGitStatus("D")).toBe("deleted")
    expect(describeGitStatus("R")).toBe("renamed")
    expect(describeGitStatus("?")).toBe("untracked")
  })

  it("reports clean when there is no status", () => {
    expect(describeGitStatus(undefined)).toBe("clean")
  })

  it("passes through unknown codes", () => {
    expect(describeGitStatus("Z")).toBe("Z")
  })
})
