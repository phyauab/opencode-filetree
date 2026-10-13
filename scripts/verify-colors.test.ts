import { describe, it, expect } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Every colour literal in `src/` must be one the host can resolve.
 *
 * `parseColor` (`opentui-types-core/src/lib/RGBA.ts`) looks a name up in
 * `CSS_COLOR_NAMES` and falls through to `hexToRgb` for anything else. A
 * non-hex string fails the hex check and comes back
 * `RGBA.fromValues(1, 0, 1, 1)` -- magenta -- with a `console.warn` that a TUI
 * never shows. A name the host does not know is therefore not "slightly wrong",
 * it is a bright pink line of text.
 *
 * This bit three times in one sitting: `fg="dim"` on the viewer's headers and
 * line-number gutter, `fg: "dim"` on every inactive sidebar row, and
 * `{ reverse: true }` with no `fg` on the active one. A previous author had
 * already found it once -- `FileTree.tsx` carries the note "gray rather than dim
 * because parseColor only accepts CSS color names and hex" -- and fixed only the
 * one line they were looking at.
 *
 * The trap is that `dim` is *not* nonsense. It is a real text attribute
 * (`TextAttributes.DIM`), so it reads as plausible in a colour position and
 * nothing rejects it at compile time. Hence a scan rather than a type: the type
 * system accepts every one of these.
 */

const src = join(import.meta.dir, "..", "src")

const CSS_COLOR_NAMES: Record<string, string> = {
  black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#008000", blue: "#0000FF",
  yellow: "#FFFF00", cyan: "#00FFFF", magenta: "#FF00FF", silver: "#C0C0C0", gray: "#808080",
  grey: "#808080", maroon: "#800000", olive: "#808000", lime: "#00FF00", aqua: "#00FFFF",
  teal: "#008080", navy: "#000080", fuchsia: "#FF00FF", purple: "#800080", orange: "#FFA500",
  brightblack: "#666666", brightred: "#FF6666", brightgreen: "#66FF66", brightblue: "#6666FF",
  brightyellow: "#FFFF66", brightcyan: "#66FFFF", brightmagenta: "#FF66FF", brightwhite: "#FFFFFF",
}

/** Mirrors `parseColor`: the name table, then the hex parser. */
function resolvesToAColour(value: string): boolean {
  const name = value.toLowerCase()
  if (name === "transparent") return true
  if (CSS_COLOR_NAMES[name] !== undefined) return true
  const hex = value.replace(/^#/, "")
  if (hex.length === 3 || hex.length === 4) {
    const expanded = hex
      .split("")
      .map((c) => c + c)
      .join("")
    return /^[0-9A-Fa-f]{6}$/.test(expanded)
  }
  return /^[0-9A-Fa-f]{6}$/.test(hex) || /^[0-9A-Fa-f]{8}$/.test(hex)
}

/** Props the host runs through `parseColor`. */
const COLOUR_PROPS = "fg|bg|borderColor|focusedBorderColor|unfocusedBorderColor"

/** A quoted literal directly assigned to a colour prop, in JSX or in an object. */
const COLOUR_LITERAL = new RegExp(`\\b(?:${COLOUR_PROPS})\\s*[=:]\\s*["']([^"']+)["']`, "g")

/**
 * Drops comments before scanning.
 *
 * Not optional: this file's own siblings document the bug by naming the string
 * (`fg: "dim"`), so a scanner that read comments would report the explanation as
 * the offence. Newlines are kept so reported line numbers still point at the
 * line the reader is looking for.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/\/\/[^\n]*/g, "")
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)))
    else if (/\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found
}

describe("colour literals", () => {
  it("are all ones the host's parseColor can resolve", async () => {
    const offenders: string[] = []

    for (const file of await sourceFiles(src)) {
      const raw = await readFile(file, "utf8")
      const source = stripComments(raw)
      for (const match of source.matchAll(COLOUR_LITERAL)) {
        if (!resolvesToAColour(match[1]!)) {
          const line = source.slice(0, match.index).split("\n").length
          offenders.push(`${file.slice(src.length + 1)}:${line} -> "${match[1]}"`)
        }
      }
    }

    // The failure mode is a magenta line of text with no error anywhere, so this
    // list is the whole output of the bug.
    expect(offenders).toEqual([])
  })

  it("does not use 'dim' as a colour anywhere, by name", async () => {
    // Restated separately because it is the exact string that caused this, and
    // because a future "dim it with fg" is the obvious thing to reach for.
    const offenders: string[] = []

    for (const file of await sourceFiles(src)) {
      const source = stripComments(await readFile(file, "utf8"))
      source.split("\n").forEach((line, i) => {
        if (new RegExp(`\\b(?:${COLOUR_PROPS})\\s*[=:]\\s*["']dim["']`).test(line)) {
          offenders.push(`${file.slice(src.length + 1)}:${i + 1}`)
        }
      })
    }

    expect(offenders).toEqual([])
  })
})