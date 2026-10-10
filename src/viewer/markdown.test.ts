import { describe, it, expect } from "bun:test"
import { isMarkdown, buildSyntaxStyle, type MarkdownTheme } from "./markdown"
import { SyntaxStyle, type RGBA } from "@opentui/core"
import { syntaxStyleAllocations } from "../../scripts/test-stubs"

/** The scopes the stubbed SyntaxStyle recorded, keyed for lookup. */
const scopesOf = (style: any): Map<string, any> => {
  const map = new Map<string, any>()
  for (const entry of style.scopes) for (const scope of entry.scope) map.set(scope, entry.style)
  return map
}

/**
 * An `RGBA`, in the shape the host resolves its theme colours to.
 *
 * The real class keeps channels in a `Uint16Array` and exposes them as 0..1
 * getters (`@opentui/core`, `class RGBA`); this reproduces that shape exactly,
 * getters included, because reading those getters is what `tokenValue` does.
 * The stub `@opentui/core` exports no `RGBA`, so the real class is not
 * importable here -- and a fixture of plain hex strings is what let the
 * string-shaped `MarkdownTheme` look correct while the live host rendered
 * every markdown file white, so the shape is the fixture's whole point.
 */
const rgbaHex = (hex: string): RGBA => {
  const value = Number.parseInt(hex.slice(1), 16)
  const buffer = new Uint16Array([(value >> 16) & 255, (value >> 8) & 255, value & 255, 255])
  // One cast, confined to this fixture factory: the object reproduces the
  // channels the reader reads and the class's own storage, and the rest of the
  // class (`toInts`, `meta`, ...) is never touched on this path -- what the
  // tests need is the shape `tokenValue` accepts, not a second implementation
  // of the class.
  return {
    buffer,
    get r() {
      return (buffer[0] & 255) / 255
    },
    get g() {
      return (buffer[1] & 255) / 255
    },
    get b() {
      return (buffer[2] & 255) / 255
    },
    get a() {
      return (buffer[3] & 255) / 255
    },
  } as unknown as RGBA
}

