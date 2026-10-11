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

/**
 * A real markdown file with `lines` lines of it.
 *
 * Separate from `realFile` because the extension is the whole test: it is what
 * routes the file down the preview path, and a `.ts` file with the same contents
 * would take the Prism path and prove nothing about the sentinel.
 */
const realMarkdown = (lines: number): string => {
  const dir = mkdtempSync(join(tmpdir(), "tui-viewer-"))
  const path = join(dir, "f.md")
  writeFileSync(path, `${Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n")}\n`)
  created.push(dir)
  return path
}

/**
 * A real markdown file whose exact contents are the point.
 *
 * Separate from `realMarkdown` because the heading-jump tests need a document
 * with a known shape -- headings with a single-word paragraph between them, so
 * each heading is on a row that can be written down. `realMarkdown(lines)` is
 * for "a markdown file the sentinel has to let scroll" and has no headings in
 * it at all.
 */
const realMarkdownSource = (source: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "tui-viewer-"))
  const path = join(dir, "f.md")
  writeFileSync(path, source)
  created.push(dir)
  return path
}

/**
 * Three headings, one row of text between each, at the viewer's default width.
 *
 * `# One` on row 0, `## Two` on row 4, `### Three` on row 8: heading, blank,
 * paragraph, blank, then the next heading. Written out because every test below
 * asserts on these numbers and a reader has to be able to check the arithmetic
 * by eye. Verified against `layoutBlocks` at 150 columns; the layout's own
 * arithmetic is pinned in `markdownLayout.test.ts` and `toc.test.ts`, and what
 * is under test here is what the keymap *does* with the row.
 */
const HEADINGS = "# One\n\npara\n\n## Two\n\npara\n\n### Three\n\npara\n"
const HEADING_ROWS: [number, number][] = [
  [0, 0],
  [1, 4],
  [2, 8],
]

/**
 * Every object in a stub `children` prop, however deeply nested.
 *
 * The same walk `FileViewer.test.ts`'s `elements` does, restated because a test
 * file cannot import another one. The stub's JSX runtime records a plain
 * description of the tree, so the rendered scrollbox is reachable by walking
 * `children` and not only by rendering.
 */
function childElements(children: unknown): any[] {
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  return list.filter((child): child is any => Boolean(child) && typeof child === "object")
}

/**
 * The first element anywhere in a stub tree that matches, however deep it is.
 *
 * A flat walk over one `children` array is not enough since the viewer grew a
 * centring box and a content column: on the markdown path what a test needs is
 * three levels down, inside `<box row>` -> `<box column>` -> `<scrollbox>`. The
 * shallow search returns `undefined` for a tree that plainly contains what it
 * was looking for, which is how `scrollbox()` below came to report `undefined`
 * on the markdown path while the file it describes was being drawn.
 *
 * Breadth-first, so the outermost match wins. There is one scrollbox in the
 * tree and one content component in it, but a search that found the deeper of
 * two would be a search whose answer depends on a nesting depth nobody
 * declared.
 */
function deepFind(children: unknown, match: (element: any) => boolean): any {
  const level = childElements(children)
  for (const element of level) {
    if (match(element)) return element
  }
  for (const element of level) {
    const found = deepFind(element.props?.children, match)
    if (found) return found
  }
  return undefined
}

/**
 * A stand-in for the ScrollBoxRenderable, faithful to the host's arithmetic.
 *
 * The shape of `FileViewer.test.ts`'s `fakeScrollBox`, restated for the same
 * reason: a test file cannot import another one. `scrollTo` transcribes
 * `ScrollBarRenderable`'s `scrollPosition` setter --
 * `Math.round(Math.min(Math.max(0, value), scrollSize - viewportSize))` -- rather
 * than storing the number it was given, so the clamp under test is the host's
 * and not a number this file asserts.
 *
 * It carries only `scrollTop`, `scrollSize`, `viewportSize` and `scrollTo`, and
 * that restriction is the point. An earlier fake also declared a `maxScrollTop`
 * property, which the real renderable does not have, and every test passed while
 * the adapter clamped against `undefined`. A stub that invents the member the
 * code is wrong about cannot catch the code being wrong about it.
 */
