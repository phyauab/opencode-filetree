/**
 * Builds the plugin into dist/.
 *
 * The JSX is compiled by babel-preset-solid, never by tsc. tsc's JSX modes
 * ("react-jsx", "preserve") emit `jsx(type, props)` with props as a plain
 * object, and Solid's components read their props from inside a memo -- so a
 * plain object hands them no dependency and they never re-run. Every <Show>
 * and <For> in a tsc-built plugin is therefore inert: state changes, the
 * host's renderables never do, and the panel goes stale while the state
 * underneath it is correct.
 *
 * babel-preset-solid wraps props in getters, which is what makes them
 * reactive. That difference is the whole bug this file exists to prevent.
 *
 * tsc still runs, for declarations only.
 */
import { transformAsync } from "@babel/core"
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { join, dirname, relative } from "node:path"
import { execFileSync } from "node:child_process"

const root = join(import.meta.dirname, "..")
const src = join(root, "src")
const out = join(root, "dist")

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// Declarations. tsc can do this much and only this much.
execFileSync("tsc", ["-p", "tsconfig.build.json", "--emitDeclarationOnly"], {
  cwd: root,
  stdio: "inherit",
})

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else files.push(path)
  }
  return files
}

let compiled = 0
for (const file of await walk(src)) {
  // Tests are excluded here as well as in tsconfig.build.json: the old tsc
  // build never emitted them, and shipping them would put bun:test in dist.
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) continue
  const code = await readFile(file, "utf8")
  const result = await transformAsync(code, {
    filename: file,
    configFile: false,
    babelrc: false,
    presets: [
      ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
      "@babel/preset-typescript",
    ],
  })
  const rel = relative(src, file).replace(/\.[cm]?[jt]sx?$/, ".js")
  const dest = join(out, rel)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, result?.code ?? code)
  compiled++
}

console.log(`solid build: compiled ${compiled} file(s) into dist/`)
