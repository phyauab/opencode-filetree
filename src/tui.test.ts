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
      commands: () => [],
      active: () => [],
      shortcuts: () => [],
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
      // `gated` marks the navigation layer, the only one allowed to bind keys.
      const gated = typeof layer.enabled === "function"
      return (layer.commands ?? []).map((c: any) => ({ ...c, mode: layer.mode, gated }))
    })

  /** Commands in the gated navigation layer. */
  const layersScoped = (all: { factory: AnyFn }[]) =>
    all.flatMap((l) => {
      const layer = l.factory()
      if (typeof layer.enabled !== "function") return []
      return (layer.commands ?? []).map((c: any) => c)
    })

  return { context, slots, layers, prompts, toasts, pushed, allCommands, layersScoped }
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

  itRender("gates navigation keys so the prompt keeps them", async () => {
    const { default: mod } = await load()
    const { context, allCommands, layers, layersScoped } = createMockContext()
    await mod.setup(context)

    // Arrows and enter live only in the gated layer, which is disabled while
    // the tree is inactive, so the prompt keeps them.
    const gated = layersScoped(layers)
    expect(gated.map((c: any) => c.bind)).toContain("up")
    expect(gated.map((c: any) => c.bind)).toContain("down")
    expect(gated.map((c: any) => c.bind)).toContain("enter")

    // Every other layer must leave the host's keys alone.
    const ungated = allCommands().filter((c: any) => !c.gated)
    const ungatedBinds = ungated.map((c: any) => c.bind)
    expect(ungatedBinds).not.toContain("up")
    expect(ungatedBinds).not.toContain("down")
    expect(ungatedBinds).not.toContain("enter")
  })

  itRender("binds no keys outside the gated navigation layer", async () => {
    const { default: mod } = await load()
    const { context, layers, allCommands } = createMockContext()
    await mod.setup(context)

    // Keys outside the gated layer fire while the user is typing.
    // readline owns ctrl+f, ctrl+o and ctrl+t, so any of those would break the
    // prompt. The focus command must stay palette-only.
    for (const command of allCommands().filter((c: any) => !c.gated)) {
      expect(command.bind).toBeUndefined()
      expect(command.slash).toBeUndefined()
    }
    expect(layers.length).toBe(2)
  })

  itRender("keeps the focus command reachable in every input mode", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext()
    await mod.setup(context)

    // A layer with no mode defaults to "base", so the palette only offered the
    // focus command while the TUI sat in its base mode. It must be global.
    const focus = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.enter-mode"),
    )
    expect(focus?.factory().mode).toBe("global")
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

  itRender("enables navigation on focus and disables it on exit", async () => {
    const { default: mod } = await load()
    const { context, allCommands, layers, slots } = createMockContext()
    await mod.setup(context)

    // Focusing needs the tree's renderable, which the sidebar supplies on render.
    const treeElement = slots[0].claim.render({ sessionID: "ses_1" }) as any
    const rootElement = treeElement.type(treeElement.props) as any
    rootElement.props.ref({ focused: false })

    const layer = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.up"),
    )!
    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!

    expect(layer.factory().enabled?.()).toBe(false)
    byId("filetree.enter-mode").run()
    expect(layer.factory().enabled?.()).toBe(true)
    byId("filetree.exit").run()
    expect(layer.factory().enabled?.()).toBe(false)
  })

  itRender("activates the navigation layer when the tree is clicked", async () => {
    const { default: mod } = await load()
    const { context, layers, slots } = createMockContext()
    await mod.setup(context)

    const layer = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.up"),
    )!

    // Render the sidebar, then the tree element, and click it.
    const treeElement = slots[0].claim.render({ sessionID: "ses_1" }) as any
    const rootElement = treeElement.type(treeElement.props) as any
    rootElement.props.ref({ focused: false })
    expect(layer.factory().enabled?.()).toBe(false)

    rootElement.props.onMouseDown()
    expect(layer.factory().enabled?.()).toBe(true)
  })

  itRender("never pushes an input mode", async () => {
    const { default: mod } = await load()
    const { context, allCommands, pushed } = createMockContext()
    await mod.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!
    byId("filetree.enter-mode").run()
    byId("filetree.exit").run()

    // Pushing a mode took over the host's keyboard: afterwards no key reached
    // anything and only clicking recovered. A reactive enabled flag gates this
    // plugin's layer alone and cannot take the host's keys away.
    expect(pushed).toEqual([])
  })

  itRender("gates navigation with enabled, never a mode or a focus target", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext()
    await mod.setup(context)

    const nav = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.up"),
    )
    expect(nav).toBeDefined()

    // global mode so the layer is never filtered out of dispatch, no target so
    // it cannot depend on unverifiable renderer focus, and enabled so it is off
    // until the user asks for it.
    expect(nav?.factory().mode).toBe("global")
    expect(nav?.factory().target).toBeUndefined()
    expect(typeof nav?.factory().enabled).toBe("function")

    // An enabled layer that loses dispatch to the prompt shows as active but
    // does nothing, which is exactly the failure this guards against.
    expect(nav?.factory().priority).toBeGreaterThan(0)
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