/**
 * Types for prismjs, which ships none.
 *
 * The `types` field is absent from prismjs's package.json and no `.d.ts` sits
 * beside its entry point, so `import Prism from "prismjs"` fails typecheck with
 * TS7016 ("implicitly has an 'any' type"). Under `strict` that is an error, not
 * a warning, and this repo keeps `bun run typecheck` clean as a gate -- so the
 * surface actually used here is declared instead.
 *
 * Only what src/viewer/highlight.ts touches is declared. Prism's own types
 * cover `hooks`, `plugins` and the rest of its much larger surface; none of it
 * is reachable from a headless tokenize, so declaring the rest would be
 * fiction that drifts.
 *
 * There is deliberately no `declare module "prismjs/components/*"` wildcard. A
 * wildcard would type a mistyped grammar path as `any`, which reads as though
 * it were checked.
 *
 * That check does not exist anywhere else, though, and it is worth knowing why
 * before adding one: TypeScript does *not* report an unresolvable side-effect
 * import here. `import "prismjs/components/prism-typescrpt"` and
 * `import "totally-bogus-package-xyz"` both typecheck silently under
 * moduleResolution "bundler", so a typo in a grammar path compiles, ships, and
 * then leaves the grammar unregistered -- which `highlightLines` reports as an
 * unknown language, i.e. every .ts file silently rendering unhighlighted. The
 * guard for that is the test asserting each mapped grammar is really
 * registered, not the type checker.
 */
declare module "prismjs" {
  /**
   * One node of Prism's flat token stream.
   *
   * `content` is a string for a leaf token and a nested stream for a container
   * one (markdown's `title`, for example, holds `punctuation` and plain text).
   * The viewer only needs to know leaf text and the type to colour it by.
   */
  export interface Token {
    type: string
    content: string | Array<string | Token>
    length?: number
    alias?: string | string[]
  }

  /** Prism emits untokenized runs as bare strings, so a token is a union. */
  export type StreamToken = string | Token

  const Prism: {
    languages: Record<string, unknown>
    /**
     * Throws a TypeError when `grammar` is undefined -- it reads `.rest` off
     * the grammar without a guard. Callers must check `Prism.languages[name]`
     * first, which is what `languageFor` returning undefined is for.
     */
    tokenize(code: string, grammar: unknown): StreamToken[]
  }

  export default Prism
}
