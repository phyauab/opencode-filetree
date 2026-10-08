import { Plugin } from "@opencode/plugin/tui"
import { FileTree } from "./FileTree"
import { createTreeState } from "./store"
import { Show } from "solid-js"
import { createTreeCommands, spawnEditor, promptSession } from "./commands"

/** Panel name, used as the shared selection value for session.panel. */
const PANEL = "filetree.tree"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    const state = createTreeState()

    const notify = (message: string, variant: "info" | "error") =>
      context.ui.toast.show({ message, variant })

    let sessionID: string | undefined

    const tree = createTreeCommands({
      visibleNodes: state.visibleNodes,
      currentEntry: state.currentEntry,
      setCursor: state.setCursor,
      setExpanded: state.setExpanded,
      clampCursor: state.clampCursor,
      reload: state.reload,
      openInEditor: spawnEditor,
      sendToSession: (entry) => {
        void promptSession(context.client, sessionID, entry).then((result) => {
          if (!result.ok) notify(`Could not send ${entry.name}: ${result.error}`, "error")
        })
      },
    })

    /*
     * Navigation actions, bound to keys below.
     *
     * These only change state. None of them touch the panel: an earlier version
     * closed and reopened it on every change to force a repaint, which is exactly
     * what the user saw as a flash -- the whole screen torn down and rebuilt to
     * move a selection marker one row. Repainting is `renderer.requestRender()`
     * in one effect inside FileTree, so it covers keys, clicks, the file watcher
     * and lazy folder loads together and nothing has to remember to ask.
     */
    const nav = {
      move: (delta: number) => tree.move(delta),
      toggle: () => tree.toggle(),
      refresh: () => tree.refresh(),
      open: async () => {
        const entry = state.currentEntry()
        const result = await tree.open()
        if (result && !result.ok) {
          notify(`Could not open ${entry?.name ?? "file"}: ${result.error}`, "error")
        }
      },
      send: () => tree.send(),
    }

    const unregisterPanel = context.ui.slot({
      append: "session.panel",
      render: (input: { name: string; sessionID?: string }) => {
        // The slot is appended to every panel in the session, so only this
        // panel's own input may set the session; a neighbouring panel would
        // otherwise redirect a prompt into the wrong conversation.
        if (input.name === PANEL && input.sessionID) sessionID = input.sessionID
        return (
          <Show when={input.name === PANEL}>
            <FileTree state={state} context={context} />
          </Show>
        )
      },
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
            if (context.ui.panel.current()?.name === PANEL) context.ui.panel.close()
            else context.ui.panel.open(PANEL)
          },
        },
      ],
      bindings: ["filetree.toggle"],
    }))

    /*
     * The navigation layer is registered here, once, rather than from the panel
     * component. A component body re-runs on every mount, and each run
     * registered another copy of every binding: after four navigation steps the
     * host held five enabled `filetree.down` handlers, so one keypress moved the
     * cursor five rows, and the suite's own note on duplicate ids says the host
     * throws outright. The `enabled` predicate carries the scoping instead --
     * the bindings only fire while the host says this panel owns input.
     */
    context.keymap.layer(() => ({
      enabled: () => context.ui.panel.current()?.name === PANEL,
      commands: [
        { id: "filetree.up", title: "File tree: move up", bind: "up", run: () => nav.move(-1) },
        { id: "filetree.down", title: "File tree: move down", bind: "down", run: () => nav.move(1) },
        { id: "filetree.expand", title: "File tree: expand", bind: "right", run: nav.toggle },
        { id: "filetree.collapse", title: "File tree: collapse", bind: "left", run: nav.toggle },
        { id: "filetree.refresh", title: "File tree: refresh", bind: "r", run: () => nav.refresh() },
        { id: "filetree.open", title: "File tree: open in editor", bind: "enter", run: () => nav.open() },
        { id: "filetree.send", title: "File tree: send to session", bind: "s", run: () => nav.send() },
        { id: "filetree.close", title: "File tree: close", bind: "escape", run: () => context.ui.panel.close() },
      ],
      bindings: [
        "filetree.up",
        "filetree.down",
        "filetree.expand",
        "filetree.collapse",
        "filetree.refresh",
        "filetree.open",
        "filetree.send",
        "filetree.close",
      ],
    }))

    return () => {
      unregisterPanel()
    }
  },
})