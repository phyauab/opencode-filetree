import { describe, it, expect } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * OpenCode's Solid context objects are only visible to code sharing its module
 * instance of @opentui/solid. A local runtime copy gives the plugin a second,
 * empty context, and every JSX element then throws "No renderer found". These
 * guards fail loudly rather than letting that reach the TUI.
 */

const root = join(import.meta.dir, "..")
const nodeModules = join(root, "node_modules")

describe("no local OpenTUI runtime", () => {
  it("has no @opentui/solid package installed", () => {
    expect(existsSync(join(nodeModules, "@opentui", "solid"))).toBe(false)
  })

  it("has no @opentui/core package installed", () => {
    expect(existsSync(join(nodeModules, "@opentui", "core"))).toBe(false)
  })

  /** `import.meta.resolve` throws synchronously under Bun when unresolvable. */
  const resolvesLocally = (specifier: string): boolean => {
    try {
      return import.meta.resolve(specifier).includes("plugins/filetree")
    } catch {
      return false
    }
  }

  it("cannot resolve @opentui/solid at runtime", () => {
    expect(resolvesLocally("@opentui/solid")).toBe(false)
  })

  it("cannot resolve the OpenTUI JSX runtime at runtime", () => {
    expect(resolvesLocally("@opentui/solid/jsx-runtime")).toBe(false)
  })

  it("cannot resolve @opentui/core at runtime", () => {
    expect(resolvesLocally("@opentui/core")).toBe(false)
  })

  it("keeps types available for the aliased packages", () => {
    expect(existsSync(join(nodeModules, "opentui-types-solid", "index.d.ts"))).toBe(true)
    expect(existsSync(join(nodeModules, "opentui-types-solid", "jsx-runtime.d.ts"))).toBe(true)
  })

  it("leaves no executable files in the aliased solid package", () => {
    expect(existsSync(join(nodeModules, "opentui-types-solid", "jsx-runtime.js"))).toBe(false)
    expect(existsSync(join(nodeModules, "opentui-types-solid", "index.js"))).toBe(false)
  })

  it("has no local solid-js package installed", () => {
    expect(existsSync(join(nodeModules, "solid-js"))).toBe(false)
  })

  it("cannot resolve solid-js at runtime", () => {
    expect(resolvesLocally("solid-js")).toBe(false)
  })

  it("keeps solid-js types available under the alias", () => {
    expect(existsSync(join(nodeModules, "solid-types", "types", "index.d.ts"))).toBe(true)
  })

  it("leaves no executable files in the aliased solid-js package", () => {
    expect(existsSync(join(nodeModules, "solid-types", "dist", "solid.js"))).toBe(false)
  })
})