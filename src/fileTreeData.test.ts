import { describe, it, expect } from "bun:test"
import { filterVisible, describeReadError } from "./fileTreeData"

const file = (name: string) => ({ name, path: `/proj/${name}`, isDirectory: false })
const dir = (name: string) => ({ name, path: `/proj/${name}`, isDirectory: true })

describe("filterVisible", () => {
  it("hides node_modules", () => {
    expect(filterVisible([dir("node_modules"), file("index.ts")]).map((e) => e.name)).toEqual([
      "index.ts",
    ])
  })

  it("hides .git and other dot-directories", () => {
    expect(filterVisible([dir(".git"), dir(".idea"), dir("src")]).map((e) => e.name)).toEqual(["src"])
  })

  it("keeps dotfiles", () => {
    expect(filterVisible([file(".gitignore"), file(".env")])).toHaveLength(2)
  })

  it("passes through ordinary files and directories", () => {
    const input = [dir("src"), file("README.md")]
    expect(filterVisible(input)).toEqual(input)
  })
})

describe("describeReadError", () => {
  const withCode = (code: string) => Object.assign(new Error("x"), { code })

  it("describes permission failures", () => {
    expect(describeReadError(withCode("EACCES"))).toBe("permission denied")
    expect(describeReadError(withCode("EPERM"))).toBe("permission denied")
  })

  it("describes a missing directory", () => {
    expect(describeReadError(withCode("ENOENT"))).toBe("not found")
  })

  it("falls back to unreadable", () => {
    expect(describeReadError(withCode("EIO"))).toBe("unreadable")
    expect(describeReadError(new Error("boom"))).toBe("unreadable")
    expect(describeReadError(undefined)).toBe("unreadable")
  })
})