const fullTheme = {
  text: { base: rgbaHex("#ffffff") },
  syntax: {
    comment: rgbaHex("#5c6370"), keyword: rgbaHex("#c678dd"), function: rgbaHex("#61afef"), variable: rgbaHex("#abb2bf"),
    string: rgbaHex("#98c379"), number: rgbaHex("#d19a66"), type: rgbaHex("#e5c07b"), operator: rgbaHex("#56b6c2"),
    punctuation: rgbaHex("#abb2bf"),
  },
  markdown: {
    heading: rgbaHex("#e06c75"), strong: rgbaHex("#e06c75"), emphasis: rgbaHex("#e5c07b"), code: rgbaHex("#98c379"),
    blockQuote: rgbaHex("#5c6370"), link: rgbaHex("#61afef"), linkText: rgbaHex("#61afef"), listItem: rgbaHex("#e5c07b"),
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
    expect(scopes.get("comment")).toEqual({ foreground: rgbaHex("#5c6370"), italic: true })
    // A bare `keyword` is italic in the host's bridge and this table's two
    // keyword rows now match it row for row; the import/escape/regex group
    // beside it is the plain one.
    expect(scopes.get("keyword")).toEqual({ foreground: rgbaHex("#c678dd"), italic: true })
    expect(scopes.get("keyword.import")).toEqual({ foreground: rgbaHex("#c678dd") })
    expect(scopes.get("string")).toEqual({ foreground: rgbaHex("#98c379") })
    expect(scopes.get("number")).toEqual({ foreground: rgbaHex("#d19a66") })
    expect(scopes.get("function")).toEqual({ foreground: rgbaHex("#61afef") })
    expect(scopes.get("punctuation")).toEqual({ foreground: rgbaHex("#abb2bf") })
  })

  it("maps the markdown tokens onto the markup scopes", () => {
    const scopes = scopesOf(buildSyntaxStyle(fullTheme))
    expect(scopes.get("markup.heading")).toEqual({ foreground: rgbaHex("#e06c75"), bold: true })
    expect(scopes.get("markup.heading.1")).toEqual({ foreground: rgbaHex("#e06c75"), bold: true, underline: true })
    expect(scopes.get("markup.bold")).toEqual({ foreground: rgbaHex("#e06c75"), bold: true })
    expect(scopes.get("markup.italic")).toEqual({ foreground: rgbaHex("#e5c07b"), italic: true })
    expect(scopes.get("markup.quote")).toEqual({ foreground: rgbaHex("#5c6370"), italic: true })
    expect(scopes.get("markup.raw")).toEqual({ foreground: rgbaHex("#98c379") })
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
    const scopes = scopesOf(buildSyntaxStyle({ syntax: { comment: rgbaHex("#111111") } }))
    expect(scopes.get("comment")).toEqual({ foreground: rgbaHex("#111111"), italic: true })
    expect(scopes.has("string")).toBe(false)
    expect(scopes.has("markup.heading")).toBe(false)
  })

  it("memoises on the token values, so a theme change is picked up", () => {
    const first = buildSyntaxStyle(fullTheme)
    expect(buildSyntaxStyle(fullTheme)).toBe(first)
    const second = buildSyntaxStyle({ ...fullTheme, syntax: { ...fullTheme.syntax, keyword: rgbaHex("#ff0000") } })
    expect(second).not.toBe(first)
    expect(scopesOf(second).get("keyword")).toEqual({ foreground: rgbaHex("#ff0000"), italic: true })
  })

  // Review focus #2, for the one row that reads a second token. Every other row
  // takes a foreground alone, so the only way to half-fill one is here.
  it("gives inline code a background when the theme carries one", () => {
    const scopes = scopesOf(buildSyntaxStyle({ markdown: { code: rgbaHex("#98c379") }, background: { base: rgbaHex("#1e222a") } }))
    expect(scopes.get("markup.raw.inline")).toEqual({ foreground: rgbaHex("#98c379"), background: rgbaHex("#1e222a") })
    // The block form shares the foreground and takes no background at all.
    expect(scopes.get("markup.raw")).toEqual({ foreground: rgbaHex("#98c379") })
  })

  it("drops the inline-code row whole when the theme has no background", () => {
    const scopes = scopesOf(buildSyntaxStyle({ markdown: { code: rgbaHex("#98c379") } }))
    expect(scopes.has("markup.raw.inline")).toBe(false)
    expect(scopes.get("markup.raw")).toEqual({ foreground: rgbaHex("#98c379") })
  })

  it("treats anything that is not a resolved colour as a token that is not there", () => {
    // A theme is data the host assembled from a user's config, and whatever the
    // config held before resolution can still be sitting in it: a hex string
    // that was never parsed, a number, null. The reader checks the shape rather
    // than the type it wishes were there, so all of them read as absent.
    const mixed = {
      syntax: {
        comment: "#5c6370",
        keyword: 42,
        function: null,
        variable: rgbaHex("#abb2bf"),
      },
    }
    const scopes = scopesOf(buildSyntaxStyle(mixed as unknown as MarkdownTheme))
    expect(scopes.has("comment")).toBe(false)
    expect(scopes.has("keyword")).toBe(false)
    expect(scopes.has("function")).toBe(false)
    expect(scopes.get("variable")).toEqual({ foreground: rgbaHex("#abb2bf") })
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
    const coldA = { syntax: { comment: rgbaHex("#010203") } }
    const coldB = { syntax: { comment: rgbaHex("#040506") } }
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
    const theme = { syntax: { string: rgbaHex("#070809") } }
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

    const first = buildSyntaxStyle({ syntax: { string: rgbaHex("#131415") } })
    const second = buildSyntaxStyle({ syntax: { string: rgbaHex("#161718") } })

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
    const scopes = scopesOf(buildSyntaxStyle({ syntax: { keyword: rgbaHex("#1b1c1d") } }))
    expect(scopes.get("keyword")).toEqual({ foreground: rgbaHex("#1b1c1d"), italic: true })
    expect(buildSyntaxStyle({ syntax: { keyword: rgbaHex("#1b1c1d") } })).not.toBe(SyntaxStyle.create())
  })
})

