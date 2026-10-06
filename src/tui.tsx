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
        return (
          <FileTree
            state={state}
            context={context}
            onRoot={(root) => (treeRoot = root)}
            onActivate={focusTree}
            active={treeActive()}
          />
        )
      },
    })

    const notify = (message: string, variant: "info" | "error") =>
      context.ui.toast.show({ message, variant })

    /** Layer factories, kept so the debug toast can report what the host enabled. */
    const layers: { factory: () => { enabled?: unknown } }[] = []
    const realLayer = context.keymap.layer.bind(context.keymap)
    context.keymap.layer = ((factory: () => any) => {
      layers.push({ factory })
      return realLayer(factory)
    }) as typeof context.keymap.layer

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
     * Whether the tree currently owns the navigation keys.
     *
     * This is a plain reactive flag rather than renderer focus or a pushed input
     * mode. Focus was tried and could not be verified from outside the host, and
     * pushing a mode broke the host's key routing outright. A layer's `enabled`
     * is reactive and disables only this layer, so the host's own keys are never
     * taken away and cannot be left dead.
     */
    const [treeActive, setTreeActive] = createSignal(false)

    const focusTree = () => {
      setTreeActive(true)
    }
    const blurTree = () => {
      setTreeActive(false)
    }

    /** The tree's root renderable, captured for click-to-focus. */
    let treeRoot: TreeRoot | undefined

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

    // Tree navigation. The layer is enabled only while the tree is active, so the
// host keeps its own keys the rest of the time. No mode is pushed and nothing
// global is taken over.
//
// Command ids must be unique within a layer.
    context.keymap.layer(() => ({
      mode: "global",
      enabled: treeActive,
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
          `active=${treeActive()}`,
          `layerEnabled=${String(
            typeof layers[1]?.factory().enabled === "function"
              ? (layers[1].factory().enabled as () => unknown)()
              : "n/a",
          )}`,
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