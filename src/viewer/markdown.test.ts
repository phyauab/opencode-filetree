import { describe, it, expect } from "bun:test"
import { isMarkdown, buildSyntaxStyle } from "./markdown"
import { SyntaxStyle } from "@opentui/core"

/** The scopes the stubbed SyntaxStyle recorded, keyed for lookup. */
const scopesOf = (style: any): Map<string, any> => {
  const map = new Map<string, any>()
  for (const entry of style.scopes) for (const scope of entry.scope) map.set(scope, entry.style)
  return map
}

const fullTheme = {
  text: { base: "#ffffff" },
  syntax: {
    comment: "#5c6370", keyword: "#c678dd", function: "#61afef", variable: "#abb2bf",
    string: "#98c379", number: "#d19a66", type: "#e5c07b", operator: "#56b6c2",
    punctuation: "#abb2bf",
  },
  markdown: {
    heading: "#e06c75", strong: "#e06c75", emphasis: "#e5c07b", code: "#98c379",
    blockQuote: "#5c6370", link: "#61afef", linkText: "#61afef", listItem: "#e5c07b",
  },
}

describe("isMarkdown", () => {
  it("is true for md and markdown", () => {
    expect(isMarkdown("README.md")).toBe(true)
    expect(isMarkdown("docs/notes.markdown")).toBe(true)
  })

  it("is false for every other extension", () => {
    expect(isMarkdown("a.ts")).toBe(false)
    expect(isMarkdown("a.mdx")).toBe(false)
    expect(isMarkdown("Makefile")).toBe(false)
  })
})

describe("buildSyntaxStyle", () => {
  it("maps the host's syntax tokens onto the scopes the host itself uses", () => {
    const scopes = scopesOf(buildSyntaxStyle(fullTheme))
    expect(scopes.get("comment")).toEqual({ foreground: "#5c6370", italic: true })
    expect(scopes.get("keyword")).toEqual({ foreground: "#c678dd" })
    expect(scopes.get("string")).toEqual({ foreground: "#98c379" })
    expect(scopes.get("number")).toEqual({ foreground: "#d19a66" })
    expect(scopes.get("function")).toEqual({ foreground: "#61afef" })
    expect(scopes.get("punctuation")).toEqual({ foreground: "#abb2bf" })
  })

  it("maps the markdown tokens onto the markup scopes", () => {
    const scopes = scopesOf(buildSyntaxStyle(fullTheme))
    expect(scopes.get("markup.heading")).toEqual({ foreground: "#e06c75", bold: true })
    expect(scopes.get("markup.heading.1")).toEqual({ foreground: "#e06c75", bold: true, underline: true })
    expect(scopes.get("markup.bold")).toEqual({ foreground: "#e06c75", bold: true })
    expect(scopes.get("markup.italic")).toEqual({ foreground: "#e5c07b", italic: true })
    expect(scopes.get("markup.quote")).toEqual({ foreground: "#5c6370", italic: true })
    expect(scopes.get("markup.raw")).toEqual({ foreground: "#98c379" })
  })

  it("returns the empty style when there is no theme at all", () => {
    expect(buildSyntaxStyle(undefined)).toBe(SyntaxStyle.create())
  })

  it("returns the empty style when the theme carries no tokens this table reads", () => {
    // An empty theme is not a reason to show raw markdown source: the host's own
    // fallback is the empty style, and markdown still renders its structure.
    expect(buildSyntaxStyle({})).toBe(SyntaxStyle.create())
    expect(buildSyntaxStyle({ text: {} })).toBe(SyntaxStyle.create())
  })

  it("skips tokens the theme does not carry instead of guessing colours", () => {
    const scopes = scopesOf(buildSyntaxStyle({ syntax: { comment: "#111111" } }))
    expect(scopes.get("comment")).toEqual({ foreground: "#111111", italic: true })
    expect(scopes.has("string")).toBe(false)
    expect(scopes.has("markup.heading")).toBe(false)
  })

  it("memoises on the token values, so a theme change is picked up", () => {
    const first = buildSyntaxStyle(fullTheme)
    expect(buildSyntaxStyle(fullTheme)).toBe(first)
    const second = buildSyntaxStyle({ ...fullTheme, syntax: { ...fullTheme.syntax, keyword: "#ff0000" } })
    expect(second).not.toBe(first)
    expect(scopesOf(second).get("keyword")).toEqual({ foreground: "#ff0000" })
  })
})
