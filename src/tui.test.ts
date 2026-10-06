import { describe, it, expect } from "bun:test"

type AnyFn = (...args: any[]) => any

/** Minimal stand-in for the TUI plugin Context, recording what the plugin registers. */
function createMockContext() {
  const slots: { claim: any }[] = []
  const layers: { factory: AnyFn }[] = []
  const prompts: any[] = []
  const pushed: { mode: string }[] = []

  const context: any = {
    options: {},
    location: { directory: process.cwd() },
    app: { version: "test", channel: "test" },
    client: {
      session: {
        prompt: (input: any) => {
          prompts.push(input)
          return Promise.resolve({})
        },
      },
    },
    ui: {
      slot: (claim: any) => {
        slots.push({ claim })
        return () => {}
      },
      toast: { show: () => {} },
      format: { path: (v: string) => v },
    },
    keymap: {
      layer: (factory: AnyFn) => layers.push({ factory }),
      mode: {
        current: () => "base",
        push: (mode: string) => {
          pushed.push({ mode })
          return () => {}
        },
      },
    },
    storage: {
      store: () => [{}, async () => {}],
      memory: () => [{}, () => {}],
    },
    data: {
      on: () => () => {},
      listen: () => () => {},
    },
    theme: {},
    renderer: {},
  }

  return { context, slots, layers, prompts, pushed }
}

describe("plugin entry", () => {
  it("registers the sidebar.content slot", async () => {
    const { default: plugin } = await import("./tui")
    const { context, slots } = createMockContext()

    await plugin.setup(context)

    expect(slots).toHaveLength(1)
    expect(slots[0].claim.append).toBe("sidebar.content")
  })

  it("registers a keymap layer for every documented binding", async () => {
    const { default: plugin } = await import("./tui")
    const { context, layers } = createMockContext()

    await plugin.setup(context)

    const ids = layers.flatMap((l) =>
      l.factory().commands.map((c: any) => c.id),
    )

    for (const id of [
      "filetree.up",
      "filetree.down",
      "filetree.expand",
      "filetree.collapse",
      "filetree.open",
      "filetree.send",
      "filetree.refresh",
      "filetree.exit",
      "filetree.enter-mode",
    ]) {
      expect(ids).toContain(id)
    }
  })

  it("entering and exiting tree mode does not throw", async () => {
    const { default: plugin } = await import("./tui")
    const { context, layers, pushed } = createMockContext()

    await plugin.setup(context)

    const commands = layers.flatMap((l) => {
      const layer = l.factory()
      return layer.commands.map((c: any) => ({ ...c, mode: layer.mode }))
    })
    const byId = (id: string) => commands.find((c) => c.id === id)!

    byId("filetree.enter-mode").run()
    expect(pushed).toEqual([{ mode: "filetree" }])

    byId("filetree.exit").run()
  })

  it("navigating an empty tree through the registered commands does not throw", async () => {
    const { default: plugin } = await import("./tui")
    const { context, layers } = createMockContext()

    await plugin.setup(context)

    const commands = layers.flatMap((l) => l.factory().commands as any[])
    const byId = (id: string) => commands.find((c) => c.id === id)!

    for (const id of [
      "filetree.up",
      "filetree.down",
      "filetree.expand",
      "filetree.collapse",
      "filetree.open",
      "filetree.refresh",
    ]) {
      expect(() => byId(id).run()).not.toThrow()
    }
  })

  it("returns a cleanup function that unregisters the slot", async () => {
    const { default: plugin } = await import("./tui")
    let unregistered = false
    const { context } = createMockContext()
    context.ui.slot = () => () => {
      unregistered = true
    }

    const cleanup = await plugin.setup(context)
    expect(typeof cleanup).toBe("function")

    await cleanup!()
    expect(unregistered).toBe(true)
  })
})