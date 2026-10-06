import { Plugin } from "@opencode/plugin/tui"
import { FileTree, type TreeRoot } from "./FileTree"
import { createTreeState } from "./store"
import { createTreeCommands, spawnEditor, promptSession } from "./commands"
import { createSignal } from "solid-js"

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
        return <FileTree state={state} context={context} onRoot={(root) => (treeRoot = root)} />
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

    /**
     * The tree's root renderable, once the sidebar slot has rendered it.
     * The navigation layer is scoped to it, so the keys are live only while the
     * tree itself holds focus.
     */
    let treeRoot: TreeRoot | undefined

    /** True while the tree owns focus. Read by the layer on every key event. */
    const treeFocused = () => treeRoot?.focused === true

    const focusTree = () => {
      if (!treeRoot) return
      // The renderer's own focus API, not Renderable.focus(): the renderer
      // tracks which renderable holds focus and routes keys to it, so focusing
      // through the renderable alone leaves the renderer's view unchanged.
      ;(context.renderer as unknown as {
        focusRenderable?: (r: unknown) => void
      }).focusRenderable?.(treeRoot)
    }

    /**
     * Releases the tree's focus so the host resumes routing keys. Focusing null
     * is not supported, so the previous owner is restored explicitly when the
     * tree had focus.
     */
    const blurTree = () => {
      if (!treeRoot) return
      ;(context.renderer as unknown as {
        blurRenderable?: (r: unknown) => void
      }).blurRenderable?.(treeRoot)
    }

    // Focus the tree. No key is bound: any binding in the host's own mode fires
    // while the user is typing, and readline already owns ctrl+f, ctrl+o and
    // ctrl+t. A key can still be bound to this command by id in tui.json under
    // "keybinds".
    //
    // mode "global" opts out of mode gating, so the command is listed whatever
    // the TUI is doing.
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
          run: focusTree,
        },
      ],
    }))

    // Tree navigation is scoped to the tree's own renderable, so these keys are
    // live only while the tree has focus. Nothing global is taken over and no
    // input mode is pushed: an earlier version pushed a mode, which left the
    // TUI unable to route any key at all until the user clicked something.
//
// Command ids must be unique within a layer.
    context.keymap.layer(() => ({
      target: () => (treeFocused() ? (treeRoot as never) : null),
      enabled: treeFocused,
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
        {
          id: "filetree.exit",
          title: "File tree: exit",
          bind: "escape",
          // Hand focus back to the host rather than popping a mode, so the
          // prompt gets its keys again on the very next press.
          run: () => blurTree(),
        },
      ],
    }))

    // Diagnostics: what did the host actually register? The plugin runs inside the
    // host process, so this is the only way to see the real reachable set
    // rather than inferring it from the outside. Set `debug: true` in
    // opencode.json to see it.
    if (context.options?.debug) {
      const ids = context.keymap
        .commands()
        .filter((c) => c.id?.startsWith("filetree."))
        .map((c) => c.id)
      const renderer = context.renderer as unknown as {
        currentFocusedRenderable?: { id?: string; focused?: boolean }
        focusRenderable?: unknown
        blurRenderable?: unknown
      }
      notify(
        [
          `ft debug:`,
          `mode=${context.keymap.mode.current()}`,
          `root=${treeRoot ? "yes" : "no"}`,
          `focused=${treeFocused()}`,
          `focusApi=${renderer.focusRenderable ? "focusRenderable" : "MISSING"}`,
          `blurApi=${renderer.blurRenderable ? "blurRenderable" : "MISSING"}`,
          `hostFocus=${renderer.currentFocusedRenderable?.id ?? "none"}`,
          `cmds=[${ids.join(" ")}]`,
        ].join(" "),
        "info",
      )
    }

    return () => {
      treeRoot = undefined
      unregisterSlot()
    }
  },
})