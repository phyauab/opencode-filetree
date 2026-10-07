import { Plugin } from "@opencode/plugin/tui"
import { FileTree } from "./FileTree"
import { createTreeState } from "./store"
import { Show, type Component } from "solid-js"
import { moveCursor, toggleExpand } from "./treeLogic"

/** Panel name, used as the shared selection value for session.panel. */
const PANEL = "filetree.tree"

/**
 * The tree, rendered into a session panel.
 *
 * A panel is the documented surface for interactive plugin UI: the host owns
 * sizing, focus and input scope, and reports `focused` reactively. The earlier
 * build rendered into sidebar.content with a keymap layer registered from setup,
 * which gave the plugin no ownership of input or repaints; state changed
 * correctly and nothing was ever painted.
 */
const TreePanel: Component<{
  context: any
  state: ReturnType<typeof createTreeState>
  nav: { move: (d: number) => void; toggle: () => void; refresh: () => void }
}> = (props) => {
  const context = props.context
  const panel = context.ui.panel
  const state = props.state
  const nav = props.nav

  // The keymap layer is created from the component, not from setup, so it lives
  // and dies with the panel and only exists while the host says the panel owns
  // input.
  context.keymap.layer(() => ({
    enabled: () => panel.current()?.name === PANEL,
    commands: [
      { id: "filetree.up", title: "File tree: move up", bind: "up", run: () => nav.move(-1) },
      { id: "filetree.down", title: "File tree: move down", bind: "down", run: () => nav.move(1) },
      { id: "filetree.expand", title: "File tree: expand", bind: "right", run: nav.toggle },
      { id: "filetree.collapse", title: "File tree: collapse", bind: "left", run: nav.toggle },
      { id: "filetree.refresh", title: "File tree: refresh", bind: "r", run: () => nav.refresh() },
      { id: "filetree.close", title: "File tree: close", bind: "escape", run: () => panel.close() },
    ],
    bindings: [
      "filetree.up",
      "filetree.down",
      "filetree.expand",
      "filetree.collapse",
      "filetree.refresh",
      "filetree.close",
    ],
  }))

  return (
    <Show when={panel.current()?.name === PANEL}>
      <FileTree state={state} context={context} />
    </Show>
  )
}

export default Plugin.define({
  id: "filetree",
  setup(context) {
    // The live store holds the small, frequently-changing state. It is a Solid
    // store, so reading it inside the component is reactive and the host repaints
    // the change -- the same mechanism the host's own sidebar uses for live
    // sections such as token usage. The plugin's own signals were not reactive
    // in that way, which is why state updated correctly but nothing was drawn.
    const [live, setLive] = context.storage.memory<{
      cursor: number
      expanded: string[]
      viewportHeight: number
    }>("filetree", { initial: { cursor: 0, expanded: [], viewportHeight: 0 } })

    const state = createTreeState(live)

    // Navigation actions, bound to keys inside the panel below. Held here so the
    // keymap layer and the rendered tree share one implementation. They write to
    // the live store, which is what makes the change repaint.
    const nav = {
      move: (delta: number) => {
        const before = live.cursor
        setLive((draft) => {
          draft.cursor = moveCursor(draft.cursor, delta, state.visibleNodes().length)
        })
        // Already at the end: nothing changed, so nothing to repaint.
        if (live.cursor === before) return
        state.clampCursor()
      },
      toggle: () => {
        const entry = state.currentEntry()
        if (!entry?.isDirectory) return
        setLive((draft) => {
          draft.expanded = [...toggleExpand(entry.path, new Set(draft.expanded))]
        })
        state.clampCursor()
      },
      refresh: () => {
        state.reload()
      },
    }

    const unregisterPanel = context.ui.slot({
      append: "session.panel",
      render: (panelInput: { name: string }) => (
        <Show when={panelInput.name === PANEL}>
          <TreePanel context={context} state={state} nav={nav} />
        </Show>
      ),
    })

    // Open the panel. The host scopes input and focus to it, which is what the
    // sidebar slot never did.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "filetree.toggle",
          title: "File tree",
          group: "File tree",
          palette: true,
          suggested: true,
          run: () => {
            const open = context.ui.panel.current()?.name === PANEL
            if (open) context.ui.panel.close()
            else context.ui.panel.open(PANEL)
          },
        },
      ],
      bindings: ["filetree.toggle"],
    }))

    return () => {
      unregisterPanel()
    }
  },
})