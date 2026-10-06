import { Plugin } from "@opencode/plugin/tui"
import { FileTree, type TreeRoot } from "./FileTree"
import { createTreeState } from "./store"
import { createTreeCommands, spawnEditor, promptSession } from "./commands"
import { createSignal } from "solid-js"
import { trace, forceActive } from "./trace"

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
            onRoot={(root) => {
              treeRoot = root
              if (forceActive) focusTree()
            }}
            onActivate={focusTree}
            active={treeActive()}
          />
        )
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
      repaint: () => {
        const r = context.renderer as unknown as { requestRender?: () => void }
        r.requestRender?.()
      },
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
     * The gate is a reactive flag, but the flag alone is not enough: the host
     * routes keys to the focused renderable first, and that is the prompt, so
     * typing went to the chat while the tree showed as active. Focus has to move
     * to the tree as well, or the prompt keeps swallowing the keys.
     */
    const [treeActive, setTreeActive] = createSignal(forceActive)

    type Renderer = {
      focusRenderable?: (r: unknown) => void
      currentFocusedRenderable?: unknown
    }
    const renderer = context.renderer as unknown as Renderer

    /** Whoever held focus before the tree took it, restored on exit. */
    let previousFocus: unknown

    const focusTree = () => {
      if (!treeRoot) {
        trace("focus-skipped", { reason: "no-root" })
        return
      }
      previousFocus = renderer.currentFocusedRenderable
      renderer.focusRenderable?.(treeRoot)
      setTreeActive(true)
      trace("focus", {
        moved: renderer.currentFocusedRenderable === treeRoot,
        previous: (previousFocus as { constructor?: { name?: string } })?.constructor?.name ?? "none",
      })
    }

    const blurTree = () => {
      setTreeActive(false)
      // Hand focus back, or the prompt stays unable to receive keys.
      renderer.focusRenderable?.(previousFocus)
      previousFocus = undefined
      trace("blur", { restored: renderer.currentFocusedRenderable === previousFocus })
    }

    /** The tree's root renderable, captured for click-to-focus. */
    let treeRoot: TreeRoot | undefined

    trace("setup", {
      mode: context.keymap.mode.current(),
      hostFocus: (renderer.currentFocusedRenderable as { constructor?: { name?: string } })
        ?.constructor?.name ?? "none",
    })

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
      // Outrank the host's prompt layer. Without this the layer is enabled but
      // loses dispatch: the keys reach the prompt and the tree never sees them,
      // while the active banner shows as if it were working.
      priority: 1000,
      commands: [
        { id: "filetree.up", title: "File tree: move up", bind: "up", run: () => { trace("run", { cmd: "up" }); commands.move(-1) } },
        { id: "filetree.down", title: "File tree: move down", bind: "down", run: () => { trace("run", { cmd: "down" }); commands.move(1) } },
        { id: "filetree.expand", title: "File tree: expand folder", bind: "right", run: () => { trace("run", { cmd: "expand" }); commands.toggle() } },
        { id: "filetree.collapse", title: "File tree: collapse folder", bind: "left", run: () => { trace("run", { cmd: "collapse" }); commands.toggle() } },
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
        { id: "filetree.refresh", title: "File tree: refresh", bind: "r", run: () => { trace("run", { cmd: "refresh" }); commands.refresh() } },
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
      notify(
        `ft debug: mode=${context.keymap.mode.current()} root=${
          treeRoot ? "yes" : "no"
        } active=${treeActive()} hostFocus=${
          (renderer.currentFocusedRenderable as { constructor?: { name?: string } })
            ?.constructor?.name ?? "none"
        }`,
        "info",
      )
    }

    // Diagnostics: record what the host's keymap actually resolved, which is the
    // only way to see this from outside the process. Polled because `enabled`
    // and the active bindings both settle after setup.
    let lastActive = ""
    const poll = setInterval(() => {
      try {
        const active = context.keymap.active()
        const snapshot = JSON.stringify(active)
        if (snapshot === lastActive) return
        lastActive = snapshot
        const renderer = context.renderer as unknown as {
          currentFocusedRenderable?: { constructor?: { name?: string } }
        }
        trace("active", {
          treeActive: treeActive(),
          mode: context.keymap.mode.current(),
          hostFocus: renderer.currentFocusedRenderable?.constructor?.name ?? "none",
          ours: active.filter((k) => k.title?.startsWith("File tree")).length,
          keys: active.map((k) => `${k.key}=${k.title ?? "?"}${k.continues ? "+" : ""}`),
        })
      } catch (error) {
        trace("active-error", { error: String(error) })
      }
    }, 300)

    return () => {
      clearInterval(poll)
      treeRoot = undefined
      unregisterSlot()
    }
  },
})