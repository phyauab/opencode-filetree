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
      return (layer.commands ?? []).map((c: any) => ({ ...c, mode: layer.mode }))
    })

  return { context, slots, layers, prompts, toasts, pushed, allCommands }
}

/**
 * Collects the row boxes from a rendered tree element.
 *
 * The stub JSX runtime returns plain `{ type, props }` objects, so walking the
 * props is enough to find the clickable rows the tree rendered.
 */
function findRowBoxes(element: any, found: any[] = []): any[] {
  const children = element?.props?.children
  const list = Array.isArray(children) ? children.flat(Infinity) : [children]
  for (const child of list) {
    if (!child || typeof child !== "object") continue
    if (typeof child.props?.onMouseDown === "function" && child.type) found.push(child)
    else findRowBoxes(child, found)
  }
  return found
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

itRender("registers no keymap commands, so the prompt keeps every key", async () => {
    const { default: mod } = await load()
    const { context, allCommands, layers } = createMockContext()
    await mod.setup(context)

    // Keyboard navigation was removed: the host delivered keymap keys and
    // updated state correctly but never repainted the rows. Registering no layer
    // also guarantees the plugin cannot interfere with typing.
    expect(layers).toHaveLength(0)
    expect(allCommands()).toHaveLength(0)
  })

  itRender("never pushes an input mode or takes renderer focus", async () => {
    const { default: mod } = await load()
    const { context, slots, pushed } = createMockContext()
    await mod.setup(context)

    // Pushing a mode made the TUI unable to route any key until the user
    // clicked something, and focusing took the prompt's cursor away with a
    // delay on the way back.
    const treeElement = slots[0].claim.render({ sessionID: "ses_1" }) as any
    const rootElement = treeElement.type(treeElement.props) as any
    expect(() => rootElement.props.onMouseDown({ y: 9999 })).not.toThrow()

    expect(pushed).toEqual([])
    // focusable is what places the box in the host's hit grid. Without it the
    // handler never fires at all, which is why clicking did nothing.
    expect(rootElement.props.focusable).toBe(true)
  })

  itRender("clicking a row does not throw for any row in the tree", async () => {
    const { default: mod } = await load()
    const { context, slots } = createMockContext()
    await mod.setup(context)

    const treeElement = slots[0].claim.render({ sessionID: "ses_1" }) as any
    const rootElement = treeElement.type(treeElement.props) as any
    const onMouseDown = rootElement.props.onMouseDown
    // The row comes from the click's y against the windowed view, so every
    // position is handled and anything past the last row is ignored.
    for (let y = 0; y < 40; y++) {
      expect(() => onMouseDown({ y })).not.toThrow()
    }
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