/*
 * The theme shape the host actually resolves.
 *
 * Every block above used to feed `buildSyntaxStyle` string colours, because
 * that is what this module's own `MarkdownTheme` type used to declare -- and
 * that declaration was a guess, written while `@opencode/theme` was an optional
 * peer nothing had installed. The real `Context["theme"]` is a `ResolvedTheme`,
 * in which every colour is an `RGBA` instance, not a hex string. A reader that
 * accepted only strings therefore found nothing at all in the live host: every
 * token absent, every scope row skipped, the empty style returned, and a `.md`
 * preview rendered white while the whole suite was green. The old suite pinned
 * the bug in place by testing against the guess.
 *
 * The break this block guards against is that one: a reader that drops the
 * host's real shape again. The production change that would fail it is
 * `tokenValue` accepting something other than the colours the host resolves.
 */
describe("buildSyntaxStyle with the theme shape the host resolves", () => {
  /** A `ResolvedTheme` as the host resolves one: every token an `RGBA`. */
  const hostTheme = {
    text: { base: rgbaHex("#abb2bf") },
    syntax: {
      comment: rgbaHex("#5c6370"),
      keyword: rgbaHex("#c678dd"),
      function: rgbaHex("#61afef"),
      variable: rgbaHex("#abb2bf"),
      string: rgbaHex("#98c379"),
      number: rgbaHex("#d19a66"),
      type: rgbaHex("#e5c07b"),
      operator: rgbaHex("#56b6c2"),
      punctuation: rgbaHex("#abb2bf"),
    },
    markdown: {
      heading: rgbaHex("#e06c75"),
      strong: rgbaHex("#e06c75"),
      emphasis: rgbaHex("#e5c07b"),
      code: rgbaHex("#98c379"),
      blockQuote: rgbaHex("#5c6370"),
      link: rgbaHex("#61afef"),
      linkText: rgbaHex("#61afef"),
      listItem: rgbaHex("#e5c07b"),
    },
    background: { base: rgbaHex("#1e222a") },
  }

  it("maps the host's RGBA tokens onto the scopes the host itself uses", () => {
    const scopes = scopesOf(buildSyntaxStyle(hostTheme as unknown as MarkdownTheme))
    // The value is handed on untouched, not converted: `ColorInput` is
    // `string | RGBA` and the host's own bridge passes the RGBA straight in.
    expect(scopes.get("comment")).toEqual({ foreground: hostTheme.syntax.comment, italic: true })
    expect(scopes.get("keyword")).toEqual({ foreground: hostTheme.syntax.keyword, italic: true })
    expect(scopes.get("markup.heading")).toEqual({ foreground: hostTheme.markdown.heading, bold: true })
    expect(scopes.get("markup.italic")).toEqual({ foreground: hostTheme.markdown.emphasis, italic: true })
    expect(scopes.get("markup.raw.inline")).toEqual({ foreground: hostTheme.markdown.code, background: hostTheme.background.base })
  })

  it("memoises on the channel values, so a re-resolved theme costs nothing", () => {
    // The host can rebuild the theme object between resolutions -- new RGBA
    // instances, same colours -- and a key built from anything but the channel
    // values would read that as a different theme and build a second style per
    // viewer mount, which is the leak the cache exists to stop.
    const again = {
      text: { base: rgbaHex("#abb2bf") },
      syntax: {
        comment: rgbaHex("#5c6370"),
        keyword: rgbaHex("#c678dd"),
        function: rgbaHex("#61afef"),
        variable: rgbaHex("#abb2bf"),
        string: rgbaHex("#98c379"),
        number: rgbaHex("#d19a66"),
        type: rgbaHex("#e5c07b"),
        operator: rgbaHex("#56b6c2"),
        punctuation: rgbaHex("#abb2bf"),
      },
      markdown: {
        heading: rgbaHex("#e06c75"),
        strong: rgbaHex("#e06c75"),
        emphasis: rgbaHex("#e5c07b"),
        code: rgbaHex("#98c379"),
        blockQuote: rgbaHex("#5c6370"),
        link: rgbaHex("#61afef"),
        linkText: rgbaHex("#61afef"),
        listItem: rgbaHex("#e5c07b"),
      },
      background: { base: rgbaHex("#1e222a") },
    }
    const recoloured = {
      text: { base: rgbaHex("#abb2bf") },
      syntax: { ...hostTheme.syntax, keyword: rgbaHex("#ff0000") },
      markdown: hostTheme.markdown,
      background: hostTheme.background,
    }
    const first = buildSyntaxStyle(hostTheme as unknown as MarkdownTheme)
    expect(buildSyntaxStyle(again as unknown as MarkdownTheme)).toBe(first)
    const second = buildSyntaxStyle(recoloured as unknown as MarkdownTheme)
    expect(second).not.toBe(first)
    expect(scopesOf(second).get("keyword")).toEqual({ foreground: rgbaHex("#ff0000"), italic: true })
  })
})

