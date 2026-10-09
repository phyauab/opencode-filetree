import { describe, it, expect, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type AnyFn = (...args: any[]) => any

// These checks call setup() but never render a component, so the stubbed JSX
// runtime is enough. They used to be skipped, which is how a duplicate command
// id shipped: a shape error in one layer threw before the next layer was
// registered, and no test was watching for it.
const itRender = it

/** Milliseconds of filesystem quiet before the tree re-reads. */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const created: string[] = []

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})

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

/**
 * A real file with `lines` lines of it.
 *
 * The viewer reads what it is given, so scrolling can only be pinned against a
 * file that exists: a path that does not read has no lines, every step clamps to
 * 0, and "the key did nothing" would pass for a key that does nothing at all.
 */
const realFile = (lines: number): string => {
  const dir = mkdtempSync(join(tmpdir(), "tui-viewer-"))
  const path = join(dir, "f.ts")
  writeFileSync(path, `${Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n")}\n`)
  created.push(dir)
  return path
}

/** Captures what the plugin registers, and lets a test make calls fail. */
function createMockContext(options: { promptFails?: boolean; reRendersOnClose?: boolean } = {}) {
  const slots: { claim: any }[] = []
  const layers: { factory: AnyFn }[] = []
  const pushed: string[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const toasts: { message: string; variant: string }[] = []
  /** Every `panel.open` / `panel.close` in order, which is the whole event log. */
  const panelCalls: { action: "open" | "close"; name?: string }[] = []
  /** What the host would report as this plugin's open panel. */
  let openPanel: { name: string; sessionID: string } | undefined

  /**
   * Calls the `session.panel` claim the way the host does, mid-close.
   *
   * Declared here and invoked from the mock's `close()` further down: a function
   * declaration is hoisted, and `slots` is initialised before any test can get
   * as far as closing a panel.
   */
  function rerenderClaim(name: string) {
    slots
      .find((s) => s.claim.append === "session.panel")
      ?.claim.render({ name, sessionID: "ses_1" })
  }

  /**
   * The renderer's stand-in, built before `context` because its emitter methods
   * have to reach back into the context object they hang off.
   */
  const listeners: Record<string, AnyFn[]> = {}
  const renderer = {
    currentFocusedRenderable: null as any,
    height: 40,
    requestRender: () => {},
    on(event: string, fn: AnyFn) {
      ;(listeners[event] ??= []).push(fn)
    },
    off(event: string, fn: AnyFn) {
      listeners[event] = (listeners[event] ?? []).filter((registered) => registered !== fn)
    },
    /** Fires an event the way the host's emitter would. */
    emit(event: string) {
      for (const fn of [...(listeners[event] ?? [])]) fn()
    },
    /** How many handlers are subscribed to an event. */
    listenerCount(event: string) {
      return (listeners[event] ?? []).length
    },
  }

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
      panel: {
        // Returns a boolean like the real thing: a test can assert that the
        // plugin's own gate follows what the host agreed to, rather than being
        // set unconditionally and pretending to be open.
        open: (name: string) => {
          panelCalls.push({ action: "open", name })
          openPanel = { name, sessionID: "ses_1" }
          return true
        },
        close: () => {
          panelCalls.push({ action: "close" })
          openPanel = undefined
          // The host re-renders the claim as a side effect of closing, and while
          // the panel is between states that render carries whatever name it
          // settles on -- not necessarily ours. Nothing invoked this before, so a
          // re-entrant reconcile during a close could not fire and the plugin
          // could close twice with no test noticing.
          if (options.reRendersOnClose) rerenderClaim("someone-elses-panel")
        },
        current: () => openPanel,
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
    /**
     * The tree's repaint effect asks for a frame on mount, so a full renderer
     * stand-in is needed once the component actually runs rather than just being
     * described.
     *
     * `on`/`off` are a real emitter pair rather than absent, because the plugin
     * subscribes to `resize` to keep the viewer's row count honest. With them
     * missing, both the subscription and its teardown were untested and a typo in
     * the event name would have passed -- the code simply never ran.
     */
    renderer,
  }

  const allCommands = () =>
    layers.flatMap((l) => {
      const layer = l.factory()
      return (layer.commands ?? []).map((c: any) => ({ ...c, mode: layer.mode, layer }))
    })

  /**
   * The layer that binds a given command id, found by that id.
   *
   * Both the nav layer and the viewer layer were being read off `layers[n]`,
   * which is correct only while registration order happens to put them there.
   * The ordering test compares the two layers' priorities, so an index that
   * silently pointed at the wrong layer would make that test assert something
   * other than what it claims -- and the deciding property between two layers
   * binding the same keys is exactly the thing no test should read off an index.
   */
  const layerWith = (id: string) => {
    const found = layers.find((l) => (l.factory().commands ?? []).some((c: any) => c.id === id))
    return found?.factory()
  }

  const viewerLayer = () => layerWith("filetree.viewer.down")

  return {
    context,
    slots,
    layers,
    pushed,
    prompts,
    toasts,
    panelCalls,
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
    /** The navigation layer, the one whose `enabled` decides who owns the keys. */
    navLayer: () => layerWith("filetree.down"),
    /** Is the navigation layer live right now? */
    navEnabled: () => {
      const nav = layerWith("filetree.down")
      return typeof nav?.enabled === "function" ? nav.enabled() : nav?.enabled
    },
    /**
     * The `session.panel` claim. The sidebar claim is registered first, so this
     * is the second one, but it is found by its target path rather than by index
     * -- "the second claim" is a fact about registration order that a future edit
     * could break without any test noticing.
     */
    viewerClaim: () => slots.find((s) => s.claim.append === "session.panel")?.claim,
    /** Renders the panel claim as the host would, with a named panel selected. */
    renderViewer: (name: string) => {
      const claim = slots.find((s) => s.claim.append === "session.panel")?.claim
      return claim?.render({ name, sessionID: "ses_1" }) as any
    },
    viewerLayer,
    /**
     * Mounts the viewer the way the host would and takes over its `scrollTo`.
     *
     * The plugin holds the offset's *writer*, never its value, so a test cannot
     * read the offset back out. It can, though, see what the plugin asks that
     * writer to become: the writer is wrapped so every updater the plugin applies
     * is recorded and then passed through unchanged, which keeps the component's
     * own signal in step while the test watches from the outside. The shadow
     * value is the one the component's signal also holds, so the recorded steps
     * are the real offsets and not a second opinion about them.
     */
    viewerOffsets: () => {
      const element = slots.find((s) => s.claim.append === "session.panel")!.claim.render({
        name: "filetree.viewer",
        sessionID: "ses_1",
      }) as any
      const props = element.props
      const forward = props.scrollTo
      let shadow = 0
      const written: number[] = []
      props.scrollTo = (setScroll: (fn: (prev: number) => number) => void) => {
        forward((fn: (prev: number) => number) => {
          shadow = fn(shadow)
          written.push(shadow)
          return shadow
        })
      }
      element.type(props)
      return { written, offset: () => shadow }
    },
    /** Is the viewer layer live right now? */
    viewerEnabled: () => {
      const viewer = viewerLayer()
      return typeof viewer?.enabled === "function" ? viewer.enabled() : viewer?.enabled
    },
    /**
     * Clicks a row the way the host's hit grid reports it. The click lands on the
     * tree's root box, which is the only renderable in the hit grid -- the same
     * reason the real build handles clicks there.
     */
    clickTreeRow: (y: number) => {
      // The slot render hands back the component and its props, so the tree's
      // root box only exists once the component runs.
      const element = slots[0].claim.render({ sessionID: "ses_1" }) as any
      const box = element.type(element.props)
      const target =
        box.props.onMouseDown
          ? box
          : (box.props.children ?? []).find((c: any) => c?.props?.onMouseDown)
      target.props.onMouseDown({ y })
    },
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
    expect(slots[0].claim.append).toBe("sidebar.content")
  })

  itRender("claims session.panel for the viewer as well as the sidebar", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    // Two claims now. The sidebar still comes first, so every helper that
    // reaches for `slots[0]` is unchanged, and the viewer renders into the
    // surface OpenCode documents as the one for interactive plugin content.
    expect(slots).toHaveLength(2)
    expect(slots.map((s) => s.claim.append)).toEqual(["sidebar.content", "session.panel"])
  })

  itRender("a resize changes how many rows the viewer thinks it has", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.ts", path: realFile(200), isDirectory: false }])
    m.command("filetree.open")!.run()

    // The panel hands the viewer a row count, and the only measurement available
    // is the renderer's height -- re-read on `resize`, or a terminal the user
    // drags taller would keep scrolling by the old half-page for the session.
    const element = m.renderViewer("filetree.viewer")
    // 40 rows less the viewer's two chrome rows.
    expect(element.props.height).toBe(38)

    m.context.renderer.height = 100
    m.context.renderer.emit("resize")

    expect(m.renderViewer("filetree.viewer").props.height).toBe(98)
    // And the page step follows it, rather than staying on the old height.
    const viewer = m.viewerOffsets()
    m.command("filetree.viewer.page.down")!.run()
    expect(viewer.written).toEqual([49])
  })

  itRender("unsubscribes from resize when the plugin deactivates", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    const cleanup = await mod.setup(m.context)

    // The teardown has to be the matching `off`, because an EventEmitter's `on`
    // returns the emitter rather than an unsubscribe. A plugin reloaded in a live
    // TUI would otherwise stack another listener per generation and re-measure
    // the same terminal once per stale plugin.
    expect(m.context.renderer.listenerCount("resize")).toBe(1)

    await cleanup?.()

    expect(m.context.renderer.listenerCount("resize")).toBe(0)
  })

  itRender("renders the viewer only for its own panel name", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    // The panel is a shared slot: another plugin's panel has to render nothing
    // here, or two claims would draw over each other.
    expect(m.renderViewer("someone-elses-panel")).toBeNull()

    state.setCursor(1)
    m.command("filetree.open")!.run()

    const element = m.renderViewer("filetree.viewer")
    expect(element).not.toBeNull()
    expect(element.props.path).toBe("/proj/f1")
  })

  itRender("releases the viewer keys when the host moves the panel off us", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.open")!.run()
    expect(m.viewerEnabled()).toBe(true)

    // Either the host's own close chrome or another plugin taking
    // `session.panel`. Neither goes through our `escape`, and before the claim
    // reconciled itself a priority-20 layer kept swallowing up/down over a
    // panel that was no longer ours -- dead keys with nothing on screen to
    // explain them, which is the exact failure this repo has paid for twice.
    expect(m.renderViewer("someone-elses-panel")).toBeNull()

    expect(m.viewerEnabled()).toBe(false)
    // And the host is told, so the panel really is closed rather than merely
    // forgotten about.
    expect(m.panelCalls[m.panelCalls.length - 1]).toEqual({ action: "close" })
  })

  itRender("closes the panel exactly once per open, even if the close re-renders", async () => {
    const { default: mod } = await load()
    // The mock's close() re-renders the claim with a foreign panel name, the way
    // a host mid-close would. That render hits the reconcile, which used to find
    // `viewerOpen` still true during `openViewer`'s own close and call
    // `closeViewer` -- a second close for one `enter`.
    const m = createMockContext({ reRendersOnClose: true })
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.open")!.run()

    expect(m.panelCalls).toEqual([
      { action: "close" },
      { action: "open", name: "filetree.viewer" },
    ])
    // The viewer still ends up open, because the flag is set from what the host
    // agreed to rather than left as the reconcile found it.
    expect(m.viewerEnabled()).toBe(true)
    expect(m.renderViewer("filetree.viewer")).not.toBeNull()
  })

  itRender("a second enter closes once each time, not twice", async () => {
    const { default: mod } = await load()
    const m = createMockContext({ reRendersOnClose: true })
    await mod.setup(m.context)
    const state = m.panelState()

    // The worst case for a double close: the panel is already ours when the
    // second `enter` closes it, so the flag is true for the whole of that close.
    state.setCursor(1)
    m.command("filetree.open")!.run()
    state.setCursor(2)
    m.command("filetree.open")!.run()

    expect(m.panelCalls.filter((p) => p.action === "close")).toHaveLength(2)
    expect(m.panelCalls.filter((p) => p.action === "open")).toHaveLength(2)
    expect(m.viewerEnabled()).toBe(true)
    expect(m.renderViewer("filetree.viewer").props.path).toBe("/proj/f2")
  })

  itRender("keeps the viewer keys when its own panel re-renders", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.open")!.run()
    const closesBefore = m.panelCalls.filter((p) => p.action === "close").length

    // The host re-renders a claim it already owns -- on a resize, say. That must
    // not read as "the panel went away", or the arrows would die under a
    // perfectly visible file.
    m.renderViewer("filetree.viewer")

    expect(m.viewerEnabled()).toBe(true)
    expect(m.panelCalls.filter((p) => p.action === "close")).toHaveLength(closesBefore)
  })

  itRender("does not re-close the panel on every render after losing it", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.open")!.run()
    m.renderViewer("someone-elses-panel")
    const closesAfterReconcile = m.panelCalls.filter((p) => p.action === "close").length

    // Reconciling calls `closeViewer`, which calls `panel.close()`. If the guard
    // were not there, the host re-rendering the claim with a foreign name would
    // send another close on every frame, for a panel it already let go of.
    for (let i = 0; i < 5; i++) m.renderViewer("someone-elses-panel")

    expect(m.panelCalls.filter((p) => p.action === "close")).toHaveLength(closesAfterReconcile)
    expect(m.viewerEnabled()).toBe(false)
  })

  itRender("renders the tree for the sidebar's session", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    const tree = slots[0].claim.render({ sessionID: "ses_1" })
    expect(typeof tree.type).toBe("function")
  })

  itRender("ctrl+y focuses the tree when the focus is elsewhere", async () => {
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

  itRender("ctrl+y is a no-op when the tree already holds the keyboard", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const root = m.rootBox()

    // A toggle made this key look broken: the first press focused, the second
    // blurred, and whether the second press blurred or focused again depended on
    // whether the host had handed focus back in between. Same key, two opposite
    // results. ctrl+y now only ever means "the tree has the keyboard".
    m.focusTree(root)
    m.command("filetree.focus")!.run()

    expect(root.focused).toBe(true)
  })

  itRender("esc hands the keyboard back", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const root = m.rootBox()

    m.command("filetree.focus")!.run()
    expect(m.navEnabled()).toBe(true)

    m.command("filetree.close")!.run()

    expect(m.navEnabled()).toBe(false)
    expect(root.focused).toBe(false)
  })

  itRender("keys stay with the tree even when the host takes focus back", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const root = m.rootBox()

    // The host reclaims focus about a second later -- traced, three sessions
    // running. Gating the nav layer on focus made the keys flap with it, which
    // is the "works sometimes" report.
    m.command("filetree.focus")!.run()
    m.focusElsewhere()

    expect(root.focused).toBe(true) // focus really was lost
    expect(m.navEnabled()).toBe(true) // but the tree still owns the keys
  })

  itRender("clicking a row claims the keys", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    m.rootBox()

    expect(m.navEnabled()).toBe(false)
    m.clickTreeRow(1)
    expect(m.navEnabled()).toBe(true)
  })

  itRender("outranks the host layer that binds down for session navigation", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    // The host registers `enabled: () => currentFocusedEditor === null`, and our
    // box is not an editor, so that layer switches on when the tree takes focus.
    // It binds down/up for session and subagent navigation. Layers resolve by
    // priority descending, so without an explicit priority we lose those keys --
    // which is what "press down and the subagent panel opens" was.
    const nav = m.navLayer()
    expect(nav.enabled?.()).toBe(false)
    expect(nav.priority).toBeGreaterThan(0)
  })

  itRender("binds ctrl+y to the focus command", async () => {
    const { default: mod } = await load()
    const { context, allCommands } = createMockContext()
    await mod.setup(context)

    const focus = allCommands().find((c: any) => c.id === "filetree.focus")!
    expect(focus).toBeDefined()
    // ctrl+e is `input.line.end` in the host's defaults, so the prompt editor
    // swallows it; ctrl+y appears nowhere in the host's keybind map.
    expect(focus.bind).toBe("ctrl+y")
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

  itRender("holds the navigation keys off until the tree claims them", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    const nav = m.layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.down"),
    )
    expect(nav).toBeDefined()

    // The sidebar attempt originally died by taking over the host's keyboard, so
    // the bindings must stay dormant until something asks for them. Starting a
    // session with the tree rendered must not mean the tree owns the keyboard.
    expect(nav!.factory().enabled()).toBe(false)
  })

  itRender("enables the navigation keys once the tree has claimed them", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    m.rootBox()

    const nav = m.layers.find((l) =>
      (l.factory().commands ?? []).some((c: any) => c.id === "filetree.down"),
    )
    // Focus alone is not the gate any more: the host takes it back, and reading
    // it made the keys flap. Claiming is explicit.
    m.command("filetree.focus")!.run()
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

  itRender("enter on a file opens the viewer panel and nothing else", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    // f1 is a file. The whole interaction is the panel claim: no child process,
    // no `$EDITOR` lookup, and no promise for the keypress to await. The
    // `$EDITOR` environment this test used to set and restore belonged to the
    // spawn path that was deleted, and setting it asserted nothing.
    state.setCursor(1)
    m.command("filetree.open")!.run()
    await wait(50)

    expect(m.panelCalls).toEqual([
      { action: "close" },
      { action: "open", name: "filetree.viewer" },
    ])
    expect(m.viewerEnabled()).toBe(true)
    // A file is not a folder, so the expansion is untouched by all this.
    expect([...state.expanded()]).toEqual([])
    expect(m.toasts).toEqual([])
  })

  itRender("enter expands a folder instead of opening the viewer", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    // f0 is a folder. The viewer refuses to read one and would show that refusal
    // where the reader expected the tree to move.
    state.setCursor(0)
    m.command("filetree.open")!.run()
    await wait(120)

    expect([...state.expanded()]).toEqual(["/proj/f0"])
    expect(m.panelCalls).toEqual([])
    expect(m.viewerEnabled()).toBe(false)
  })

  itRender("a second enter on another file shows the new file", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    // The reader reads its file in the component body and Solid never re-runs a
    // body, so a panel left open across a second `enter` would keep showing the
    // first file. Closing the panel before reopening it is what guarantees a
    // fresh mount, and this is the assertion that the path actually moves.
    state.setCursor(1)
    m.command("filetree.open")!.run()
    expect(m.renderViewer("filetree.viewer").props.path).toBe("/proj/f1")

    state.setCursor(2)
    m.command("filetree.open")!.run()

    expect(m.renderViewer("filetree.viewer").props.path).toBe("/proj/f2")
    // Two opens, each preceded by a close: that is the remount.
    expect(m.panelCalls).toEqual([
      { action: "close" },
      { action: "open", name: "filetree.viewer" },
      { action: "close" },
      { action: "open", name: "filetree.viewer" },
    ])
  })

  itRender("esc closes the viewer panel and stops its keys", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.open")!.run()
    expect(m.viewerEnabled()).toBe(true)

    m.command("filetree.viewer.close")!.run()

    expect(m.panelCalls[m.panelCalls.length - 1]).toEqual({ action: "close" })
    expect(m.viewerEnabled()).toBe(false)
  })

  itRender("esc closes the panel once, even if the close re-renders", async () => {
    const { default: mod } = await load()
    // The same hazard as `openViewer`, from the other direction: if `closeViewer`
    // cleared its flag *after* calling close, the re-render that close triggers
    // would find the flag still true and reconcile into a second close. Pressing
    // esc must not be a way to stack closes.
    const m = createMockContext({ reRendersOnClose: true })
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.open")!.run()
    const closesBefore = m.panelCalls.filter((p) => p.action === "close").length

    m.command("filetree.viewer.close")!.run()

    expect(m.panelCalls.filter((p) => p.action === "close")).toHaveLength(closesBefore + 1)
    expect(m.viewerEnabled()).toBe(false)
  })

  itRender("holds the viewer keys off until a file is opened", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    // The viewer layer binds up/down, which the session list and the tree both
    // want. It must never be live just because the plugin loaded.
    expect(m.viewerLayer()).toBeDefined()
    expect(m.viewerEnabled()).toBe(false)
  })

  itRender("the viewer layer outranks the tree's nav layer, which binds the same keys", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    // Both layers bind up/down. Layers resolve by `priority` descending and then
    // by registration order, so an equal priority would leave the winner
    // depending on where this layer happens to be registered -- invisible at the
    // call site, and exactly the kind of thing a future edit silently breaks.
    // The host's own layer, gated on `currentFocusedEditor === null`, binds the
    // same keys too and is beaten by any positive priority.
    const viewer = m.viewerLayer()
    const nav = m.navLayer()

    expect(viewer.priority).toBeGreaterThan(0)
    expect(viewer.priority).toBeGreaterThan(nav.priority)
    expect(viewer.commands.map((c: any) => c.bind)).toEqual([
      "down",
      "up",
      "pagedown",
      "pageup",
      "escape",
    ])
  })

  itRender("the viewer layer's gate is plugin state, not renderer focus", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    state.setCursor(1)
    m.command("filetree.open")!.run()

    // The host re-asserts focus on the prompt about a second after anything takes
    // it, which is what made every focus-derived gate flap. The layer has to stay
    // live through that, and has to stay dead once the panel is closed.
    m.focusElsewhere()
    expect(m.viewerEnabled()).toBe(true)

    m.command("filetree.viewer.close")!.run()
    m.focusTree(m.rootBox())
    expect(m.viewerEnabled()).toBe(false)
  })

  itRender("up and down move the viewer's window and nothing else", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    // A file long enough to actually scroll through, and the tree's own cursor
    // parked on it so nothing here can be the tree moving.
    const state = m.panelState()
    state.setEntries([{ name: "f.ts", path: realFile(200), isDirectory: false }])
    state.setCursor(0)
    m.command("filetree.open")!.run()

    // The plugin holds the viewer's writer, not its value, so what the plugin's
    // side can be held to is exactly what it asks the offset to become.
    const viewer = m.viewerOffsets()

    m.command("filetree.viewer.down")!.run()
    m.command("filetree.viewer.down")!.run()
    const written = viewer.written

    // The panel is 40 rows less the viewer's two chrome rows, so 38 rows of a
    // 200-line file scroll as far as 162 -- two lines is nowhere near the end,
    // and each press moves exactly one.
    expect(written).toEqual([1, 2])
    expect(viewer.offset()).toBe(2)
    expect(state.cursor()).toBe(0)
    expect([...state.expanded()]).toEqual([])
    expect(m.prompts).toEqual([])
    expect(m.panelCalls.filter((p) => p.action === "open")).toHaveLength(1)
  })

  itRender("down past the last line stays on the last line", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.ts", path: realFile(3), isDirectory: false }])
    m.command("filetree.open")!.run()

    const viewer = m.viewerOffsets()
    m.command("filetree.viewer.down")!.run()
    m.command("filetree.viewer.down")!.run()

    // The last mutation gap this round found closed: three lines in a 38-row
    // panel, so there is nothing below the first line and `down` has to clamp to
    // 0 like `pagedown` does. Every earlier `down` assertion used a file long
    // enough to scroll, where the clamp is unreachable and `prev + 1` and
    // `scrollByLine` are indistinguishable -- which is exactly why the mutation
    // that swapped one for the other slipped through the original report's
    // claim that the clamp was pinned.
    expect(viewer.written).toEqual([0, 0])
  })

  itRender("up from the first line stays on the first line", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.ts", path: realFile(200), isDirectory: false }])
    m.command("filetree.open")!.run()

    const viewer = m.viewerOffsets()
    m.command("filetree.viewer.up")!.run()
    m.command("filetree.viewer.up")!.run()

    // The clamp is the viewer's own, but asking for a negative offset must not
    // be able to reach it -- a window at -1 renders nothing at all.
    expect(viewer.written).toEqual([0, 0])
  })

  itRender("pageup and pagedown move the viewer's window and nothing else", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.ts", path: realFile(200), isDirectory: false }])
    m.command("filetree.open")!.run()

    const viewer = m.viewerOffsets()

    m.command("filetree.viewer.page.down")!.run()
    m.command("filetree.viewer.page.up")!.run()
    const written = viewer.written

    // Half of 38 rows is 19, and pageup walks it all the way back, so a page
    // step is visible rather than lost in the clamp.
    expect(written).toEqual([19, 0])
    expect(state.cursor()).toBe(0)
    expect(m.prompts).toEqual([])
  })

  itRender("paging a file that fits cannot scroll it at all", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.ts", path: realFile(3), isDirectory: false }])
    m.command("filetree.open")!.run()

    const viewer = m.viewerOffsets()
    m.command("filetree.viewer.page.down")!.run()
    m.command("filetree.viewer.page.down")!.run()

    // Three lines in a 38-row panel: there is nothing below the first line, and
    // the header saying "1-3 of 3" has to stay true.
    expect(viewer.written).toEqual([0, 0])
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
