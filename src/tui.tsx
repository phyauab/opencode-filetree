import { Plugin } from "@opencode/plugin/tui"
import { FileTree } from "./FileTree"
import { createTreeState } from "./store"
import { createTreeCommands, spawnEditor } from "./commands"
import { createSignal } from "solid-js"
import type { DirEntry } from "./fileSystem"

/** Input mode the TUI switches into while the file tree owns the keyboard. */
const TREE_MODE = "filetree"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    const state = createTreeState()
    const [sessionID, setSessionID] = createSignal("")

    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        if (input.sessionID) setSessionID(input.sessionID)
        return <FileTree state={state} />
      },
    })

    const commands = createTreeCommands({
      visibleNodes: state.visibleNodes,
      currentEntry: state.currentEntry,
      setCursor: state.setCursor,
      setExpanded: state.setExpanded,
      reset: () => {
        state.setEntries([])
        state.setExpanded(new Set<string>())
        state.setChildrenMap(new Map<string, DirEntry[]>())
        state.setCursor(0)
      },
      sendToSession: (entry) => {
        const id = sessionID()
        if (!id) return
        context.client.session.prompt({ sessionID: id, text: `Read ${entry.path}` })
      },
      openInEditor: spawnEditor,
    })

    /** Pop handle returned when tree mode was pushed; escape calls it. */
    let popTreeMode: (() => void) | undefined

    const enterTreeMode = () => {
      popTreeMode?.()
      popTreeMode = context.keymap.mode.push(TREE_MODE)
    }

    /** Leaves tree mode and hands the keyboard back to the host. */
    const exitTreeMode = () => {
      popTreeMode?.()
      popTreeMode = undefined
    }

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
        { id: "filetree.open", title: "File tree: open in editor", bind: "enter", run: commands.open },
        { id: "filetree.send", title: "File tree: send to session", bind: "ctrl+o", run: commands.send },
        { id: "filetree.refresh", title: "File tree: refresh", bind: "r", run: commands.refresh },
        { id: "filetree.exit", title: "File tree: exit", bind: "escape", run: exitTreeMode },
      ],
    }))

    // Entering tree mode is the only binding active in the host's own input mode.
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
      unregisterSlot()
    }
  },
})