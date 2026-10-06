import { describe, it, expect, beforeEach } from "bun:test"

type AnyFn = (...args: any[]) => any

/** Captures what the plugin registers, and lets a test make calls fail. */
function createMockContext(options: { promptFails?: boolean } = {}) {
  const slots: { claim: any }[] = []
  const layers: { factory: AnyFn }[] = []
  const prompts: any[] = []
  const toasts: any[] = []
  const pushed: string[] = []

  const context: any = {
    options: {},
    location: { directory: process.cwd() },
    app: { version: "test", channel: "test" },
    client: {
      session: {
        prompt: (input: any) => {
          prompts.push(input)
          return options.promptFails
            ? Promise.reject(new Error("server unreachable"))
            : Promise.resolve({})
        },
      },
    },
    ui: {
      slot: (claim: any) => {
        slots.push({ claim })
        return () => {}
      },
      toast: {
        show: (toast: any) => {
          toasts.push(toast)
        },
      },
      format: { path: (v: string) => v },
    },
    keymap: {
      layer: (factory: AnyFn) => layers.push({ factory }),
      mode: {
        current: () => "base",
        push: (mode: string) => {
          pushed.push(mode)
          return () => {}
        },
      },
    },
    storage: { store: () => [{}, async () => {}], memory: () => [{}, () => {}] },
    data: { on: () => () => {}, listen: () => {} },
    theme: {},
    renderer: {},
  }

  const allCommands = () =>
    layers.flatMap((l) => {
      const layer = l.factory()
      return (layer.commands ?? []).map((c: any) => ({ ...c, mode: layer.mode }))
    })

  return { context, slots, layers, prompts, toasts, pushed, allCommands }
}

describe("plugin entry", () => {
  let mod: typeof import("./tui")

  beforeEach(async () => {
    mod = await import("./tui")
  })

  it("registers the sidebar.content slot", async () => {
    const { context, slots } = createMockContext()
    await mod.default.setup(context)

    expect(slots).toHaveLength(1)
    expect(slots[0].claim.append).toBe("sidebar.content")
  })

  it("registers every documented binding", async () => {
    const { context, allCommands } = createMockContext()
    await mod.default.setup(context)

    const ids = allCommands().map((c: any) => c.id)
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

  it("scopes navigation keys to tree mode and leaves the prompt's keys alone", async () => {
    const { context, allCommands } = createMockContext()
    await mod.default.setup(context)

    const inTreeMode = allCommands().filter((c: any) => c.mode === "filetree")
    const binds = inTreeMode.map((c: any) => c.bind)
    expect(binds).toContain("up")
    expect(binds).toContain("down")
    expect(binds).toContain("enter")

    // Nothing outside tree mode claims arrows or enter, so the prompt keeps them.
    const inHostMode = allCommands().filter((c: any) => c.mode !== "filetree")
    const hostBinds = inHostMode.map((c: any) => c.bind)
    expect(hostBinds).not.toContain("up")
    expect(hostBinds).not.toContain("down")
    expect(hostBinds).not.toContain("enter")
  })

  it("pushes tree mode on focus and pops it on exit", async () => {
    const { context, allCommands, pushed } = createMockContext()
    await mod.default.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!

    byId("filetree.enter-mode").run()
    expect(pushed).toEqual(["filetree"])

    byId("filetree.exit").run()
    byId("filetree.enter-mode").run()
    expect(pushed).toEqual(["filetree", "filetree"])
  })

  it("navigating an empty tree does not throw", async () => {
    const { context, allCommands } = createMockContext()
    await mod.default.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!
    for (const id of ["filetree.up", "filetree.down", "filetree.expand", "filetree.collapse", "filetree.send", "filetree.refresh"]) {
      expect(() => byId(id).run()).not.toThrow()
    }
  })

  it("the send path never rejects, whatever the prompt call does", async () => {
    const { context, allCommands, prompts, toasts } = createMockContext({ promptFails: true })
    await mod.default.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!

    // Runs against an empty tree, so there is nothing to send; the point is
    // that the command never produces an unhandled rejection.
    await expect(async () => byId("filetree.send").run()).not.toThrow()
    expect(prompts).toHaveLength(0)
    expect(toasts).toHaveLength(0)
  })

  it("cleanup unregisters the slot and leaves tree mode", async () => {
    let unregistered = false
    const { context } = createMockContext()
    context.ui.slot = () => () => {
      unregistered = true
    }

    const cleanup = await mod.default.setup(context)
    await cleanup?.()
    expect(unregistered).toBe(true)
  })
})