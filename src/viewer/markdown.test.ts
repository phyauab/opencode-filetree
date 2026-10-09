import { describe, it, expect } from "bun:test"
import { isMarkdown, buildSyntaxStyle, type MarkdownTheme } from "./markdown"
import { SyntaxStyle } from "@opentui/core"
import { syntaxStyleAllocations } from "../../scripts/test-stubs"

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

  // Review focus #2, for the one row that reads a second token. Every other row
  // takes a foreground alone, so the only way to half-fill one is here.
  it("gives inline code a background when the theme carries one", () => {
    const scopes = scopesOf(buildSyntaxStyle({ markdown: { code: "#98c379" }, background: { base: "#1e222a" } }))
    expect(scopes.get("markup.raw.inline")).toEqual({ foreground: "#98c379", background: "#1e222a" })
    // The block form shares the foreground and takes no background at all.
    expect(scopes.get("markup.raw")).toEqual({ foreground: "#98c379" })
  })

  it("drops the inline-code row whole when the theme has no background", () => {
    const scopes = scopesOf(buildSyntaxStyle({ markdown: { code: "#98c379" } }))
    expect(scopes.has("markup.raw.inline")).toBe(false)
    expect(scopes.get("markup.raw")).toEqual({ foreground: "#98c379" })
  })

  it("treats an empty string as a token that is not there", () => {
    const scopes = scopesOf(buildSyntaxStyle({ syntax: { comment: "", keyword: "#c678dd" } }))
    expect(scopes.has("comment")).toBe(false)
    expect(scopes.get("keyword")).toEqual({ foreground: "#c678dd" })
  })
})

describe("buildSyntaxStyle cost", () => {
  // Every assertion in this block is a count rather than an identity. The stub
  // hands the same object back from `create()`, so `toBe(SyntaxStyle.create())`
  // in the block above passes whether or not anything is reused -- which is
  // exactly how an un-memoised empty theme, one native handle per viewer mount,
  // got through a review that only read those.

  it("costs one construction per distinct theme, the empty one included", () => {
    // Colours no other test in this file uses, so both are cache misses however
    // warm the module already is by the time this runs.
    const coldA = { syntax: { comment: "#010203" } }
    const coldB = { syntax: { comment: "#040506" } }
    const start = syntaxStyleAllocations()

    // Pairs for the two themed cases, so a repeat of the *current* theme is
    // measurable without depending on the order the others ran in. The cache
    // holds one entry -- one plugin, one theme at a time -- so returning to a
    // theme after a different one has been built is a miss and a fresh build.
    const first = buildSyntaxStyle(coldA)
    expect(buildSyntaxStyle(coldA)).toBe(first)
    const second = buildSyntaxStyle(coldB)
    expect(buildSyntaxStyle(coldB)).toBe(second)
    expect(second).not.toBe(first)

    // An empty object and no theme at all are the same theme as far as the table
    // is concerned, so neither of these is another construction.
    const empty = buildSyntaxStyle(undefined)
    buildSyntaxStyle(undefined)
    buildSyntaxStyle({})

    expect(syntaxStyleAllocations() - start).toBe(3)
    expect(buildSyntaxStyle(undefined)).toBe(empty)
  })

  it("allocates once for a themed call and not again while the theme stands", () => {
    const theme = { syntax: { string: "#070809" } }
    const start = syntaxStyleAllocations()

    const first = buildSyntaxStyle(theme)
    buildSyntaxStyle(theme)
    buildSyntaxStyle(theme)

    expect(syntaxStyleAllocations() - start).toBe(1)
    expect(buildSyntaxStyle(theme)).toBe(first)
  })

  it("allocates again once the theme actually changes", () => {
    // Colours of their own, as in the first test: one the test above has already
    // cached would cost nothing here and the count would lie.
    const start = syntaxStyleAllocations()

    const first = buildSyntaxStyle({ syntax: { string: "#131415" } })
    const second = buildSyntaxStyle({ syntax: { string: "#161718" } })

    expect(syntaxStyleAllocations() - start).toBe(2)
    expect(second).not.toBe(first)
  })
})

describe("buildSyntaxStyle when the theme cannot be read", () => {
  // A getter that throws is the only way in without a constructor or a Proxy,
  // and it is not contrived: `ctx.theme` is a large object the host builds from
  // a user's config, so anything it computes is fair game for a bad value
  // underneath. It reaches the catch because the key is the first thing read.
  const throwingTheme = {
    get syntax(): Record<string, string> {
      throw new Error("boom")
    },
  }

  // First in the block on purpose. The fallback it pins is a session-wide
  // singleton, so every test after this one meets it already built and would
  // count zero here -- this is the only one that can count from cold.
  it("costs one allocation for a throwing theme however often it repeats", () => {
    const start = syntaxStyleAllocations()

    buildSyntaxStyle(throwingTheme as MarkdownTheme)
    buildSyntaxStyle(throwingTheme as MarkdownTheme)
    buildSyntaxStyle(throwingTheme as MarkdownTheme)

    expect(syntaxStyleAllocations() - start).toBe(1)
  })

  it("does not throw, and hands back a usable style", () => {
    const style = buildSyntaxStyle(throwingTheme as MarkdownTheme)
    expect(style).toBe(SyntaxStyle.create())
    // "Usable" means the scopes walk below is an empty list rather than
    // undefined, so a caller reading `style.scopes` gets a list and not a crash.
    expect(scopesOf(style).size).toBe(0)
  })

  it("does not let a bad theme poison the cache for every theme after it", () => {
    // The assertion that matters most. A fallback that overwrote `cached` rather
    // than sitting beside it would leave markdown uncoloured for the rest of the
    // session, and every identity assertion in this file would still pass.
    buildSyntaxStyle(throwingTheme as MarkdownTheme)

    // A colour no other test uses, so this is a real build and not a re-read of
    // a cached entry: the whole path has to run after the throw. `.not.toBe` is
    // the part that can fail -- the stub shares one object for `create()`, so a
    // return path that had been left on the fallback would compare equal here.
    const scopes = scopesOf(buildSyntaxStyle({ syntax: { keyword: "#1b1c1d" } }))
    expect(scopes.get("keyword")).toEqual({ foreground: "#1b1c1d" })
    expect(buildSyntaxStyle({ syntax: { keyword: "#1b1c1d" } })).not.toBe(SyntaxStyle.create())
  })
})