function fakeScrollBox(scrollTop: number, scrollSize: number, viewportSize: number, asked: number[]) {
  return {
    scrollTop,
    scrollSize,
    viewportSize,
    scrollTo(n: number) {
      asked.push(n)
      this.scrollTop = Math.round(Math.min(Math.max(0, n), this.scrollSize - this.viewportSize))
    },
  }
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
  /** What the host's input dialog was asked, and what a test answers it with. */
  const dialogs: { title: string; description: string; value: string }[] = []
  const dialogAnswers: (string | undefined)[] = []
  /** Every `storage.store` key and its live value, so writes are observable. */
  const stores = new Map<string, Record<string, unknown>>()
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
      /**
       * The input dialog `filetree.set-width` opens.
       *
       * It was absent, and `never pushes an input mode` runs every registered
       * command -- so a command that consulted the host's dialog threw a
       * TypeError out of a command that was otherwise correct, and the suite
       * failed for a reason that had nothing to do with what it was watching.
       *
       * Answers are queued so a test can say what the reader typed, and an
       * empty queue resolves to `undefined`, which is the host's own "cancelled"
       * answer and is what the plugin already treats as "do nothing".
       */
      dialog: {
        prompt: (options: { title: string; description: string; value: string }) => {
          dialogs.push(options)
          return Promise.resolve(dialogAnswers.length > 0 ? dialogAnswers.shift() : undefined)
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
    storage: {
      /**
       * A live store, because the write is the observable.
       *
       * The viewer-width command persists the reader's choice, and a store whose
       * setter was a no-op made that path untestable: the command could have
       * stopped writing anything at all and no test would have noticed. The
       * setter is handed a draft the way the host hands one, and the result is
       * readable by key.
       */
      store: (key: string, options: { initial: unknown } = { initial: {} }) => {
        const state: Record<string, unknown> = { ...(options.initial as Record<string, unknown>) }
        stores.set(key, state)
        const set = (updater: (draft: Record<string, unknown>) => void) => {
          const draft = { ...state }
          updater(draft)
          Object.assign(state, draft)
          return Promise.resolve()
        }
        return [state, set]
      },
      memory: () => [{}, () => {}],
    },
    data: { on: () => () => {}, listen: () => {} },
    theme: { markdown: { heading: "#e06c75" } },
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
    dialogs,
    panelCalls,
    allCommands,
    /** The live value a `storage.store` key was initialised with, plus anything written since. */
    stored: (key: string) => stores.get(key),
    /** What the reader types into the next input dialog. */
    answerDialog: (value: string) => dialogAnswers.push(value),
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
     *
     * KEEPING the writer the component hands over is the load-bearing half of
     * that, and it is worth recording what dropping it cost. The first version
     * threw the writer away and registered its own updater in its place, so
     * `setViewerScroll` held a value the component's state never moved. On the
     * Prism path that is invisible -- the shadow and the signal agree because
     * the step is the same arithmetic -- and on the markdown path it is the
     * whole feature: the adapter, the captured box and the clamp were never
     * invoked by anything at this level, so "a keypress reaches the scrollbox"
     * was implied and never executed. That is the same gap shape the
     * `maxScrollTop` critical shipped through, where a fake declared a property
     * the renderable lacks and no test crossed from the plugin side into it.
     *
     * So the writer is kept, and what the plugin ends up holding is a
     * pass-through to it rather than a substitute for it. The recording below
     * still watches what the plugin asks for; the difference is that asking
     * now reaches the component, and through it the renderable.
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
      /** The writer the component handed to `props.scrollTo`, kept not replaced. */
      let held: ((value: number | ((prev: number) => number)) => number) | undefined
      props.scrollTo = (setScroll: (value: number | ((prev: number) => number)) => number) => {
        held = setScroll
        forward((value: number | ((prev: number) => number)) => {
          const updater = typeof value === "function" ? value : () => value
          shadow = updater(shadow)
          written.push(shadow)
          // The component's own writer, driven with the updater the plugin
          // produced. This is the line that makes the chain run end to end
          // rather than stopping at the recording.
          return held!(value)
        })
      }
      // The claim's render hands back the component's own element description;
      // calling it is what runs the body, and its result is the root box whose
      // `children` are `[header, scrollbox]` on the markdown path.
      const root = element.type(props)
      return {
        written,
        offset: () => shadow,
        writer: () => held,
        /**
         * The rendered scrollbox, so a test can hand it a fake box the way the
         * reconciler hands a ref. `undefined` on the text path, which has no
         * scrollbox to hand anything to.
         */
        scrollbox: () => deepFind(root?.props?.children, (child: any) => child.type === "scrollbox"),
        /**
         * The rendered markdown layout component, so a test can hand over
         * heading positions the way the layout does.
         *
         * The stub builds the tree as a description and never runs the
         * component, so `onHeadingPositions` does not fire by itself: the
         * viewer's own signal stays on its seeded empty map until a test calls
         * this. That is the same reason `FileViewer.test.ts` has a
         * `renderContentView`, restated here because a test file cannot import
         * another one.
         */
        markdownContent: () =>
          deepFind(
            root?.props?.children,
            (child: any) => typeof child.props?.onHeadingPositions === "function",
          ),
      }
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
      "alt+down",
      "alt+up",
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

  itRender("keeps scrolling a markdown file past its line count", async () => {
    // Markdown renders as blocks, so its rendered height is not its line count.
    // Handing the keymap the file's line count would clamp `down` at maxScroll(3, rows)
    // on a three-line markdown file that renders thirty rows, and the reader could
    // never reach the bottom. The sentinel defers the clamp to the scrollbox.
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.md", path: realMarkdown(3), isDirectory: false }])
    state.setCursor(0)
    m.command("filetree.open")!.run()

    const { written } = m.viewerOffsets()
    const down = m.command("filetree.viewer.down")
    for (let i = 0; i < 10; i++) down?.run?.()
    expect(written[written.length - 1]).toBe(10)
  })

  itRender("a keypress on a markdown file moves the scrollbox the renderer holds", async () => {
    /*
     * The seam, run end to end.
     *
     * Both halves of this were already covered and neither covered the join.
     * The component's own writer drives the captured box and the box's scrollbar
     * does the clamping (`FileViewer.test.ts`); the plugin asks the writer to
     * move and records what it asked (`viewerOffsets` above). What nothing ran
     * was the composition -- until this round the helper handed the plugin a
     * *substitute* writer, so the adapter, the box and the clamp were never
     * invoked from the plugin side at all. That is the same gap shape the
     * `maxScrollTop` critical shipped through: a fake declared a property the
     * renderable lacks and no test ever crossed from the plugin into it.
     *
     * So the real `filetree.viewer.down` command is what drives this, and that is
     * the direction worth pinning. It is strictly stronger than calling
     * `writer()` directly, because it executes keypress -> the writer the plugin
     * holds -> the component's own adapter -> the renderable; the direct drive
     * would only re-run the middle of that chain, which the component's suite
     * already pins and which `writer()` remains available for.
     */
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.md", path: realMarkdown(3), isDirectory: false }])
    state.setCursor(0)
    m.command("filetree.open")!.run()

    const viewer = m.viewerOffsets()
    // Forty rows of content in a ten-row viewport, so the scrollbar's clamp is
    // nowhere near this answer and the assertion is about the step, not the bound.
    const asked: number[] = []
    const box = fakeScrollBox(0, 40, 10, asked)
    viewer.scrollbox()!.props.ref(box)

    m.command("filetree.viewer.down")!.run()

    // The box was asked for the next row and left there, which means the writer
    // the plugin holds really is the one the component handed over: only that
    // writer reads `scrollTop` off the renderable.
    expect(asked).toEqual([1])
    expect(box.scrollTop).toBe(1)
    // The recorded offset and the box's own position are the same number here,
    // the one case in this suite where the two can be compared at all.
    expect(viewer.written).toEqual([1])
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

  itRender("asks the host for a viewer width and persists what it is given", async () => {
    // The `filetree.set-width` command's whole body, which nothing else in this
    // file covered: it was registered, and the mock had no `ui.dialog` at all,
    // so the command threw before it did anything and `never pushes an input
    // mode` failed on it.
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)
    m.answerDialog("80")
    m.command("filetree.set-width")!.run()
    await wait(20)

    // Asked with the current width as the starting value, so the reader edits
    // what is already set rather than being shown a placeholder.
    expect(m.dialogs).toHaveLength(1)
    expect(m.dialogs[0].value).toBe("150")
    // And the answer really was written where the startup path reads it back
    // from, so a restart keeps it.
    expect(m.stored("filetree-viewer-width")).toEqual({ width: 80 })
  })

  itRender("toasts instead of persisting a width that is not a number", async () => {
    // `Number("abc")` is NaN, and `Number("0")` is a number that is no width at
    // all -- persisting either would leave the viewer unbounded or negative on
    // the next open, and the guard has to reject both.
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    m.answerDialog("abc")
    m.command("filetree.set-width")!.run()
    await wait(20)
    expect(m.toasts).toEqual([{ message: "Width must be a positive number", variant: "error" }])

    m.answerDialog("0")
    m.command("filetree.set-width")!.run()
    await wait(20)
    expect(m.toasts).toHaveLength(2)
    expect(m.stored("filetree-viewer-width")).toEqual({ width: 0 })
  })

  itRender("does nothing when the width dialog is cancelled", async () => {
    const { default: mod } = await load()
    const m = createMockContext()
    await mod.setup(m.context)

    // No answer queued, which is the host's `undefined`.
    m.command("filetree.set-width")!.run()
    await wait(20)

    expect(m.toasts).toEqual([])
    expect(m.stored("filetree-viewer-width")).toEqual({ width: 0 })
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

/*
 * `alt+down` / `alt+up` on the viewer layer.
 *
 * The feature in one sentence: the keymap asks the layout where a heading is,
 * and hands that row to the scroll writer the viewer already gave it --
 * unchanged. Every test below is a way of nailing down "unchanged", or "only
 * when it should".
 *
 * Two things are load-bearing and both are pinned hard, because both are the
 * bug class this whole seam exists to prevent:
 *
 *   - The row is not adjusted on the way through. It is 0-based and it is the
 *     row the heading's own text is drawn on, so any "looks nicer" correction
 *     here is the off-by-N the first table of contents shipped. `asked` records
 *     the raw number handed to the writer, so an adjustment fails a test rather
 *     than reading as an improvement.
 *   - The positions are read at the moment of the keypress, because the layout
 *     replaces its map every time it recomputes.
 */
describe("jumping between sections in the markdown viewer", () => {
  /**
   * A markdown file open in the viewer, with headings laid out.
   *
   * Returns everything a jump can be observed doing from the outside: the mock
   * context, the raw numbers handed to the scroll writer, and the fake scrollbox
   * they landed on. The fake transcribes the host's own clamp (see
   * `fakeScrollBox`), so the bound under test in the overshoot case is the bound
   * the plugin really meets rather than one this file asserts.
   *
   * The positions go in through `MarkdownContentView`'s `onHeadingPositions`,
   * which is the only writer the viewer's signal has. Routing around it would
   * test a path production never takes, and the stub never invokes the
   * component itself -- which is the same reason `FileViewer.test.ts` has a
   * `renderContentView`, restated here because a test file cannot import
   * another one.
   */
  async function headingFixture(
    positions: [number, number][],
    source = HEADINGS,
    box: { scrollTop?: number; scrollSize?: number; viewportSize?: number } = {},
  ) {
    const { default: mod } = await import("./tui")
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.md", path: realMarkdownSource(source), isDirectory: false }])
    state.setCursor(0)
    m.command("filetree.open")!.run()

    const viewer = m.viewerOffsets()
    const asked: number[] = []
    const scrollbox = fakeScrollBox(
      box.scrollTop ?? 0,
      box.scrollSize ?? 400,
      box.viewportSize ?? 38,
      asked,
    )
    viewer.scrollbox()!.props.ref(scrollbox)
    viewer.markdownContent()!.props.onHeadingPositions(new Map(positions))

    return { m, state, viewer, asked, scrollbox }
  }

  itRender("binds alt+down and alt+up to jump between sections, on the viewer layer", async () => {
    const { default: mod } = await import("./tui")
    const m = createMockContext()
    await mod.setup(m.context)

    const viewer = m.viewerLayer()
    const next = viewer.commands.find((c: any) => c.id === "filetree.viewer.heading.next")
    const previous = viewer.commands.find((c: any) => c.id === "filetree.viewer.heading.prev")

    expect(next?.bind).toBe("alt+down")
    expect(previous?.bind).toBe("alt+up")
    // On the viewer layer, whose `enabled` is `viewerOpen()` -- plugin state, not
    // renderer focus, because the host re-asserts focus on the prompt about a
    // second after anything takes it and a focus gate would flap.
    expect(viewer.priority).toBe(20)
    expect(m.viewerEnabled()).toBe(false)
    expect(viewer.bindings).toContain("filetree.viewer.heading.next")
    expect(viewer.bindings).toContain("filetree.viewer.heading.prev")
  })

  itRender("alt+down scrolls to the next heading's row and nothing else", async () => {
    const { m, state, viewer, asked, scrollbox } = await headingFixture(HEADING_ROWS)

    m.command("filetree.viewer.heading.next")!.run()

    // `## Two` is on row 4. Asked for as it stands: not 3, which would land
    // above the heading, and not 5, which would land on the blank row under
    // the paragraph that follows it.
    expect(asked).toEqual([4])
    expect(scrollbox.scrollTop).toBe(4)
    expect(viewer.written).toEqual([4])

    // And again from row 4, which is `## Two`'s own row: `### Three` is on 8.
    m.command("filetree.viewer.heading.next")!.run()
    expect(asked).toEqual([4, 8])

    // The jump is the viewer moving. The tree's cursor, its expansion, the
    // session and the panel itself are all untouched.
    expect(state.cursor()).toBe(0)
    expect([...state.expanded()]).toEqual([])
    expect(m.prompts).toEqual([])
    expect(m.panelCalls.filter((p) => p.action === "open")).toHaveLength(1)
  })

  itRender("alt+up scrolls to the previous heading's row", async () => {
    const { m, asked, scrollbox } = await headingFixture(HEADING_ROWS)

    m.command("filetree.viewer.heading.next")!.run()
    m.command("filetree.viewer.heading.next")!.run()
    expect(asked).toEqual([4, 8])
    expect(scrollbox.scrollTop).toBe(8)

    m.command("filetree.viewer.heading.prev")!.run()
    expect(asked).toEqual([4, 8, 4])

    m.command("filetree.viewer.heading.prev")!.run()
    expect(asked).toEqual([4, 8, 4, 0])
  })

  itRender("a jump with nowhere to go moves nothing at all", async () => {
    const { m, viewer, asked } = await headingFixture(HEADING_ROWS)

    // At the top of the document there is no previous heading. `null` from the
    // finder is a real answer -- it is what tells the keymap the key has nothing
    // to do -- and the scrollbox is left exactly where it was.
    m.command("filetree.viewer.heading.prev")!.run()
    expect(asked).toEqual([])
    expect(viewer.written).toEqual([])

    // Down to the last heading, then one more press.
    m.command("filetree.viewer.heading.next")!.run()
    m.command("filetree.viewer.heading.next")!.run()
    expect(asked).toEqual([4, 8])

    m.command("filetree.viewer.heading.next")!.run()

    // Nothing asked, nothing written, nothing thrown. No state changed, so
    // nothing asked the renderer for a frame either -- a keypress at the end of
    // the document that moved a row would be a lie about where the reader is.
    expect(asked).toEqual([4, 8])
    expect(viewer.written).toEqual([4, 8])
  })

  itRender("asks for the row it was given even when the scrollbar clamps it", async () => {
    // A document whose heading sits below the scrollable range, which is what a
    // heading near the end of a long file is. The row goes over unmodified and
    // the renderable's own clamp decides what is legal, so the ask is the
    // layout's number and the landing is the host's.
    const { m, asked, scrollbox } = await headingFixture(
      [
        [0, 0],
        [1, 400],
      ],
      HEADINGS,
      { scrollSize: 400, viewportSize: 38 },
    )

    m.command("filetree.viewer.heading.next")!.run()

    // 400, not 399: an off-by-one would still land somewhere legal here, and
    // that is exactly why the ask itself is what gets asserted.
    expect(asked).toEqual([400])
    // The host's clamp, not ours: `scrollSize - viewportSize`, 400 - 38.
    expect(scrollbox.scrollTop).toBe(362)
  })

  itRender("reads the layout when the key is pressed, not when the panel opened", async () => {
    // 150 columns puts `## Two` on row 4; a narrower wrap puts it lower. A
    // snapshot taken when the panel opened would still say 4 and land four rows
    // above the heading it names.
    const source = "# One\n\naaa bbb ccc ddd eee fff ggg hhh iii jjj\n\n## Two\n\nmore\n"
    const { m, asked, viewer } = await headingFixture(
      [
        [0, 0],
        [1, 4],
      ],
      source,
    )

    m.command("filetree.viewer.heading.next")!.run()
    expect(asked).toEqual([4])

    // The resize: the layout recomputes and hands over a fresh map.
    viewer.markdownContent()!.props.onHeadingPositions(
      new Map([
        [0, 0],
        [1, 9],
      ]),
    )
    m.command("filetree.viewer.heading.next")!.run()
    expect(asked).toEqual([4, 9])
  })

  itRender("a heading state of -1 jumps to the first heading instead of nowhere", async () => {
    /*
     * `findActiveHeading` answers -1 for "no heading is active", and -1 is not
     * a key in the positions map. It is only ever *handed to* the finders, which
     * answer with the closest index that is in the map -- so the keymap jumps to
     * the top of the document rather than doing nothing or, worse, looking up
     * `positions.get(-1)` and landing wherever `undefined` puts it.
     *
     * The reachable route to -1 is an offset of NaN. `markdownOffset` reads
     * `scrollTop` and hands NaN through rather than guessing, and
     * `findActiveHeading` treats NaN as "no position at all" rather than as an
     * offset above every heading -- which would have named the *last* heading of
     * a document the reader is looking at the top of. The box is put into that
     * state directly because no keypress reaches it; this repo has already
     * shipped one panel whose scroll position was NaN.
     */
    const { m, asked, scrollbox, viewer } = await headingFixture(HEADING_ROWS)
    scrollbox.scrollTop = Number.NaN

    m.command("filetree.viewer.heading.next")!.run()

    // Heading 0, on row 0. `positions.get(-1)` would have been `undefined`, and
    // a keypress that landed on `undefined` would have moved the reader
    // somewhere arbitrary -- which is the failure this pins.
    expect(asked).toEqual([0])
    expect(scrollbox.scrollTop).toBe(0)

    // And the mirror: above the first heading there is no previous one.
    m.command("filetree.viewer.heading.prev")!.run()
    expect(asked).toEqual([0])
    expect(viewer.written).toEqual([0])
  })

  itRender("a jump over a code file does nothing at all", async () => {
    const { default: mod } = await import("./tui")
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()
    state.setEntries([{ name: "f.ts", path: realFile(200), isDirectory: false }])
    state.setCursor(0)
    m.command("filetree.open")!.run()

    const viewer = m.viewerOffsets()

    // The writer IS set on this path -- the arrows scroll a code file fine --
    // so what is being tested is the heading gate and not the absence of a
    // writer. `FileViewer` calls `onHeadings` on the markdown path only, so
    // there is no state to navigate with.
    expect(viewer.writer()).toBeDefined()

    m.command("filetree.viewer.heading.next")!.run()
    m.command("filetree.viewer.heading.prev")!.run()

    expect(viewer.written).toEqual([])
  })

  itRender("opening a code file after a markdown one leaves the markdown gate shut", async () => {
    /*
     * The `viewerHeadings = undefined` in `openViewer`, which is the one spec'd
     * behaviour nothing else pins.
     *
     * `closeViewer` clears it too, and that half *is* covered below. What is not
     * covered by any other test is the second `enter`: `openViewer` closes the
     * panel and reopens it on the same session, and if the gate were left where
     * the previous viewer put it, a markdown file's heading state would follow
     * the reader into a code file and the jump key would scroll the `.ts` by the
     * markdown file's rows. That is a jump landing the reader on a row belonging
     * to a document they are no longer reading -- the same shape as a stale
     * snapshot, reached by a route no snapshot would take.
     *
     * So the markdown state has to be *populated* first, which is what the jump
     * below is for. A test that opened the code file directly would pass with
     * the reset deleted, because there would be nothing stale to carry.
     */
    const { default: mod } = await import("./tui")
    const m = createMockContext()
    await mod.setup(m.context)
    const state = m.panelState()

    // Both files in one session. The panel is closed and reopened between the
    // two entries, which is the remount this is about.
    state.setEntries([
      { name: "f.md", path: realMarkdownSource(HEADINGS), isDirectory: false },
      { name: "f.ts", path: realFile(200), isDirectory: false },
    ])

    state.setCursor(0)
    m.command("filetree.open")!.run()

    const markdown = m.viewerOffsets()
    const asked: number[] = []
    markdown.scrollbox()!.props.ref(fakeScrollBox(0, 400, 38, asked))
    markdown.markdownContent()!.props.onHeadingPositions(new Map(HEADING_ROWS))

    // The gate is open and a jump works, which is what makes the stale state
    // worth worrying about: there is now a populated map that could carry over.
    m.command("filetree.viewer.heading.next")!.run()
    expect(asked).toEqual([4])

    state.setCursor(1)
    m.command("filetree.open")!.run()

    const code = m.viewerOffsets()

    // The code path's writer is there -- the arrows scroll a code file fine --
    // so what is asserted below is the heading gate and not the absence of a
    // writer to write with.
    expect(code.writer()).toBeDefined()

    m.command("filetree.viewer.heading.next")!.run()

    expect(code.written).toEqual([])
  })

  itRender("a markdown file with no headings laid out has nothing to jump between", async () => {
    // The seeded empty map, which is what the viewer holds before
    // `MarkdownContentView` has laid anything out. A document with no headings
    // in it and a document whose layout has not run are the same thing to the
    // keymap, for the same reason they are the same thing to the sidebar.
    const { m, viewer, asked } = await headingFixture([])

    m.command("filetree.viewer.heading.next")!.run()
    m.command("filetree.viewer.heading.prev")!.run()

    expect(asked).toEqual([])
    expect(viewer.written).toEqual([])
  })

  itRender("a keypress after the viewer closes cannot reach its headings", async () => {
    const { m, viewer } = await headingFixture(HEADING_ROWS)

    m.command("filetree.viewer.close")!.run()
    m.command("filetree.viewer.heading.next")!.run()

    // Belt and braces beside `setViewerScroll`, cleared by the same close: the
    // state of a viewer that has been torn down must not be reachable, and
    // nothing that happens between this close and the next open should move a
    // window. Either flag alone would hold this; both are cleared together so
    // there is no keypress that reaches one without the other.
    expect(viewer.written).toEqual([])
  })
})
