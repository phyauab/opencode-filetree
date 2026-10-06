import { Plugin } from "@opencode/plugin/tui"
import { FileTree } from "./FileTree"
import { createTreeState } from "./store"
import { createTreeCommands, spawnEditor, promptSession } from "./commands"
import { createSignal } from "solid-js"

/** Input mode the TUI switches into while the file tree owns the keyboard. */
const TREE_MODE = "filetree"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    const state = createTreeState()
    const [sessionID, setSessionID] = createSignal("")

    // The sidebar slot reports the active session, which ctrl+o needs. It is
    // rendered on every session, so this stays current as the user switches.
    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        if (input.sessionID) setSessionID(input.sessionID)
        return <FileTree state={state} context={context} />
      },
    })

    const notify = (message: string, variant: "info" | "error") =>
      context.ui.toast.show({ message, variant })

    const commands = createTreeCommands({
      visibleNodes: state.visibleNodes,
      currentEntry: state.currentEntry,
      setCursor: state.setCursor,
      setExpanded: state.setExpanded,
      clampCursor: state.clampCursor,
      reload: state.reload,
      openInEditor: spawnEditor,
      sendToSession: (entry) => {
        void promptSession(context.client, sessionID(), entry).then((result) => {
          if (!result.ok) notify(`Could not send ${entry.name}: ${result.error}`, "error")
        })
      },
    })

    // Tree navigation owns the keyboard only while the TUI is in tree mode, so
    // arrow keys and enter keep working in the prompt.
    context.keymap.layer(() => ({
      mode: TREE_MODE,
      priority: 10,
      commands: [
        { id: "filetree.up", title: "File tree: move up", bind: "up", run: () => commands.move(-1) },
        { id: "filetree.down", title: "File tree: move down", bind: "down", run: () => commands.move(1) },
        { id: "filetree.expand", title: "File tree: expand folder", bind: "right", run: commands.toggle },
        { id: "filetree.collapse", title: "File tree: collapse folder", bind: "left", run: commands.toggle },
        {
          id: "filetree.open",
          title: "File tree: open in editor",
          bind: "enter",
          run: async () => {
            const result = await commands.open()
            if (result && !result.ok) notify(`Could not open editor: ${result.error}`, "error")
          },
        },
        {
          id: "filetree.send",
          title: "File tree: send to session",
          bind: "ctrl+o",
          run: () => commands.send(),
        },
        { id: "filetree.refresh", title: "File tree: refresh", bind: "r", run: commands.refresh },
        { id: "filetree.exit", title: "File tree: exit", bind: "escape", run: () => exitTreeMode() },
      ],
    }))

    // Entering tree mode is the only binding active in the host's own input mode.
    /** Pop handle returned when tree mode was pushed; escape calls it. */
    let popTreeMode: (() => void) | undefined

    const enterTreeMode = () => {
      popTreeMode?.()
      popTreeMode = context.keymap.mode.push(TREE_MODE)
    }

    const exitTreeMode = () => {
      popTreeMode?.()
      popTreeMode = undefined
    }

    context.keymap.layer(() => ({
      commands: [
        {
          id: "filetree.enter-mode",
          title: "File tree: focus",
          group: "File tree",
          bind: "ctrl+f",
          palette: true,
          suggested: true,
          run: enterTreeMode,
        },
      ],
    }))

    return () => {
      popTreeMode?.()
      unregisterSlot()
    }
  },
})