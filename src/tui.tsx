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
    const state = createTreeState()

    // Navigation actions, bound to keys inside the panel below. Held here so the
    // keymap layer and the rendered tree share one implementation.
    const nav = {
      move: (delta: number) =>
        state.setCursor((c) => moveCursor(c, delta, state.visibleNodes().length)),
      toggle: () => {
        const entry = state.currentEntry()
        if (entry?.isDirectory) {
          state.setExpanded((prev) => toggleExpand(entry.path, prev))
          state.clampCursor()
        }
      },
      refresh: () => state.reload(),
    }

    const unregisterPanel = context.ui.slot({
      append: "session.panel",
      render: (panelInput: { name: string; sessionID: string }) => (
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