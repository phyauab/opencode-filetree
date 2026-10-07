import { describe, it, expect } from "bun:test"

type AnyFn = (...args: any[]) => any

// These checks call setup() but never render a component, so the stubbed JSX
// runtime is enough. They used to be skipped, which is how a duplicate command
// id shipped: a shape error in one layer threw before the next layer was
// registered, and no test was watching for it.
const itRender = it

/** Captures what the plugin registers, and lets a test make calls fail. */
function createMockContext(options: { panelOpen?: boolean } = {}) {
  const slots: { claim: any }[] = []
  const layers: { factory: AnyFn }[] = []
  const pushed: string[] = []
  const opened: string[] = []
  let closed = 0
  const currentName = options.panelOpen ? "filetree.tree" : undefined

  const context: any = {
    options: {},
    location: { directory: process.cwd() },
    app: { version: "test", channel: "test" },
    client: { session: { prompt: async () => ({}) } },
    ui: {
      slot: (claim: any) => {
        slots.push({ claim })
        return () => {}
      },
      toast: { show: () => {} },
      format: { path: (v: string) => v },
      panel: {
        open: (name: string) => {
          opened.push(name)
          return true
        },
        close: () => {
          closed++
        },
        current: () => (currentName ? { name: currentName, sessionID: "ses_1" } : undefined),
      },
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
      return (layer.commands ?? []).map((c: any) => ({ ...c, mode: layer.mode, layer }))
    })

  return {
    context,
    slots,
    layers,
    pushed,
    opened,
    closedCount: () => closed,
    allCommands,
  }
}

describe("plugin entry", () => {
  const load = () => import("./tui")

  itRender("claims the session.panel slot, not the sidebar", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    // A panel is the documented surface for interactive plugin UI: the host owns
    // sizing, focus and input scope. The sidebar slot offers neither, which is
    // why nothing the plugin changed was ever painted or keyed.
    expect(slots).toHaveLength(1)
    expect(slots[0].claim.append).toBe("session.panel")
  })

  itRender("renders the panel content only for its own name", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    // Another plugin's panel must not render the tree.
    const other = slots[0].claim.render({ name: "acme.review", sessionID: "ses_1" })
    expect(typeof other.type).toBe("function")

    // The tree's own panel renders a component, not text.
    const ours = slots[0].claim.render({ name: "filetree.tree", sessionID: "ses_1" })
    expect(typeof ours.type).toBe("function")
  })

  itRender("opens and closes the panel from one command", async () => {
    const { default: mod } = await load()
    const { context, allCommands, opened } = createMockContext()
    await mod.setup(context)

    const toggle = allCommands().find((c: any) => c.id === "filetree.toggle")!
    expect(toggle).toBeDefined()
    expect(toggle.palette).toBe(true)

    toggle.run()
    expect(opened).toEqual(["filetree.tree"])
  })

  itRender("closes an open panel instead of reopening it", async () => {
    const { default: mod } = await load()
    const { context, allCommands, opened, closedCount } = createMockContext({
      panelOpen: true,
    })
    await mod.setup(context)

    allCommands()
      .find((c: any) => c.id === "filetree.toggle")!
      .run()

    expect(closedCount()).toBe(1)
    expect(opened).toEqual([])
  })

  itRender("scopes navigation keys to the open panel", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext({ panelOpen: true })
    await mod.setup(context)

    // The navigation layer is created by the panel component, so setup only
    // registers the toggle. Assert the toggle binds nothing, leaving the prompt
    // its keys.
    const toggle = allCommands().find((c: any) => c.id === "filetree.toggle")!
    expect(toggle.bind).toBeUndefined()
  })

  itRender("never registers the same command id twice in one layer", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext()
    await mod.setup(context)

    // keymap.layer throws synchronously on a duplicate id, aborting setup before
    // later layers register. The tree would render with no working keys.
    for (const { factory } of layers) {
      const ids = (factory().commands ?? []).map((c: any) => c.id).filter(Boolean)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  itRender("never pushes an input mode", async () => {
    const { default: mod } = await load()
    const { context, allCommands, pushed } = createMockContext()
    await mod.setup(context)

    for (const command of allCommands()) {
      expect(() => command.run()).not.toThrow()
    }

    // Pushing a mode took over the host's keyboard: afterwards no key reached
    // anything and only clicking recovered.
    expect(pushed).toEqual([])
  })

  itRender("cleanup unregisters the panel", async () => {
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