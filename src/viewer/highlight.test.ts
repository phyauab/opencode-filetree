import { describe, it, expect } from "bun:test"
import { highlightLines, languageFor } from "./highlight"

const flat = (line: { text: string }[]) => line.map((s) => s.text).join("")

describe("languageFor", () => {
  it("maps the extensions this repo is written in", () => {
    expect(languageFor("a.ts")).toBe("typescript")
    expect(languageFor("a.tsx")).toBe("tsx")
    expect(languageFor("a.js")).toBe("javascript")
    expect(languageFor("a.json")).toBe("json")
    expect(languageFor("a.md")).toBe("markdown")
    expect(languageFor("a.py")).toBe("python")
    expect(languageFor("a.css")).toBe("css")
    expect(languageFor("a.sh")).toBe("bash")
  })

  it("returns undefined for anything unrecognised", () => {
    // Review Focus #4: an unknown grammar must not reach Prism, which throws.
    expect(languageFor("a.xyz")).toBeUndefined()
    expect(languageFor("Makefile")).toBeUndefined()
    expect(languageFor("noextension")).toBeUndefined()
  })
})

describe("highlightLines", () => {
  it("returns one span list per line", () => {
    const lines = highlightLines("const a = 1\nconst b = 2", "typescript")
    expect(lines).toHaveLength(2)
    expect(flat(lines[0]!)).toBe("const a = 1")
  })

  it("colours a keyword differently from plain text", () => {
    const lines = highlightLines("const a = 1", "typescript")
    const keyword = lines[0]!.find((s) => s.text.includes("const"))
    expect(keyword?.color).toBeTruthy()
  })

  it("falls back to plain text for an unknown language", () => {
    const lines = highlightLines("hello", "not-a-language")
    expect(lines).toEqual([[{ text: "hello", color: undefined }]])
  })

  it("treats undefined language as plain text", () => {
    expect(highlightLines("hello", undefined)).toEqual([[{ text: "hello", color: undefined }]])
  })

  it("does not throw on content the grammar cannot parse", () => {
    expect(() => highlightLines("}{ unterminated ???", "json")).not.toThrow()
  })

  // "extend" is a function that Prism keeps on Prism.languages, so it passes
  // the undefined check and reaches tokenize as a grammar -- which is the only
  // way to reach the catch deterministically. Prism reads `.rest` off the
  // grammar unguarded, so this throws and must come back as plain text with the
  // line count intact. Asserting only "does not throw" would pass just as well
  // if the fallback returned a single empty row.
  it("falls back to plain lines when tokenize itself throws", () => {
    expect(highlightLines("a\nb", "extend")).toEqual([[{ text: "a" }], [{ text: "b" }]])
  })

  it("preserves an empty line as an empty span list", () => {
    expect(highlightLines("a\n\nb", "typescript")[1]).toEqual([])
  })

  it("returns nothing for empty input", () => {
    expect(highlightLines("", "typescript")).toEqual([])
  })
})

