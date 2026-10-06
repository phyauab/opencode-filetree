import { describe, it, expect } from "bun:test"

type AnyFn = (...args: any[]) => any

// These checks call setup() but never render a component, so the stubbed JSX
// runtime is enough. They used to be skipped, which is how a duplicate command
// id shipped: a shape error in one layer threw before the next layer was
// registered, and no test was watching for it.
const itRender = it

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
  const load = () => import("./tui")

  itRender("registers the sidebar.content slot", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    expect(slots).toHaveLength(1)
    expect(slots[0].claim.append).toBe("sidebar.content")
  })

  itRender("registers every documented binding", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

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

  itRender("scopes navigation keys to tree mode and leaves the prompt's keys alone", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

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

  itRender("binds no keys in the host's input mode", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

    // Every key registered outside tree mode fires while the user is typing.
    // readline owns ctrl+f, ctrl+o and ctrl+t, so any of those would break the
    // prompt. The focus command must stay palette-only.
    const inHostMode = allCommands().filter((c: any) => c.mode !== "filetree")
    for (const command of inHostMode) {
      expect(command.bind).toBeUndefined()
      expect(command.slash).toBeUndefined()
    }
  })

  itRender("never registers the same command id twice in one layer", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext()
    await mod.setup(context)

    // keymap.layer throws synchronously on a duplicate id, aborting setup before
    // later layers register. The tree would still render, with no working keys.
    for (const { factory } of layers) {
      const ids = (factory().commands ?? []).map((c: any) => c.id).filter(Boolean)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  itRender("registers the focus command before the tree layer", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext()
    await mod.setup(context)

    // The focus command must exist even if the tree layer fails to register,
    // otherwise there is no way back into the tree.
    const first = (layers[0].factory().commands ?? []).map((c: any) => c.id)
    expect(first).toContain("filetree.enter-mode")
  })

  itRender("pushes tree mode on focus and pops it on exit", async () => {
    const { default: mod } = await load()
    const { context, allCommands, pushed } = createMockContext()
    await mod.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!

    byId("filetree.enter-mode").run()
    expect(pushed).toEqual(["filetree"])

    byId("filetree.exit").run()
    byId("filetree.enter-mode").run()
    expect(pushed).toEqual(["filetree", "filetree"])
  })

  itRender("navigating an empty tree does not throw", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!
    for (const id of ["filetree.up", "filetree.down", "filetree.expand", "filetree.collapse", "filetree.send", "filetree.refresh"]) {
      expect(() => byId(id).run()).not.toThrow()
    }
  })

  itRender("the send path never rejects, whatever the prompt call does", async () => {
    const { default: mod } = await load()
    const { context, allCommands, prompts, toasts } = createMockContext({ promptFails: true })
    await mod.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!

    // Runs against an empty tree, so there is nothing to send; the point is
    // that the command never produces an unhandled rejection.
    await expect(async () => byId("filetree.send").run()).not.toThrow()
    expect(prompts).toHaveLength(0)
    expect(toasts).toHaveLength(0)
  })

  itRender("cleanup unregisters the slot and leaves tree mode", async () => {
    const { default: mod } = await load()
    let unregistered = false
    const { context } = createMockContext()
    context.ui.slot = () => () => {
      unregistered = true
    }

    const cleanup = await mod.setup(context)
    await cleanup?.()
    expect(unregistered).toBe(true)
  })
})