import Prism, { type StreamToken, type Token } from "prismjs"
import "prismjs/components/prism-typescript"
import "prismjs/components/prism-jsx"
import "prismjs/components/prism-tsx"
import "prismjs/components/prism-json"
import "prismjs/components/prism-markdown"
import "prismjs/components/prism-python"
import "prismjs/components/prism-css"
import "prismjs/components/prism-bash"

/*
 * Grammars are imported one at a time, never through `prismjs/components/`
 * (the autoloader) and never through `core.js`: the autoloader reaches for
 * `document` to inject a <script> tag for a grammar it does not have, and
 * there is no document here -- that path throws a ReferenceError at import
 * time, which would take the whole plugin down rather than one file view.
 * `core.js` has the same defect and additionally registers every one of
 * Prism's ~290 languages, which is dead weight in a panel that shows at most
 * 2000 lines.
 *
 * The import order below is load-bearing, not alphabetical. prism-tsx.js does
 * `Prism.util.clone(Prism.languages.typescript)` and `extend("jsx", ...)` with
 * no require() of its own, so it throws `TypeError: Cannot set properties of
 * undefined` unless typescript and jsx are already registered -- both were
 * confirmed to throw that way when tsx was loaded first. `prism` itself
 * supplies javascript, which typescript extends.
 */

export type HighlightSpan = { text: string; color?: string }
export type HighlightedLine = HighlightSpan[]

/**
 * Prism token type to an OpenTUI colour name.
 *
 * `undefined` is a deliberate value, not an omission: it means "render in the
 * theme's default colour", and it is what leaves operators and punctuation
 * reading as ordinary text rather than picking a colour the host theme may not
 * have. The names are OpenTUI's, so the viewer matches the rest of the plugin
 * and the host's palette without a theme lookup here.
 *
 * Typed `string | undefined` rather than the `Record<string, string>` first
 * drafted, because under `strict` that rejects the `undefined` entries that
 * give this table its meaning.
 */
const TOKEN_COLORS: Record<string, string | undefined> = {
  comment: "dim",
  prolog: "dim",
  doctype: "dim",

  keyword: "magenta",
  "control-keyword": "magenta",

  string: "green",
  // The grammars below emit these instead of `string`. Without them a Python
  // triple-quoted string -- which is exactly the multi-line token that has to
  // be split per line -- would be the one string left uncoloured.
  "triple-quoted-string": "green",
  "template-string": "green",
  char: "green",
  // Reached through markdown's `code-snippet` token, whose alias list is
  // ["code", "keyword"]; see colorFor.
  code: "green",
  "code-snippet": "green",

  number: "yellow",
  boolean: "yellow",
  constant: "yellow",

  function: "cyan",
  // A class or type name is the most visually distinct thing in a TypeScript
  // file, and Prism emits it as a *nested* token whose own content is plain
  // text -- without this the name renders unstyled. See the `inherited`
  // argument in collect.
  "class-name": "cyan",
  "maybe-class-name": "cyan",
  "function-variable": "cyan",
  builtin: "cyan",

  operator: undefined,
  punctuation: undefined,
}

/**
 * Resolves a token's colour, consulting its alias list only when the token's own
 * type has no entry in the table.
 *
 * Returns `undefined` when neither the type nor any of its aliases has an
 * entry, which is the caller's cue to inherit the enclosing token's colour.
 * A result whose `color` is `undefined` means the opposite and is deliberate:
 * the type is mapped to the theme default, which is what `operator` and
 * `punctuation` are for.
 *
 * The test is key presence (`in`) rather than a non-undefined value, and it has
 * to be. Comparing the value cannot tell "mapped to the default on purpose"
 * apart from "no mapping at all", so `operator` and `punctuation` read as
 * unmapped and a nested `+` or `${` fell through to the enclosing token: the
 * plus in `` `a + ${b + c}` `` rendered green as part of the string, and a
 * TypeScript generic's `<` rendered cyan as part of the `class-name` it aliases
 * to. Both are pinned by tests below.
 */
function colorFor(token: Token): { color: string | undefined } | undefined {
  if (token.type in TOKEN_COLORS) return { color: TOKEN_COLORS[token.type] }

  // Aliases are Prism's own "treat this as that" declaration, and several
  // grammars name a type the table does not carry while declaring what it
  // means: `template-punctuation` as `string` (the backticks around a template
  // literal), `generic` as `class-name`, `interpolation-punctuation` as
  // `punctuation`. Reached only when the type itself has no entry, so an alias
  // cannot override one -- and the first alias with an entry wins, which is what
  // makes markdown's ordered ['code', 'keyword'] list come out green rather than
  // magenta.
  const alias = token.alias
  if (alias === undefined) return undefined
  for (const name of typeof alias === "string" ? [alias] : alias) {
    if (name in TOKEN_COLORS) return { color: TOKEN_COLORS[name] }
  }
  return undefined
}

