import { describe, it, expect } from "bun:test"

type AnyFn = (...args: any[]) => any

// These checks call setup() but never render a component, so the stubbed JSX
// runtime is enough. They used to be skipped, which is how a duplicate command
// id shipped: a shape error in one layer threw before the next layer was
// registered, and no test was watching for it.
const itRender = it

/** Milliseconds of filesystem quiet before the tree re-reads. */
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
function createMockContext(options: { promptFails?: boolean } = {}) {
  const slots: { claim: any }[] = []
  const layers: { factory: AnyFn }[] = []
  const pushed: string[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const toasts: { message: string; variant: string }[] = []

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
    renderer: { currentFocusedRenderable: null },
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
    prompts,
    toasts,
    allCommands,
    /**
     * Renders the sidebar claim. The sidebar input carries the sessionID
     * directly; the tree element comes back as the claim's own result.
     */
    renderSidebar: (sessionID = "ses_1") =>
      slots[0].claim.render({ sessionID }) as any,
    /** A stand-in for the tree's root renderable, handed over by its ref. */
    rootBox: () => {
      const box: any = {
        focused: false,
        parent: null,
        focus() {
          box.focused = true
          context.renderer.currentFocusedRenderable = box
        },
        blur() {
          box.focused = false
          if (context.renderer.currentFocusedRenderable === box) {
            context.renderer.currentFocusedRenderable = null
          }
        },
      }
      const tree = slots[0].claim.render({ sessionID: "ses_1" })
      tree.props.onRoot(box)
      return box
    },
    /** Puts the focus inside the tree, the way a click on a row does. */
    focusTree: (box: any) => {
      context.renderer.currentFocusedRenderable = { parent: box, focused: true }
    },
    /** Puts the focus somewhere else entirely: the prompt, the session list. */
    focusElsewhere: () => {
      context.renderer.currentFocusedRenderable = { parent: null, focused: true }
    },
    /**
     * Reaches the tree state the way the host reaches it: by rendering the
     * sidebar slot and reading the state off the component it returns.
     */
    panelState: (count = 20) => {
      const tree = slots[0].claim.render({ sessionID: "ses_1" }) as any
      const state = tree.props.state
      state.setEntries(entries(count))
      return state
    },
    command: (id: string) => allCommands().find((c: any) => c.id === id),
  }
}

describe("plugin entry (sidebar spike)", () => {
  const load = () => import("./tui")

  itRender("claims the sidebar.content slot", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    // The spike: the tree lives in the session sidebar, appended after the
    // host's own sidebar plugins, so it renders below the "Context" card.
    expect(slots).toHaveLength(1)
    expect(slots[0].claim.append).toBe("sidebar.content")
  })

  itRender("renders the tree for the sidebar's session", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    const tree = slots[0].claim.render({ sessionID: "ses_1" })
    expect(typeof tree.type).toBe("function")
  })

  itRender("ctrl+e focuses the tree when the focus is elsewhere", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const root = m.rootBox()

    // Focus starts outside the tree; ctrl+e must move it onto the tree, the way
    // a click on a row would.
    m.focusElsewhere()
    m.command("filetree.focus")!.run()

    expect(root.focused).toBe(true)
    expect(m.context.renderer.currentFocusedRenderable).toBe(root)
  })

  itRender("ctrl+e hands the keyboard back when the tree holds focus", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const root = m.rootBox()

    m.focusTree(root)
    m.command("filetree.focus")!.run()

    expect(root.focused).toBe(false)
  })

  itRender("binds ctrl+e to the focus command", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

    const focus = allCommands().find((c: any) => c.id === "filetree.focus")!
    expect(focus).toBeDefined()
    expect(focus.bind).toBe("ctrl+e")
    expect(focus.palette).toBe(true)
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

  itRender("disables the navigation keys while the focus is outside the tree", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    const nav = m.layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.down"),
    )
    expect(nav).toBeDefined()

    // While the prompt or the session list holds the focus, the plugin's
    // bindings must not fire: the sidebar attempt originally died by taking
    // over the host's keyboard.
    m.focusElsewhere()
    expect(nav!.factory().enabled()).toBe(false)
  })

  itRender("enables the navigation keys while the focus is inside the tree", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const root = m.rootBox()

    const nav = m.layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.down"),
    )
    m.focusTree(root)
    expect(nav!.factory().enabled()).toBe(true)
  })

  itRender("one keypress moves the cursor exactly one row", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    // The navigation layer used to be registered from the panel component, so
    // each remount added another copy of every binding and a single keypress ran
    // one handler per copy, walking the cursor several rows at a time.
    const root = m.rootBox()
    for (let i = 0; i < 4; i++) m.renderSidebar()
    m.focusTree(root)
    state.setCursor(0)
    m.command("filetree.down")!.run()

    expect(state.cursor()).toBe(1)
  })

  itRender("renders the sidebar as many times as the host asks without adding layers", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const before = m.layers.length

    // The host calls the slot render again every time the sidebar re-renders,
    // and a session re-renders more than once. Registering keymap layers from it
    // is what leaked a duplicate copy of every binding.
    for (let i = 0; i < 8; i++) m.renderSidebar()

    expect(m.layers.length).toBe(before)
  })

  itRender("moving the cursor never touches the focus", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    const root = m.rootBox()

    // Nothing may steal the focus to show a change: the rows repaint in place.
    m.focusTree(root)
    state.setCursor(0)
    m.command("filetree.down")!.run()
    m.command("filetree.down")!.run()
    await wait(160)

    expect(m.context.renderer.currentFocusedRenderable?.parent).toBe(root)
    expect(state.cursor()).toBe(2)
  })

  itRender("expanding a folder never touches the focus", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    const root = m.rootBox()

    m.focusTree(root)
    state.setCursor(0)
    m.command("filetree.expand")!.run()
    m.command("filetree.expand")!.run()
    m.command("filetree.expand")!.run()
    await wait(160)

    expect(m.context.renderer.currentFocusedRenderable?.parent).toBe(root)
    expect([...state.expanded()]).toEqual(["/proj/f0"])
  })

  itRender("escape returns focus without closing anything", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const root = m.rootBox()

    m.focusTree(root)
    m.command("filetree.close")!.run()

    expect(root.focused).toBe(false)
  })

  itRender("enter on a file spawns the editor without touching the expansion", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
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
    const m = createMockContext()
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
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    // f0 is a folder.
    state.setCursor(0)
    m.command("filetree.open")!.run()
    await wait(120)

    expect([...state.expanded()]).toEqual(["/proj/f0"])
  })

  itRender("s uses the session the sidebar claim carries", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.send")!.run()
    await wait(20)

    expect(m.prompts).toEqual([{ sessionID: "ses_1", text: "Read /proj/f1" }])
  })

  itRender("toasts instead of throwing when the prompt is rejected", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ promptFails: true })
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

  itRender("cleanup unregisters the slot", async () => {
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