// Prism.tokenize returns a FLAT stream in which one token routinely spans
// several lines, so the regrouping has to cut those tokens at every newline.
// If it does not, the viewer -- which maps one row to one entry of the returned
// array -- renders a block comment as one row of doubled text and every
// following row shifted by the number of lines inside it. The tests below pin
// the split for each grammar that can straddle.
describe("highlightLines across a token that spans lines", () => {
  it("splits a two-line block comment into one dim span per line", () => {
    const lines = highlightLines("/* one\n   two */\nconst a = 1", "typescript")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual([{ text: "/* one", color: "#5c6370" }])
    expect(lines[1]).toEqual([{ text: "   two */", color: "#5c6370" }])
    // The line after the comment still starts at the right offset, which is
    // what proves the split did not swallow or duplicate the text.
    expect(lines[2]!.map((s) => s.text).join("")).toBe("const a = 1")
  })

  it("splits a python triple-quoted string", () => {
    const lines = highlightLines('x = """a\nb"""\ny = 1', "python")
    expect(lines).toHaveLength(3)
    expect(lines[0]!.find((s) => s.text === '"""a')?.color).toBe("#98c379")
    expect(lines[1]).toEqual([{ text: 'b"""', color: "#98c379" }])
  })

  it("splits a template literal", () => {
    const lines = highlightLines("const s = `a\nb`;\nconst z = 2", "typescript")
    expect(lines).toHaveLength(3)
    expect(lines[0]!.filter((s) => s.color === "#98c379").map((s) => s.text).join("")).toBe("`a")
    expect(lines[1]!.filter((s) => s.color === "#98c379").map((s) => s.text).join("")).toBe("b`")
  })

  it("gives every line of a multi-line token the same colour", () => {
    const lines = highlightLines("/* a\nb\nc\nd */", "typescript")
    expect(lines).toHaveLength(4)
    for (const line of lines) expect(line).toEqual([{ text: expect.any(String), color: "#5c6370" }])
  })

  // The general invariant behind the cases above: nothing is dropped and
  // nothing is duplicated by the regrouping, whatever the line count.
  const straddles: Array<[string, string, string]> = [
    ["typescript", "/* a\nb */", "block comment"],
    ["typescript", "const s = `a\nb`", "template literal"],
    ["python", '"""a\nb\nc"""', "triple-quoted string"],
    ["markdown", "# Title\n\n`code`", "headings and blank lines"],
    ["css", ".a {\n  color: red;\n}", "css block"],
    ["bash", "echo one\n# comment\necho two", "shell comments"],
    ["json", '{\n  "a": 1\n}', "json object"],
  ]

  for (const [language, code, label] of straddles) {
    it(`reproduces ${label} text exactly, one row per line`, () => {
      const lines = highlightLines(code, language)
      expect(lines).toHaveLength(code.split("\n").length)
      expect(lines.map(flat).join("\n")).toBe(code)
    })
  }

  it("keeps the line count equal to the newline count plus one", () => {
    // The viewer's row index is this array's index, so the two counts have to
    // agree before anything is drawn. Zero lines is the empty-input case
    // pinned separately above.
    for (let n = 1; n <= 4; n++) {
      const code = Array.from({ length: n }, () => "const a = 1").join("\n")
      expect(highlightLines(code, "typescript")).toHaveLength(n)
    }
  })
})

