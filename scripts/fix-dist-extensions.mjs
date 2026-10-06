// Post-build fix: OpenCode rewrites bare OpenTUI/solid specifiers in plugin
// files, but its scan does not follow extensionless relative imports, so those
// modules load without the rewrite and lose the host's renderer context.
// Adding explicit .js extensions keeps every module on the rewritten path.
// See anomalyco/opencode#37836.

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const dist = join(import.meta.dirname, "..", "dist")

/** Matches `from "./name"` and `from "../name/sub"`. */
const RELATIVE_IMPORT = /from\s+["'](\.[^"']*)["']/g

function addExtension(specifier) {
  if (/\.(js|json|mjs|cjs)$/.test(specifier)) return specifier
  return `${specifier}.js`
}

let patched = 0
for (const entry of await readdir(dist, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue

  const file = join(dist, entry.name)
  const source = await readFile(file, "utf8")
  const next = source.replace(RELATIVE_IMPORT, (match, specifier) =>
    match.replace(specifier, addExtension(specifier)),
  )

  if (next !== source) {
    await writeFile(file, next)
    patched++
  }
}

console.log(`extension fix: patched ${patched} file(s) in dist/`)