import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core"
import { languageFor } from "./highlight"

/**
 * Markdown support for the viewer: which files it renders as markdown, and the
 * colours it renders them in.
 *
 * This lives beside `highlight.ts` rather than inside it because the two answer
 * different questions. `highlight.ts` owns Prism: it tokenizes a code file into
 * coloured spans, one list per line. A markdown file instead goes to
 * `MarkdownRenderable`, which parses and lays out its own blocks and asks only
 * for a `SyntaxStyle` -- so the colours come from the host theme here rather
 * than from a hardcoded palette like `TOKEN_COLORS`. Anyone looking for the one
 * place that decides "what colour is this token" will find two, and that is the
 * point: the Prism path is a fixed palette, this one follows the theme the user
 * is running, which is what makes a preview look like the host's own markdown
 * instead of a second opinion about it.
 */

/** The subset of `ctx.theme` this feature reads. Structural, because the host's
 *  own theme type is an unresolved optional peer. */
export type MarkdownTheme = {
  text?: { base?: string }
  syntax?: Partial<Record<"comment" | "keyword" | "function" | "variable" | "string" | "number" | "type" | "operator" | "punctuation", string>>
  markdown?: Partial<Record<"heading" | "strong" | "emphasis" | "code" | "blockQuote" | "link" | "linkText" | "listItem", string>>
}

/**
 * True for the extensions the viewer renders as markdown rather than as code.
 *
 * Delegates to `languageFor` rather than keeping a second list here: one owner
 * of the extension table beats two, and the day someone adds `mdown` to
 * `highlight.ts` this follows without being told.
 *
 * `.mdx` is deliberately NOT markdown. `languageFor` does not map it, and
 * Prism's markdown grammar would mis-tokenise JSX -- an `.mdx` file opened as a
 * preview would render its components as mangled prose. It keeps the Prism path,
 * which shows it as the plain text it is to that grammar.
 */
export function isMarkdown(path: string): boolean {
  return languageFor(path) === "markdown"
}

/**
 * A dotted path into `MarkdownTheme`.
 *
 * Spelled out as a union of the whole table rather than assembled from strings,
 * so that a typo in the mapping below -- `syntax.coment` -- is a compile error
 * instead of a scope that silently renders in the default style for as long as
 * it takes someone to notice.
 */
type TokenPath =
  | "text.base"
  | "syntax.comment"
  | "syntax.keyword"
  | "syntax.function"
  | "syntax.variable"
  | "syntax.string"
  | "syntax.number"
  | "syntax.type"
  | "syntax.operator"
  | "syntax.punctuation"
  | "markdown.heading"
  | "markdown.strong"
  | "markdown.emphasis"
  | "markdown.code"
  | "markdown.blockQuote"
  | "markdown.link"
  | "markdown.linkText"
  | "markdown.listItem"

/**
 * One theme-token to syntax-scope mapping, replicating the host's own bridge.
 *
 * `requires` and `background` carry the two rows that need more than their
 * foreground, and the rule for both is that every source token has to be
 * present: a row with a missing one is skipped whole rather than half-filled.
 * A heading that gets a colour but loses its `bold` is worse than a heading in
 * the default style, because the user reads the loss as a bug in their theme
 * rather than as a missing token.
 */
type ScopeRow = {
  scope: readonly string[]
  /** The token the foreground comes from. */
  foreground: TokenPath
  /** Further tokens the row needs before it may be used at all. */
  requires?: readonly TokenPath[]
  /** The token the background comes from. */
  background?: TokenPath
  style: Omit<ThemeTokenStyle["style"], "foreground" | "background">
}

/**
 * The host's own theme→style table, row for row.
 *
 * Replicated rather than designed because the point of the feature is that a
 * `.md` file looks like every other markdown surface in the host. Scopes are
 * Tree-sitter scope names, which is why `markup.heading.1` and `markup.heading`
 * are separate rows: the host underlines the first heading level and merely
 * bolds the rest, and collapsing them would take the `underline` away from `#`.
 *
 * One substitution: the host gives inline code a background from its own
 * `background.base`, and `MarkdownTheme` carries no such key -- the theme shape
 * the plugin can see has `text`, `syntax` and `markdown` only. `text.base` is
 * used in its place so inline code still gets a filled background instead of no
 * styling, which is the nearest colour the host theme actually offers and beats
 * either dropping the background or inventing one.
 */
