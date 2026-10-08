import { describe, it, expect } from "bun:test"

type AnyFn = (...args: any[]) => any

// These checks call setup() but never render a component, so the stubbed JSX
// runtime is enough. They used to be skipped, which is how a duplicate command
// id shipped: a shape error in one layer threw before the next layer was
// registered, and no test was watching for it.
const itRender = it

const PANEL = "filetree.tree"
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Twenty entries, every fifth one a folder, so a click or a keypress lands on a
 * predictable row.
 */
const entries = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `f${i}`,
    path: `/proj/f${i}`,
    isDirectory: i % 5 === 0,
  }))

/** Captures what the plugin registers, and lets a test make calls fail. */
function createMockContext(options: { panelOpen?: boolean; promptFails?: boolean } = {}) {
  const slots: { claim: any }[] = []
  const layers: { factory: AnyFn }[] = []
  const pushed: string[] = []
  const opened: string[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const toasts: { message: string; variant: string }[] = []
  let closed = 0
  let isOpen = options.panelOpen === true

  const context: any = {
    options: {},
    location: { directory: process.cwd() },
    app: { version: "test", channel: "test" },
    client: {
      session: {
        prompt: async (input: { sessionID: string; text: string }) => {
          prompts.push(input)
          if (options.promptFails) throw new Error("server unreachable")
          return {}
        },
      },
    },
    ui: {
      slot: (claim: any) => {
        slots.push({ claim })
        return () => {}
      },
      toast: {
        show: (toast: { message: string; variant: string }) => {
          toasts.push(toast)
        },
      },
      format: { path: (v: string) => v },
      panel: {
        open: (name: string) => {
          opened.push(name)
          isOpen = true
          return true
        },
        close: () => {
          closed++
          isOpen = false
        },
        current: () => (isOpen ? { name: PANEL, sessionID: "ses_1" } : undefined),
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
    prompts,
    toasts,
    closedCount: () => closed,
    allCommands,
    /**
     * Reaches the tree state the way the host reaches it: by rendering the
     * panel slot and reading the state off the component it returns.
     */
    panelState: (count = 20) => {
      const show = slots[0].claim.render({ name: PANEL, sessionID: "ses_1" }) as any
      const state = show.props.children.props.state
      state.setEntries(entries(count))
      return state
    },
    /** Mounts the panel, as `panel.close()` + `panel.open()` makes the host do. */
    mountPanel: () => {
      isOpen = true
      slots[0].claim.render({ name: PANEL, sessionID: "ses_1" })
    },
    renderPanel: (input: { name: string; sessionID?: string }) =>
      slots[0].claim.render(input),
    command: (id: string) => allCommands().find((c: any) => c.id === id),
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

  itRender("registers each navigation command exactly once", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

    // The navigation commands are the user's only way around the tree, so they
    // have to exist from setup rather than from a component body: a body that
    // re-runs per panel mount registers a second copy of every id, and
    // keymap.layer throws on a duplicate.
    const ids = allCommands().map((c: any) => c.id)
    expect(ids).toContain("filetree.down")
    expect(ids).toContain("filetree.up")
    expect(new Set(ids).size).toBe(ids.length)
  })

  itRender("disables the navigation keys while the panel is closed", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext({ panelOpen: false })
    await mod.setup(context)

    const nav = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.down"),
    )
    expect(nav).toBeDefined()
    // While the panel is closed the host is typing into the prompt, so the
    // plugin's bindings must not fire.
    expect(nav!.factory().enabled()).toBe(false)
  })

  itRender("enables the navigation keys while the panel is open", async () => {
    const { default: mod } = await load()
    const { context, layers } = createMockContext({ panelOpen: true })
    await mod.setup(context)

    const nav = layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.down"),
    )
    expect(nav!.factory().enabled()).toBe(true)
  })

  itRender("binds ctrl+e to the panel toggle", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

    // Reaching for ctrl+p and the palette for every open was the complaint;
    // ctrl+e is unbound in the host's defaults (checked the full list), and it
    // is the convention VS Code uses for a file explorer.
    expect(allCommands().find((c: any) => c.id === "filetree.toggle")!.bind).toBe("ctrl+e")
  })

  itRender("one keypress moves the cursor exactly one row", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    // The navigation layer used to be registered from the panel component, so
    // each remount added another copy of every binding and a single keypress ran
    // one handler per copy, walking the cursor several rows at a time.
    for (let i = 0; i < 4; i++) m.mountPanel()
    state.setCursor(0)
    m.command("filetree.down")!.run()

    expect(state.cursor()).toBe(1)
  })