type Piece = { text: string; color: string | undefined }

/**
 * Flattens Prism's token stream into coloured text pieces, dropping empty ones.
 *
 * Prism returns a flat list whose members are either bare strings (untokenized
 * runs) or tokens. A token's `content` is a string for a leaf and a nested
 * stream for a container one -- TypeScript's `class-name` holds a bare string
 * in an array, markdown's `bold` holds further tokens -- so container tokens
 * are recursed into rather than stringified.
 *
 * `inherited` carries the enclosing token's colour down into nested content.
 * A nested token keeps its own mapping where it has one and falls back to the
 * enclosing colour otherwise, which is what makes `class Foo` render the name
 * in the `class-name` cyan: Prism splits the name out as an untyped plain
 * string inside a typed container.
 */
function collect(tokens: StreamToken[], inherited: string | undefined, out: Piece[]): void {
  for (const token of tokens) {
    if (typeof token === "string") {
      if (token !== "") out.push({ text: token, color: inherited })
      continue
    }
    // A resolved result is used even when its colour is undefined: that is a
    // type mapped to the theme default, which must not inherit the enclosing
    // token's colour. Only an unresolved token inherits.
    const resolved = colorFor(token)
    const color = resolved !== undefined ? resolved.color : inherited
    if (Array.isArray(token.content)) collect(token.content, color, out)
    else if (token.content !== "") out.push({ text: token.content, color })
  }
}

/**
 * Regroups a flat piece stream into one span list per line.
 *
 * This split is the reason the whole thing cannot be a simple map over Prism's
 * tokens: a single token routinely spans several lines -- a block comment, a
 * template literal, a Python triple-quoted string -- so a token whose text
 * contains "\n" has to be cut at every newline, with each line's fragment
 * keeping the token's colour. Handing the viewer the token whole instead would
 * put one row's worth of text in several rows and leave the line count wrong,
 * which is the one-row-per-line mapping the viewer is built on.
 *
 * Empty fragments are dropped rather than emitted as empty spans: between two
 * newlines an empty fragment *is* the whole line, and after a newline it is
 * merely the start of a line the next piece fills. A blank line therefore comes
 * out as an empty list, which renders as a blank row.
 */
function regroup(pieces: Piece[]): HighlightedLine[] {
  const lines: HighlightedLine[] = [[]]
  for (const piece of pieces) {
    const segments = piece.text.split("\n")
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!
      if (segment !== "") lines[lines.length - 1]!.push({ text: segment, color: piece.color })
      if (i < segments.length - 1) lines.push([])
    }
  }
  return lines
}

/** One uncoloured span per non-empty line, for input Prism will not tokenize. */
function plainLines(code: string): HighlightedLine[] {
  return code.split("\n").map((line) => (line === "" ? [] : [{ text: line, color: undefined }]))
}

/** File extension to Prism grammar name. Keys are lowercased. */
const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  css: "css",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
}

/**
 * Maps a file name to a Prism grammar name, or undefined if unrecognised.
 *
 * Extension only: no grammar for Makefiles or Dockerfiles is imported, so
 * there is no name that could be mapped. Returning undefined is what keeps
 * those files safe -- `Prism.tokenize` reads `.rest` off the grammar with no
 * guard, so handing it `Prism.languages[undefined]` throws a TypeError rather
 * than highlighting nothing.
 */
export function languageFor(fileName: string): string | undefined {
  const dot = fileName.lastIndexOf(".")
  // A leading dot is a dotfile, not an extension: ".gitignore" must not be read
  // as the "gitignore" extension.
  if (dot <= 0) return undefined
  return LANGUAGES[fileName.slice(dot + 1).toLowerCase()]
}

/**
 * Tokenizes `code` as `language`, returning one span list per line.
 *
 * Returns a single plain span per line for an unknown language. Never throws:
 * the whole tokenize path is inside the try, because a grammar handed input it
 * cannot parse must leave the user reading unhighlighted text rather than a
 * blank panel with a stack trace in the log. The same goes for a throw from the
 * grammar lookup itself.
 *
 * Empty input is the one case that returns no lines at all. Prism tokenizes ""
 * to a single empty string, which regroup would render as one blank row for a
 * file with no lines in it.
 */
export function highlightLines(code: string, language: string | undefined): HighlightedLine[] {
  if (code === "") return []
  try {
    const grammar = language === undefined ? undefined : Prism.languages[language]
    if (grammar === undefined) return plainLines(code)
    const pieces: Piece[] = []
    collect(Prism.tokenize(code, grammar), undefined, pieces)
    return regroup(pieces)
  } catch {
    return plainLines(code)
  }
}
