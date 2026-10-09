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
  // Declared because the host's own bridge table reads it for inline code, not
  // because it is known to exist: the theme shape recorded for this plan elides
  // groups it does not name (`text` appears only as `feedback: {...}`), so
  // absence was never established and guessing at it produced a wrong colour.
  // See the `markup.raw.inline` row below.
  background?: { base?: string }
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
  | "background.base"

/**
 * One theme-token to syntax-scope mapping, replicating the host's own bridge.
 *
 * `background` exists for the one row that needs a second token, and the rule is
 * that every source token has to be present: a row with a missing one is skipped
 * whole rather than half-filled. A heading that gets a colour but loses its
 * `bold` is worse than a heading in the default style, because the user reads
 * the loss as a bug in their theme rather than as a missing token.
 */
type ScopeRow = {
  scope: readonly string[]
  /** The token the foreground comes from. */
  foreground: TokenPath
  /** The token the background comes from, when the row needs one. */
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
 * One row asks for a token the recorded theme shape did not name: inline code
 * takes its background from `background.base`. The row asks for it and is
 * dropped whole when the host does not offer one, rather than falling back to a
 * colour it does have -- an earlier draft substituted `text.base` and that is
 * the host's *text* colour sitting behind its *code* colour, a bright inverted
 * chip that no other markdown surface in the host wears. A missing background
 * is a nicety; a wrong one is a bug report.
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
  { scope: ["markup.raw.inline"], foreground: "markdown.code", background: "background.base", style: {} },
  { scope: ["markup.link", "markup.link.url", "string.special", "string.special.url"], foreground: "markdown.link", style: { underline: true } },
  { scope: ["markup.link.label"], foreground: "markdown.linkText", style: { underline: true } },
  { scope: ["label"], foreground: "markdown.linkText", style: {} },
  { scope: ["spell", "nospell"], foreground: "text.base", style: {} },
]

/**
 * Every token the table reads, deduplicated, in table order.
 *
 * The order is what makes the memo key position-stable, and the dedupe is what
 * keeps `syntax.keyword` -- which four rows read -- from counting four times
 * toward a key that only ever compared for equality. Built from the table
 * rather than listed by hand so a new row cannot be forgotten here.
 */
const TABLE_TOKENS: readonly TokenPath[] = [
  ...new Set(
    SCOPE_TABLE.flatMap((row) => (row.background === undefined ? [row.foreground] : [row.foreground, row.background])),
  ),
]

/** Reads one token out of the theme, treating anything but a real colour as absent. */
function tokenValue(theme: MarkdownTheme | undefined, path: TokenPath): string | undefined {
  const dot = path.indexOf(".")
  // One cast, at the only place the halves of a `TokenPath` meet again. Every
  // group in `MarkdownTheme` is a bag of optional colour strings, so this reads
  // whichever one the path names; what the checker will not accept is a plain
  // `string` indexing four different key unions at once, and narrowing each half
  // separately would need the same cast four times over.
  const groups = theme as Record<string, Record<string, string | undefined> | undefined> | undefined
  const value = groups?.[path.slice(0, dot)]?.[path.slice(dot + 1)]
  // A theme is data the host assembled from a user's config, so this guard is
  // not paranoia: a number, null, and a stray object have all been plausible
  // things to find in there. An empty string is rejected alongside them for a
  // reason of this module's own rather than the host's: "" means "no colour" as
  // surely as absent does, and letting it through would put an empty colour in
  // the memo key and in a row's style while the skip-whole rule -- and every
  // reader -- read it as a colour that is not there.
  return typeof value === "string" && value !== "" ? value : undefined
}

/**
 * The style this module last built, keyed by the tokens it was built from.
 *
 * `SyntaxStyle` holds a native handle and has a `destroy()` this never calls, so
 * every style built here is one the process keeps until it exits. The cache is
 * what holds the count down, and because it holds one entry the bound is one
 * style per cache miss -- which, with one plugin and one active theme, is one
 * per theme change. The `fallback` slot below is the exception, and it is capped
 * at one for the whole session rather than one per bad theme.
 *
 * Without the cache the cost is per *viewer mount* rather than per *theme
 * change* -- `FileViewer` asks for a style each time it opens a `.md` file -- so
 * an hour of reading files in one theme would leak an hour's worth of native
 * styles, and the worst case is the empty theme, which is the one every file
 * opened before the host resolved a theme would hit.
 */
let cached: { key: string; style: SyntaxStyle } | null = null

/**
 * The style handed back when the theme cannot be read at all.
 *
 * Apart from `cached` because a throw can happen anywhere in the body, including
 * before the key is known, so there is no key to hang it on. It is held rather
 * than rebuilt for the same reason: the catch sits on the path of every mount
 * while a bad theme stands.
 */
let fallback: SyntaxStyle | null = null

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
    // The cache check comes before anything that allocates, and in particular
    // before the `create()` at the bottom of this block: a repeat has to cost
    // nothing, and an untokenised theme is the one that repeats most.
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

    // An empty list is "the theme carried nothing this table reads": every token
    // absent, a theme with only a background and no foreground, or colours that
    // were all empty strings. Hand back the host's own empty style rather than
    // asking `fromTheme` for a style with no scopes in it -- and cache it, for
    // the same reason as any other result, since this is the path every file
    // opened before the host resolved a theme takes.
    const style = scopes.length === 0 ? SyntaxStyle.create() : SyntaxStyle.fromTheme(scopes)
    cached = { key, style }
    return style
  } catch {
    // A theme that cannot be read is still not a reason to show raw source. Held
    // rather than rebuilt, and kept out of `cached` because a throw can land
    // before the key is known; delegating to the empty-theme branch instead
    // would recurse for ever if `create()` itself were what threw.
    fallback ??= SyntaxStyle.create()
    return fallback
  }
}