const SCOPE_TABLE: readonly ScopeRow[] = [
  { scope: ["default"], foreground: "text.base", style: {} },
  { scope: ["comment", "comment.documentation"], foreground: "syntax.comment", style: { italic: true } },
  { scope: ["string", "symbol", "character.special", "character"], foreground: "syntax.string", style: {} },
  { scope: ["number", "boolean", "constant", "float"], foreground: "syntax.number", style: {} },
  { scope: ["keyword.return", "keyword.conditional", "keyword.repeat", "keyword.coroutine"], foreground: "syntax.keyword", style: { italic: true } },
  { scope: ["keyword.type"], foreground: "syntax.type", style: { bold: true, italic: true } },
  { scope: ["keyword.function", "function.method"], foreground: "syntax.function", style: {} },
  { scope: ["keyword", "keyword.import", "string.escape", "string.regexp", "tag.attribute", "keyword.export"], foreground: "syntax.keyword", style: {} },
  { scope: ["operator", "keyword.operator", "punctuation.delimiter", "keyword.conditional.ternary"], foreground: "syntax.operator", style: {} },
  { scope: ["variable", "variable.parameter", "function.method.call", "function.call", "property", "parameter", "field"], foreground: "syntax.variable", style: {} },
  { scope: ["variable.member", "function", "constructor"], foreground: "syntax.function", style: {} },
  { scope: ["type", "module", "class", "namespace"], foreground: "syntax.type", style: {} },
  { scope: ["type.definition"], foreground: "syntax.type", style: { bold: true } },
  { scope: ["punctuation", "punctuation.bracket"], foreground: "syntax.punctuation", style: {} },
  { scope: ["markup.heading", "markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6"], foreground: "markdown.heading", style: { bold: true } },
  { scope: ["markup.heading.1"], foreground: "markdown.heading", style: { bold: true, underline: true } },
  { scope: ["markup.bold", "markup.strong"], foreground: "markdown.strong", style: { bold: true } },
  { scope: ["markup.italic"], foreground: "markdown.emphasis", style: { italic: true } },
  { scope: ["markup.list"], foreground: "markdown.listItem", style: {} },
  { scope: ["markup.quote"], foreground: "markdown.blockQuote", style: { italic: true } },
  { scope: ["markup.raw", "markup.raw.block"], foreground: "markdown.code", style: {} },
  { scope: ["markup.raw.inline"], foreground: "markdown.code", requires: ["text.base"], background: "text.base", style: {} },
  { scope: ["markup.link", "markup.link.url", "string.special", "string.special.url"], foreground: "markdown.link", style: { underline: true } },
  { scope: ["markup.link.label"], foreground: "markdown.linkText", style: { underline: true } },
  { scope: ["label"], foreground: "markdown.linkText", style: {} },
  { scope: ["spell", "nospell"], foreground: "text.base", style: {} },
]

/** Every token the table reads, in table order, so the key is position-stable. */
const TABLE_TOKENS: readonly TokenPath[] = SCOPE_TABLE.flatMap((row) =>
  row.requires === undefined ? [row.foreground] : [row.foreground, ...row.requires])

/** Reads one token out of the theme, treating a non-string as absent. */
function tokenValue(theme: MarkdownTheme | undefined, path: TokenPath): string | undefined {
  const dot = path.indexOf(".")
  const group = path.slice(0, dot)
  const key = path.slice(dot + 1)
  const table = group === "text" ? theme?.text : group === "syntax" ? theme?.syntax : theme?.markdown
  // One cast, at the only place the halves of a `TokenPath` meet again. The path
  // is a compile-time union, so the pair is known valid by the time it gets
  // here; what the checker will not accept is a plain `string` indexing three
  // different key unions at once, and narrowing each half separately would need
  // the same cast three times over.
  const value = (table as Record<string, string | undefined> | undefined)?.[key]
  // A theme is data the host assembled from a user's config, so the guard is
  // not paranoia: an empty string, a number, or null has all been a plausible
  // thing to find there, and `SyntaxStyle.fromTheme` would take any of them.
  return typeof value === "string" ? value : undefined
}

/**
 * The style this module last built, keyed by the tokens it was built from.
 *
 * `SyntaxStyle` holds a native handle and has a `destroy()` this never calls, so
 * a theme change leaks one style. That is bounded by the number of theme
 * changes in a session -- a handful at most, and the host itself makes the same
 * trade when it rebuilds its own styles on a switch -- while dropping the cache
 * would cost one construction per file opened, each of which registers every
 * scope into a fresh native style.
 */
let cached: { key: string; style: SyntaxStyle } | null = null

/**
 * A `SyntaxStyle` built from the host theme, or `SyntaxStyle.create()` when the
 * theme carries nothing usable.
 *
 * `create()` is a real, truthy style -- the host's own fallback -- so a thin
 * theme buys an uncoloured preview, never a return to raw markdown source. That
 * distinction is the whole reason this function cannot fail: the caller has no
 * error path to offer but showing the file unformatted, and showing it
 * unformatted is the complaint this feature exists to answer.
 *
 * Never throws. The whole body is inside the try, because a theme is data from
 * the user's config and a malformed one must not take the panel down.
 */
export function buildSyntaxStyle(theme: MarkdownTheme | undefined): SyntaxStyle {
  try {
    // The key joins the values in table order with a blank for every absent
    // token, so two different themes cannot collide: a theme that lost a token
    // gets a shorter key rather than the key of a theme that never had it.
    const key = TABLE_TOKENS.map((path) => tokenValue(theme, path) ?? "").join("\u0000")
    // No token the table reads: hand back the host's own empty style rather
    // than asking `fromTheme` for a style with no scopes in it. `create()` is
    // what the host itself falls back to and costs nothing.
    if (!TABLE_TOKENS.some((path) => tokenValue(theme, path) !== undefined)) return SyntaxStyle.create()
    if (cached !== null && cached.key === key) return cached.style

    const scopes: ThemeTokenStyle[] = []
    for (const row of SCOPE_TABLE) {
      const foreground = tokenValue(theme, row.foreground)
      if (foreground === undefined) continue
      const background = row.background === undefined ? undefined : tokenValue(theme, row.background)
      if (row.background !== undefined && background === undefined) continue
      const style: ThemeTokenStyle["style"] = { foreground }
      if (background !== undefined) style.background = background
      Object.assign(style, row.style)
      scopes.push({ scope: [...row.scope], style })
    }

    const style = SyntaxStyle.fromTheme(scopes)
    cached = { key, style }
    return style
  } catch {
    return SyntaxStyle.create()
  }
}
