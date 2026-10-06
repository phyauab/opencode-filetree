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

    // Nothing is bound with a key here: any binding registered for the host's
    // own mode fires while the user is typing, and readline already owns ctrl+f,
    // ctrl+o and ctrl+t. A key can still be bound to the command by id in
    // tui.json under "keybinds".
    //
    // mode "global" opts out of mode gating. A layer without it defaults to
    // "base", which left the focus command unreachable whenever the TUI was in
    // any other input mode (the diff view, for one).
    //
    // This layer registers before the tree layer on purpose. `keymap.layer`
    // throws synchronously on a command-shape error, and the throw aborts setup,
    // so anything registered later would never exist. A duplicate command id
    // once did exactly that: the tree rendered with no working keys at all.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "filetree.enter-mode",
          title: "File tree: focus",
          group: "File tree",
          palette: true,
          run: enterTreeMode,
        },
      ],
    }))

    // Tree navigation owns the keyboard only while the TUI is in tree mode, so
    // arrow keys and enter keep working in the prompt. Command ids must be
    // unique within a layer.
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

    // Diagnostics: what did the host actually register? The plugin runs inside the
    // host process, so this is the only way to see the real reachable set
    // rather than inferring it from the outside. Set `debug: true` in
    // opencode.json to see it.
    if (context.options?.debug) {
      const reachable = context.keymap
        .commands()
        .filter((c) => c.id?.startsWith("filetree."))
        .map((c) => c.id)
      notify(`ft debug: mode=${context.keymap.mode.current()} [${reachable.join(" ")}]`, "info")
    }

    return () => {
      popTreeMode?.()
      unregisterSlot()
    }
  },
})