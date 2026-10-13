import { describe, it, expect } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"

/**
 * OpenCode rewrites bare OpenTUI/solid specifiers in plugin files so they point
 * at the host's copies. Its scan does not follow extensionless relative imports,
 * so a module imported as "./store" loads without the rewrite and ends up with a
 * different renderer context — "No renderer found". See
 * anomalyco/opencode#37836.
 */

const dist = join(import.meta.dir, "..", "dist")
const RELATIVE_IMPORT = /from\s+["'](\.[^"']*)["']/g

/**
 * Every .js file under dist/, at any depth, with its source. dist/ is nested
 * (dist/viewer/), so a top-level-only scan misses exactly the modules that
 * carry bare @opentui/solid imports behind an extensionless edge.
 */
async function distModules(): Promise<{ file: string; label: string; source: string }[]> {
  const modules: { file: string; label: string; source: string }[] = []

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        modules.push({ file: path, label: relative(dist, path), source: await readFile(path, "utf8") })
      }
    }
  }

  await walk(dist)
  return modules
}

describe("dist import specifiers", () => {
  it("has been built", async () => {
    expect(existsSync(join(dist, "tui.js"))).toBe(true)
  })

  it("gives every relative import an explicit .js extension", async () => {
    const offenders = []

    for (const { label, source } of await distModules()) {
      for (const match of source.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1]
        if (!/\.(js|json|mjs|cjs)$/.test(specifier)) {
          offenders.push(`${label}: "${specifier}"`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it("resolves each rewritten specifier to a real file", async () => {
    const missing = []

    for (const { file, label, source } of await distModules()) {
      for (const match of source.matchAll(RELATIVE_IMPORT)) {
        const specifier = match[1]
        // Relative to the importing file's own directory, not to dist/: a
        // nested module's "../x" climbs out of its subdirectory.
        if (!existsSync(join(dirname(file), specifier))) missing.push(`${label}: "${specifier}"`)
      }
    }

    expect(missing).toEqual([])
  })

  it("leaves host-resolved specifiers bare", async () => {
    const source = await readFile(join(dist, "tui.js"), "utf8")
    // These must stay as written so the host can rewrite them.
    expect(source).toContain('from "@opentui/solid"')
    expect(source).toContain('from "@opencode/plugin/tui"')
  })

  it("wraps component props in getters so they stay reactive", async () => {
    // tsc cannot do this: its JSX modes pass props as a plain object, and a
    // Solid component reading its props from a memo then has no dependency
    // and never re-runs. The whole plugin was inert until the build switched
    // to babel-preset-solid.
    const source = await readFile(join(dist, "FileTree.js"), "utf8")
    expect(source).toMatch(/get when\(\)/)
  })
})