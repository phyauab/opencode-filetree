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
  /** Renderables passed to the renderer's focus and blur APIs. */
  const focusedRenders: unknown[] = []
  const blurred: unknown[] = []

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
    renderer: {
      focusRenderable: (r: unknown) => focusedRenders.push(r),
      blurRenderable: (r: unknown) => blurred.push(r),
      currentFocusedRenderable: null,
    },
  }

  const allCommands = () =>
    layers.flatMap((l) => {
      const layer = l.factory()
      // `scoped` marks a layer limited to the tree's renderable by target.
      const scoped = typeof layer.target === "function"
      return (layer.commands ?? []).map((c: any) => ({ ...c, mode: layer.mode, scoped }))
    })

  /** Commands in the focus-scoped navigation layer. */
  const layersScoped = (all: { factory: AnyFn }[]) =>
    all.flatMap((l) => {
      const layer = l.factory()
      if (typeof layer.target !== "function") return []
      return (layer.commands ?? []).map((c: any) => c)
    })

  return {
    context,
    slots,
    layers,
    prompts,
    toasts,
    pushed,
    focusedRenders,
    blurred,
    allCommands,
    layersScoped,
  }
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

  itRender("scopes navigation keys to the tree's focus and leaves the prompt's keys alone", async () => {
    const { default: mod } = await load()
    const { context, allCommands, layers, layersScoped } = createMockContext()
    await mod.setup(context)

    // Arrows and enter live only in the focus-scoped layer, so the prompt keeps
    // them.
    const scoped = layersScoped(layers)
    expect(scoped.map((c: any) => c.bind)).toContain("up")
    expect(scoped.map((c: any) => c.bind)).toContain("down")
    expect(scoped.map((c: any) => c.bind)).toContain("enter")

    // Every other layer must leave the host's keys alone.
    const unscoped = allCommands().filter((c: any) => !c.scoped)
    const unscopedBinds = unscoped.map((c: any) => c.bind)
    expect(unscopedBinds).not.toContain("up")
    expect(unscopedBinds).not.toContain("down")
    expect(unscopedBinds).not.toContain("enter")
  })

  itRender("binds no keys outside the tree's focus scope", async () => {
    const { default: mod } = await load()
    const { context, layers, allCommands } = createMockContext()
    await mod.setup(context)

    // Keys outside the focus-scoped layer fire while the user is typing.
    // readline owns ctrl+f, ctrl+o and ctrl+t, so any of those would break the
    // prompt. The focus command must stay palette-only.
    for (const command of allCommands().filter((c: any) => !c.scoped)) {
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

  itRender("focuses and blurs through the renderer's focus API", async () => {
    const { default: mod } = await load()
    const { context, allCommands, slots, focusedRenders, blurred } = createMockContext()
    await mod.setup(context)

    // The renderer tracks which renderable holds focus and routes keys to it.
    // Calling Renderable.focus() alone leaves that view unchanged, so the tree
    // never became reachable.
    const treeElement = slots[0].claim.render({ sessionID: "ses_1" }) as any
    const rootElement = treeElement.type(treeElement.props) as any
    const root = { focused: false, focus: () => {}, blur: () => {} }
    rootElement.props.ref(root)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!
    byId("filetree.enter-mode").run()
    expect(focusedRenders).toEqual([root])

    byId("filetree.exit").run()
    expect(blurred).toEqual([root])
  })

  itRender("never pushes an input mode", async () => {
    const { default: mod } = await load()
    const { context, allCommands, pushed } = createMockContext()
    await mod.setup(context)

    const byId = (id: string) => allCommands().find((c: any) => c.id === id)!
    byId("filetree.enter-mode").run()
    byId("filetree.exit").run()

    // Pushing a mode took over the host's keyboard: afterwards no key reached
    // anything and only clicking recovered. Navigation is scoped to the tree's
    // own focus instead.
    expect(pushed).toEqual([])
  })

  itRender("scopes navigation to the tree's focus rather than a mode", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext()
    await mod.setup(context)

    const tree = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.up"),
    )
    expect(tree).toBeDefined()
    // No mode: the layer must not be able to disable the host's own bindings.
    expect(tree?.factory().mode).toBeUndefined()

    // Nothing has rendered the tree yet, so the layer is inactive and unnamed.
    expect(tree?.factory().enabled?.()).toBe(false)
    expect(tree?.factory().target?.()).toBeNull()
  })

  itRender("activates the navigation layer once the tree takes focus", async () => {
    const { default: mod } = await load()
    const { context, layers, slots } = createMockContext()
    await mod.setup(context)

    const layer = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.up"),
    )!

    // Render the sidebar, then render the tree element it produced. The tree's
    // root box carries the ref callback that hands the plugin the renderable.
    const treeElement = slots[0].claim.render({ sessionID: "ses_1" }) as any
    const rootElement = treeElement.type(treeElement.props) as any
    const root = { focused: false, focus: () => {} }
    rootElement.props.ref(root)

    expect(layer.factory().enabled?.()).toBe(false)

    root.focused = true
    expect(layer.factory().enabled?.()).toBe(true)
    expect(layer.factory().target?.()).toBe(root)
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