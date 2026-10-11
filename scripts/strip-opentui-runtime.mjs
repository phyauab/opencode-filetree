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

/**
 * Directories bun hoists beside the aliases, which must not be loadable.
 *
 * `opentui-types-solid` is `@opentui/solid`, and `@opentui/solid` has a
 * non-optional `peerDependency` on `solid-js` plus a dependency on
 * `@opentui/core`; bun resolves all three and hoists the last two to the top of
 * `node_modules` under their real names, on every install, forever. That is a
 * runtime copy of exactly the two packages this guard exists to keep out: the
 * host's OpenTUI context objects are only visible to code sharing the host's
 * module instance, so a local one gives the plugin a second, empty context and
 * every JSX element throws "No renderer found".
 *
 * The aliases carry the types -- `tsconfig.json`'s `paths` point at them -- so
 * nothing in this package needs the hoisted copies, and the test in
 * `scripts/verify-no-local-opentui.test.ts` is the guard that they stay gone.
 * Deleting the directories rather than their files, because a directory with
 * only its `.d.ts` left in it is still a directory `existsSync` reports and
 * still a package that resolves.
 */
const HOISTED = [join(root, "node_modules", "solid-js"), join(root, "node_modules", "@opentui", "core")]

for (const dir of HOISTED) {
  try {
    await rm(dir, { recursive: true, force: true })
    console.log(`${dir}: removed hoisted runtime copy`)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}

console.log(`opentui type-only guard: ${total} runtime files removed`)