// Post-install guard.
//
// OpenCode's Solid context objects are only visible to code that shares its
// module instance of @opentui/solid. If a runtime copy is reachable from this
// package, the plugin gets a second, empty context and every JSX element throws
// "No renderer found". The aliased packages exist for types only, so their
// executable files are deleted here; TypeScript keeps working because it reads
// the .d.ts files, and Node/Bun resolution finds nothing to load.

import { rm } from "node:fs/promises"
import { join } from "node:path"
import { glob } from "node:fs/promises"

const root = join(import.meta.dirname, "..")
const packages = ["opentui-types-core", "opentui-types-solid", "solid-types"]

/** Files that make a package loadable at runtime. */
const RUNTIME_SUFFIXES = [".js", ".mjs", ".cjs", ".bun.js", ".wasm", ".node"]

async function stripRuntimeFiles(pkg) {
  const base = join(root, "node_modules", pkg)
  const removed = []

  for await (const entry of glob("**/*", { cwd: base, withFileTypes: false })) {
    if (!RUNTIME_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue
    await rm(join(base, entry), { force: true })
    removed.push(entry)
  }
  return removed
}

let total = 0
for (const pkg of packages) {
  try {
    const removed = await stripRuntimeFiles(pkg)
    total += removed.length
    if (removed.length > 0) console.log(`${pkg}: removed ${removed.length} runtime files`)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}
console.log(`opentui type-only guard: ${total} runtime files removed`)