/*
 * The rows the first table pass left out.
 *
 * The opening table transcribed the host's bridge for the scopes a prose
 * markdown document produces. Two more reachable families were missing, and
 * both are observable in a real preview: a fenced code block is highlighted
 * with the host's own tree-sitter scopes, so builtins (`Array`, `String`),
 * tags and attributes carry `variable.builtin`/`tag`/`attribute`; and a struck
 * run carries `markup.strikethrough`. Without their rows all of it falls back
 * to the default colour while the host paints the same file coloured.
 *
 * What is deliberately NOT here: the host's `markup.list.checked`,
 * `markup.underline`, `diff.*`, `prompt` and `extmark.*` rows. Those scopes are
 * produced by the host's chat and diff surfaces, never by `MarkdownRenderable`
 * -- grep @opentui/core for the group names and they do not exist. A row whose
 * scope cannot be emitted is a row that only looks like coverage.
 */
describe("buildSyntaxStyle for the scopes a fenced block or a struck run can produce", () => {
  it("colours a struck run in the theme's muted colour, with no attributes", () => {
    // The host's row is `["markup.strikethrough", "markup.list.unchecked",
    // "debug"] -> text.muted` with no style, and the row is transcribed with all
    // three scopes because the renderer emits at least the first of them.
    const scopes = scopesOf(buildSyntaxStyle({ text: { muted: rgbaHex("#5c6370") } }))
    expect(scopes.get("markup.strikethrough")).toEqual({ foreground: rgbaHex("#5c6370") })
  })

  it("colours builtins and tags in the theme's error feedback colour", () => {
    const theme = {
      text: { feedback: { error: { base: rgbaHex("#be5046") }, warning: { base: rgbaHex("#d19a66") } } },
    }
    const scopes = scopesOf(buildSyntaxStyle(theme as unknown as MarkdownTheme))
    // The host's builtins row: every `*.builtin` capture plus `variable.super`
    // takes the error feedback colour, and `tag` shares it.
    expect(scopes.get("variable.builtin")).toEqual({ foreground: rgbaHex("#be5046") })
    expect(scopes.get("type.builtin")).toEqual({ foreground: rgbaHex("#be5046") })
    expect(scopes.get("function.builtin")).toEqual({ foreground: rgbaHex("#be5046") })
    expect(scopes.get("tag")).toEqual({ foreground: rgbaHex("#be5046") })
    // Attributes are the warning half of the same pair in the host's table.
    expect(scopes.get("attribute")).toEqual({ foreground: rgbaHex("#d19a66") })
  })

  it("gives directive keywords the keyword colour, and special punctuation the operator colour", () => {
    const theme = { syntax: { keyword: rgbaHex("#c678dd"), operator: rgbaHex("#56b6c2") } }
    const scopes = scopesOf(buildSyntaxStyle(theme as unknown as MarkdownTheme))
    expect(scopes.get("keyword.directive")).toEqual({ foreground: rgbaHex("#c678dd"), italic: true })
    expect(scopes.get("punctuation.special")).toEqual({ foreground: rgbaHex("#56b6c2") })
  })

  it("skips the feedback rows whole when the theme carries no feedback tokens", () => {
    // The same rule as the inline-code row: a row with a missing token is
    // dropped rather than half-filled.
    const theme = { text: { feedback: { warning: { base: rgbaHex("#d19a66") } } } }
    const scopes = scopesOf(buildSyntaxStyle(theme as unknown as MarkdownTheme))
    expect(scopes.has("variable.builtin")).toBe(false)
    expect(scopes.has("tag")).toBe(false)
    expect(scopes.get("attribute")).toEqual({ foreground: rgbaHex("#d19a66") })
  })
})
