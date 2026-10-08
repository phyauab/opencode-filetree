import { Plugin } from "@opencode/plugin/tui"
import { FileTree } from "./FileTree"
import { createTreeState } from "./store"
import { createTreeCommands, spawnEditor, promptSession } from "./commands"
import { trace } from "./trace"

/**
 * SPIKE — throwaway. This is the sidebar-placement probe: the tree renders into
 * the session sidebar (below the "Context" card) instead of a side panel, so it
 * is always visible and never changes the layout. See
 * docs/superpowers/plans/2026-10-08-sidebar-spike.md for what it tests and what
 * to look for. Nothing here is a decision to keep.
 */

/** Minimal shape of the tree's root renderable, for focus gating. */
type TreeRoot = {
  focus(): void
  blur(): void
  parent?: TreeRoot | null
}

export default Plugin.define({
  id: "filetree",
  setup(context) {
    trace("setup", { hasKeymap: !!context.keymap, hasRenderer: !!context.renderer })
    const state = createTreeState()

    const notify = (message: string, variant: "info" | "error") =>
      context.ui.toast.show({ message, variant })

    let sessionID: string | undefined
    /** The tree's root box, captured from the slot render's ref. */
    let treeRoot: TreeRoot | undefined

    /*
     * Who owns the navigation keys. This is plugin state, deliberately not
     * derived from renderer focus, because focus cannot be relied on here:
     *
     *   - The host registers a layer gated on `currentFocusedEditor === null`,
     *     and that getter is null for *any* non-editor renderable, our box
     *     included. Focusing the tree therefore switches the host's session
     *     navigation on -- the layer that binds down/up for session and
     *     subagent switching. That is the "press down, the subagent panel
     *     opens" report, and no keybind of ours caused it.
     *   - The host re-asserts focus on the prompt within about a second of the
     *     tree taking it. Traced: `focus.run holder uA` -> `root.focused
     *     holder ur` -> `root.blurred holder uA`, 1.3s later, repeatedly. Any
     *     gate that reads focus therefore flaps, which is what made the
     *     shortcut feel intermittent.
     *
     * So the tree keeps its own flag. ctrl+y claims the keys, esc and a click
     * release them, and the nav layer reads this. Focus is still taken -- the
     * border and hint line should reflect it -- but it is presentation, not
     * the gate. A host that reclaims focus costs a dim border, not the keys.
     */
    let keysHeld = false

    /** Focus-gated, for the trace and for nothing that decides behaviour. */
    const focusedWithinTree = () => {
      let current: TreeRoot | null | undefined = context.renderer?.currentFocusedRenderable
      while (current) {
        if (current === treeRoot) return true
        current = current.parent
      }
      return false
    }

    /**
     * Names whatever currently holds focus, for the trace.
     *
     * A user reporting "it works the first time and then not" is describing two
     * different situations, and only the focus holder tells them apart: the tree
     * blurred itself, or something else took the keyboard. The constructor name
     * is enough to tell a host prompt editor from a session list.
     */
    const focusHolder = () => {
      const current = context.renderer?.currentFocusedRenderable as
        | { constructor?: { name?: string } }
        | null
        | undefined
      if (!current) return "none"
      return current.constructor?.name ?? "unknown"
    }

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
     * These only change state. None of them touch the layout: an earlier version
     * closed and reopened the panel on every change to force a repaint, which is
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

    /*
     * Sidebar placement. The slot input carries the sessionID directly, and the
     * claim is appended after the host's own sidebar plugins, so the tree lands
     * below the "Context" card. The repaint effect inside FileTree is
     * renderer-global, which is what makes a live tree in the sidebar possible:
     * the first attempt at a sidebar tree died precisely because nothing asked
     * the renderer for a frame.
     */
    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input: { sessionID: string }) => {
        if (input.sessionID) sessionID = input.sessionID
        trace("slot.render")
        return (
          <FileTree
            state={state}
            context={context}
            // A click is a claim on the keyboard, not just a selection. Focus
            // alone cannot carry that: the host takes focus back, and focus is
            // not what decides the keys any more (see `keysHeld`).
            onActivate={() => {
              keysHeld = true
              treeRoot?.focus()
            }}
            onRoot={(el: TreeRoot) => {
              const anyEl = el as unknown as Record<string, unknown>
              trace("root.ref", {
                first: treeRoot === undefined,
                focusable: anyEl._focusable,
                destroyed: anyEl._isDestroyed,
                focused: anyEl._focused,
                hasParent: !!el.parent,
              })
              treeRoot = el
            }}
          />
        )
      },
    })
    trace("slot.claimed", { unregister: typeof unregisterSlot })

    /*
     * ctrl+y gives the keyboard to the tree. There is nothing to open or close:
     * the tree is always there.
     *
     * ctrl+e was the first choice and it silently did nothing: the host binds
     * it as `input.line.end` ("move to end of line"), so the prompt editor
     * consumed every press. ctrl+y appears nowhere in the host's default
     * keybind map -- verified against the complete map, input.* section
     * included -- and stays rebindable by command id (`filetree.focus`).
     *
     * Not a toggle, which is the second thing that read as a broken key: the
     * first press focused, the second blurred, and whether the second press
     * blurred or focused again came down to whether the host had handed focus
     * back in between. Same key, opposite results, neither reproducible. Now the
     * key only ever means "the keyboard is mine", and is a no-op when the tree
     * already has it. `esc` hands it back, and the hint line says so.
     */
    const focusTheTree = () => {
      const anyRoot = treeRoot as unknown as Record<string, unknown> | undefined
      trace("focus.run", {
        hasRoot: !!treeRoot,
        keysHeld,
        withinTree: focusedWithinTree(),
        rootFocusable: anyRoot?._focusable,
        rootFocused: anyRoot?._focused,
        rootDestroyed: anyRoot?._isDestroyed,
        // Who holds focus right now. When this is not the prompt editor or the
        // tree, the host moved focus on its own, which is what would make a
        // press feel intermittent.
        holder: focusHolder(),
      })
      keysHeld = true
      treeRoot?.focus()
      trace("focus.after", {
        keysHeld,
        currentFocused: !!context.renderer?.currentFocusedRenderable,
        withinTree: focusedWithinTree(),
        holder: focusHolder(),
      })
    }

    /** Hands the keys back, and the focus with them. */
    const releaseTheKeys = () => {
      trace("blur.request", { keysHeld, holder: focusHolder(), withinTree: focusedWithinTree() })
      keysHeld = false
      treeRoot?.blur()
      trace("blur.after", { keysHeld, holder: focusHolder(), withinTree: focusedWithinTree() })
    }

    try {
      context.keymap.layer(() => {
        trace("layer.factory", { layer: "focus" })
        return {
          mode: "global",
          commands: [
            {
              id: "filetree.focus",
              title: "File tree",
              group: "File tree",
              palette: true,
              suggested: true,
              bind: "ctrl+y",
              run: focusTheTree,
            },
          ],
          bindings: ["filetree.focus"],
        }
      })
      trace("layer.registered", { layer: "focus" })
    } catch (error) {
      trace("layer.threw", { layer: "focus", error: String(error) })
    }

    /*
     * The navigation layer is registered here, once, rather than from the panel
     * component. A component body re-runs on every mount, and each run
     * registered another copy of every binding: after four navigation steps the
     * host held five enabled `filetree.down` handlers, so one keypress moved the
     * cursor five rows, and the suite's own note on duplicate ids says the host
     * throws outright. The `enabled` predicate carries the scoping instead --
     * the bindings only fire while the focus is inside the tree, so the session
     * list and the prompt keep their own arrow keys.
     */
    /*
     * `priority: 10` is load-bearing, not decoration.
     *
     * The host's own navigation layer is enabled whenever no *editor* holds
     * focus, and our box is not an editor -- so it activates precisely when we
     * take focus, and it binds down/up for session and subagent navigation.
     * Layers resolve by `priority` descending, then registration order
     * descending (`n.priority - t.priority || n.order - t.order`), so an
     * explicit priority is the difference between owning those keys and
     * watching the subagent panel open when the user presses down.
     */
    try {
      context.keymap.layer(() => {
        trace("layer.factory", { layer: "nav" })
        return {
          enabled: () => keysHeld,
          priority: 10,
          commands: [
            {
              id: "filetree.up",
              title: "File tree: move up",
              bind: "up",
              run: () => {
                trace("nav.run", { id: "up" })
                nav.move(-1)
              },
            },
            { id: "filetree.down", title: "File tree: move down", bind: "down", run: () => nav.move(1) },
            { id: "filetree.expand", title: "File tree: expand", bind: "right", run: nav.toggle },
            { id: "filetree.collapse", title: "File tree: collapse", bind: "left", run: nav.toggle },
            { id: "filetree.refresh", title: "File tree: refresh", bind: "r", run: () => nav.refresh() },
            { id: "filetree.open", title: "File tree: open in editor", bind: "enter", run: () => nav.open() },
            { id: "filetree.send", title: "File tree: send to session", bind: "s", run: () => nav.send() },
            // esc hands the keyboard back instead of closing anything.
            {
              id: "filetree.close",
              title: "File tree: return focus",
              bind: "escape",
              run: releaseTheKeys,
            },
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
        }
      })
      trace("layer.registered", { layer: "nav" })
    } catch (error) {
      trace("layer.threw", { layer: "nav", error: String(error) })
    }

    return () => {
      unregisterSlot()
    }
  },
})