describe("grammar registration", () => {
  // TypeScript does not report an unresolvable side-effect import, so a
  // misspelled `prismjs/components/prism-*` path compiles, ships, and then
  // leaves the grammar unregistered -- which surfaces only as every file in
  // that language quietly rendering unhighlighted. This is the guard for that.
  //
  // Each entry needs a snippet its own grammar actually colours: "const a = 1"
  // is plain text to CSS and to shell, so a shared snippet would report a
  // missing grammar and a working one identically.
  const registered: Array<[string, string]> = [
    ["a.ts", "const a = 1"],
    ["a.tsx", "const a = 1"],
    ["a.js", "const a = 1"],
    ["a.json", '{"a": 1}'],
    ["a.md", "some `code`"],
    ["a.py", "def f(): pass"],
    ["a.css", '.a { content: "x"; }'],
    ["a.sh", "echo hi"],
  ]

  for (const [fileName, snippet] of registered) {
    it(`registers a working grammar for ${fileName}`, () => {
      const language = languageFor(fileName)
      expect(language).toBeDefined()
      // Asserting a colour rather than a shape is the point: an unregistered
      // grammar still returns a well-formed plain result via the fallback, so
      // every shape assertion in this file would pass with nothing loaded.
      const lines = highlightLines(snippet, language)
      expect(lines[0]!.some((s) => s.color !== undefined)).toBe(true)
    })
  }

  it("colours a class name, which Prism emits as a nested plain token", () => {
    // TypeScript's class-name token holds an untyped string in an array, so
    // this only stays the class-name colour if the enclosing token's colour is
    // inherited down.
    const lines = highlightLines("class Foo extends Bar {}", "typescript")
    expect(lines[0]!.find((s) => s.text === "Foo")?.color).toBe("#e5c07b")
    expect(lines[0]!.find((s) => s.text === "Bar")?.color).toBe("#e5c07b")
  })

  it("colours markdown inline code through its own mapping", () => {
    // `code-snippet` is a key in TOKEN_COLORS in its own right, so this resolves
    // directly and never reaches the alias branch.
    const lines = highlightLines("some `code` text", "markdown")
    expect(lines[0]!.find((s) => s.text === "`code`")?.color).toBe("#98c379")
  })

  // The alias branch is live for types the table does not carry. `generic` is
  // named `class-name` by Prism, so `Foo<T>()` resolves it to the class-name
  // cyan. A direct-lookup-only implementation leaves the whole generic plain.
  it("resolves an aliased token type the table does not carry", () => {
    const lines = highlightLines("Foo<T>()", "typescript")
    expect(lines[0]!.find((s) => s.text === "Foo")?.color).toBe("#61afef")
    expect(lines[0]!.find((s) => s.text === "T")?.color).toBe("#d19a66")
  })

  it("resolves a single-string alias to its colour", () => {
    // Prism tags the backticks around a template literal
    // `template-punctuation`, aliased to "string". The alias is the only reason
    // they are green rather than theme default.
    const lines = highlightLines("const s = `x`", "typescript")
    const backticks = lines[0]!.filter((s) => s.text === "`")
    expect(backticks).toHaveLength(2)
    for (const tick of backticks) expect(tick.color).toBe("#98c379")
  })
})

// TOKEN_COLORS maps `operator` and `punctuation` to undefined, meaning the
// theme default. undefined is also what an unmapped type produces, so these pin
// the two apart: a nested operator or punctuation must render in the default
// colour, not in the colour of whatever token encloses it.
describe("nested operators and punctuation keep the theme default", () => {
  it("leaves an interpolated plus in the default colour", () => {
    // Only the `+` inside `${...}` is a separate operator token; the one in
    // "a + " is part of the surrounding string literal and is green as text.
    const lines = highlightLines("const s = `a + ${b + c}`", "typescript")
    expect(lines[0]!.find((s) => s.text.includes("a + "))?.color).toBe("#98c379")
    const plus = lines[0]!.filter((s) => s.text === "+")
    expect(plus).toHaveLength(1)
    // Inheriting from the enclosing token rendered this green as part of the
    // string, so the assertion is on undefined rather than on any colour.
    expect(plus[0]!.color).toBeUndefined()
  })

  it("leaves interpolation punctuation in the default colour", () => {
    // `interpolation-punctuation` is aliased to `punctuation`, which is mapped
    // to undefined. The alias has to resolve *to* the default rather than fail
    // to resolve and inherit the surrounding string's green.
    const lines = highlightLines("const s = `${a}`", "typescript")
    for (const span of lines[0]!) {
      if (span.text.includes("${") || span.text === "}") expect(span.color).toBeUndefined()
    }
  })

  it("leaves generic brackets in the default colour, not the aliased cyan", () => {
    // The `<` and `>` are operators nested inside a token whose alias resolves
    // to the class-name cyan.
    const lines = highlightLines("Foo<T>()", "typescript")
    const angles = lines[0]!.filter((s) => s.text === "<" || s.text === ">")
    expect(angles).toHaveLength(2)
    for (const angle of angles) expect(angle.color).toBeUndefined()
  })

  it("still inherits the enclosing colour for a type with no mapping at all", () => {
    // The other half of the distinction: an unmapped nested token does inherit,
    // which is what keeps `class Foo` colouring the name cyan.
    const lines = highlightLines("class Foo {}", "typescript")
    expect(lines[0]!.find((s) => s.text === "Foo")?.color).toBe("#e5c07b")
  })
})