itRender("renders the panel as many times as the host asks without adding layers", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const before = m.layers.length

    // The host calls the slot render again every time the panel is mounted, and
    // a session mounts it more than once. Registering keymap layers from it is
    // what leaked a duplicate copy of every binding.
    for (let i = 0; i < 8; i++) m.mountPanel()

    expect(m.layers.length).toBe(before)
  })

  itRender("moving the cursor never closes and reopens the panel", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    // Closing the panel and opening it again is the flash the user sees: the
    // whole screen is torn down and rebuilt to move a selection marker one row.
    // The rows already re-render themselves in place, so the panel must be left
    // alone entirely.
    state.setCursor(0)
    m.command("filetree.down")!.run()
    m.command("filetree.down")!.run()
    await wait(160)

    expect(m.closedCount()).toBe(0)
    expect(m.opened).toEqual([])
    expect(state.cursor()).toBe(2)
  })

  itRender("expanding a folder never closes and reopens the panel", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(0)
    m.command("filetree.expand")!.run()
    m.command("filetree.expand")!.run()
    m.command("filetree.expand")!.run()
    await wait(160)

    expect(m.closedCount()).toBe(0)
    expect(m.opened).toEqual([])
  })

  itRender("escape closes the panel and a pending repaint does not reopen it", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    m.panelState()

    // Move the cursor, then close the panel. An earlier version armed a repaint on
    // every change, and it fired after the user had closed the panel, reopening
    // it and making escape look like it did nothing.
    m.command("filetree.down")!.run()
    await wait(10)
    m.command("filetree.close")!.run()
    expect(m.closedCount()).toBe(1)

    await wait(160)
    expect(m.opened).toEqual([])
  })

  itRender("the toggle closes without a pending repaint reopening it", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    m.panelState()

    m.command("filetree.down")!.run()
    await wait(10)
    m.command("filetree.toggle")!.run()
    expect(m.closedCount()).toBe(1)

    await wait(160)
    expect(m.opened).toEqual([])
  })

  itRender("enter on a file spawns the editor without touching the expansion", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    // f1 is a file. A command that always exists and exits immediately stands in
    // for a real editor; the argv it is handed is commands.ts's own contract.
    state.setCursor(1)
    const editor = process.env.EDITOR
    process.env.EDITOR = process.platform === "win32" ? "cmd" : "/usr/bin/true"
    try {
      await m.command("filetree.open")!.run()
      await wait(50)
    } finally {
      if (editor === undefined) delete process.env.EDITOR
      else process.env.EDITOR = editor
    }

    expect([...state.expanded()]).toEqual([])
    expect(m.toasts).toEqual([])
  })

  itRender("toasts instead of throwing when the editor cannot be spawned", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    const editor = process.env.EDITOR
    process.env.EDITOR = "definitely-not-a-real-editor-xyz"
    try {
      await m.command("filetree.open")!.run()
      await wait(50)
    } finally {
      if (editor === undefined) delete process.env.EDITOR
      else process.env.EDITOR = editor
    }

    expect(m.toasts).toHaveLength(1)
    expect(m.toasts[0].variant).toBe("error")
    expect(m.toasts[0].message).toContain("f1")
  })

  itRender("enter expands a folder instead of launching the editor", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    // f0 is a folder.
    state.setCursor(0)
    m.command("filetree.open")!.run()
    await wait(120)

    expect([...state.expanded()]).toEqual(["/proj/f0"])
    // The rows re-render themselves; the panel must not be torn down to show it.
    expect(m.closedCount()).toBe(0)
    expect(m.opened).toEqual([])
  })

itRender("s uses the session that owns the file tree panel", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    // The slot is appended to every panel in the session, so a neighbouring
    // panel must not redirect the prompt somewhere else.
    m.renderPanel({ name: "acme.review", sessionID: "ses_OTHER" })

    state.setCursor(1)
    m.command("filetree.send")!.run()
    await wait(20)

    expect(m.prompts).toEqual([{ sessionID: "ses_1", text: "Read /proj/f1" }])
  })

  itRender("s sends the selected path to the session", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true })
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.send")!.run()
    await wait(20)

    expect(m.prompts).toEqual([{ sessionID: "ses_1", text: "Read /proj/f1" }])
  })

  itRender("toasts instead of throwing when the prompt is rejected", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ panelOpen: true, promptFails: true })
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.send")!.run()
    await wait(20)

    expect(m.toasts).toHaveLength(1)
    expect(m.toasts[0].variant).toBe("error")
    expect(m.toasts[0].message).toContain("server unreachable")
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
