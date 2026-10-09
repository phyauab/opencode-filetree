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
    expect(lines[0]).toEqual([{ text: "/* one", color: "dim" }])
    expect(lines[1]).toEqual([{ text: "   two */", color: "dim" }])
    // The line after the comment still starts at the right offset, which is
    // what proves the split did not swallow or duplicate the text.
    expect(lines[2]!.map((s) => s.text).join("")).toBe("const a = 1")
  })

  it("splits a python triple-quoted string", () => {
    const lines = highlightLines('x = """a\nb"""\ny = 1', "python")
    expect(lines).toHaveLength(3)
    expect(lines[0]!.find((s) => s.text === '"""a')?.color).toBe("green")
    expect(lines[1]).toEqual([{ text: 'b"""', color: "green" }])
  })

  it("splits a template literal", () => {
    const lines = highlightLines("const s = `a\nb`;\nconst z = 2", "typescript")
    expect(lines).toHaveLength(3)
    expect(lines[0]!.filter((s) => s.color === "green").map((s) => s.text).join("")).toBe("`a")
    expect(lines[1]!.filter((s) => s.color === "green").map((s) => s.text).join("")).toBe("b`")
  })

  it("gives every line of a multi-line token the same colour", () => {
    const lines = highlightLines("/* a\nb\nc\nd */", "typescript")
    expect(lines).toHaveLength(4)
    for (const line of lines) expect(line).toEqual([{ text: expect.any(String), color: "dim" }])
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
    // this only stays cyan if the enclosing token's colour is inherited down.
    const lines = highlightLines("class Foo extends Bar {}", "typescript")
    expect(lines[0]!.find((s) => s.text === "Foo")?.color).toBe("cyan")
    expect(lines[0]!.find((s) => s.text === "Bar")?.color).toBe("cyan")
  })

  it("colours markdown inline code, which only its alias names", () => {
    // The token type is `code-snippet`, aliased to ["code", "keyword"], so the
    // mapping is unreachable without resolving aliases.
    const lines = highlightLines("some `code` text", "markdown")
    expect(lines[0]!.find((s) => s.text === "`code`")?.color).toBe("green")
  })
})
