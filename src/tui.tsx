import { Plugin } from "@opencode/plugin/tui"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { createSignal, type Setter } from "solid-js"
import { FileTree } from "./FileTree"
import { createTreeState } from "./store"
import { createTreeCommands, promptSession } from "./commands"
import type { DirEntry } from "./fileSystem"
import { FileViewer, VIEWER_ROWS_CHROME } from "./viewer/FileViewer"
import { readForView } from "./viewer/readForView"
import { scrollByLine, scrollByPage } from "./viewer/scroll"
import { trace } from "./trace"

/**
 * SPIKE — throwaway. This is the sidebar-placement probe: the tree renders into
 * the session sidebar (below the "Context" card) instead of a side panel, so it
 * is always visible and never changes the layout. See
 * docs/superpowers/plans/2026-10-08-sidebar-spike.md for what it tests and what
 * to look for. Nothing here is a decision to keep.
 */

/** The name the viewer claims `session.panel` under. */
const VIEWER_PANEL = "filetree.viewer"

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

    /*
     * What the viewer layer is allowed to do, and what the keys are allowed to
     * move.
     *
     * `viewerOpen` is the whole gate, for the same reason `keysHeld` is: the
     * host re-asserts focus on the prompt about a second after anything takes
     * it, so a focus-derived gate flaps and the arrows stop working. The panel
     * slot's own input would be just as unreliable -- it is client-local host
     * state that a close elsewhere can move under us.
     */
    const [viewerOpen, setViewerOpen] = createSignal(false)
    const [viewerPath, setViewerPath] = createSignal<string | undefined>(undefined)
    /**
     * Lines in the file on screen, or 0 when there are none to scroll through.
     * Read again here rather than taken from the viewer, which hands over only
     * its writer; see the comment on `openViewer` for why a second read is the
     * cheaper of the two options.
     */
    const [viewerLines, setViewerLines] = createSignal(0)
    /**
     * The viewer's scroll offset's WRITER, not its value, because the offset
     * belongs to the component that owns the repaint. Whoever drives it says how
     * far to move; the viewer's own `offset()` decides what is legal.
     *
     * Solid's `Setter<number>` because that is literally what `FileViewer` hands
     * over -- the signal's own writer -- and it is the type that takes an
     * updater, so `scrollViewer` below can write it with no cast and nothing to
     * explain away. The prop used to declare the writer's *behaviour* rather
     * than its type, and that mismatch is what forced a cast that hid no real
     * error.
     *
     * Nothing re-clamps on the way in. `scrollByLine`/`scrollByPage` bound the
     * step against the line count and row count, and the viewer's `offset()`
     * clamps every read of the offset, so no value written from here can put
     * the window outside the file.
     */
    let setViewerScroll: Setter<number> | undefined

    /**
     * Rows the viewer may spend on file content.
     *
     * A signal rather than a number read at open time, because that is what
     * makes `props.height` a real reactive read inside the viewer's repaint
     * effect: under babel-preset-solid the JSX expression below compiles to a
     * getter, so the effect depends on this signal and a resize repaints. A
     * plain number handed in as a value would leave the effect tracking only
     * the scroll offset, which is the bug this repo has already paid for twice.
     */
    const [terminalHeight, setTerminalHeight] = createSignal(
      context.renderer?.height ?? 40,
    )
    const viewerHeight = () => Math.max(1, terminalHeight() - VIEWER_ROWS_CHROME)

    const measureTerminal = () => {
      const next = context.renderer?.height
      if (typeof next === "number" && next > 0) setTerminalHeight(next)
    }
    // An EventEmitter's `on` returns the emitter, not an unsubscribe, so the
    // teardown has to be the matching `off` -- the same shape FileTree's
    // resize effect uses, hoisted out of a component because here there is no
    // owner to hang a cleanup on.
    context.renderer?.on?.("resize", measureTerminal)

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

    /*
     * Opening a file, and closing it again.
     *
     * `FileViewer` reads its file in the component body, and Solid never re-runs
     * a body, so the path it read is the path this mount shows. A second `enter`
     * on a different file therefore has to arrive on a *fresh mount*, which is
     * why the panel is closed before it is reopened rather than just reopened:
     * closing is what tears the slot's content down. Reopening the same name
     * with different contents would hand the new path to an instance already on
     * screen, and the reader would be looking at the previous file with no way
     * to tell why.
     *
     * The line count is read a second time for the same reason the panel is
     * closed: the viewer keeps its read to itself and hands over only the
     * writer, so the keys have no way to ask how long the file is. `readForView`
     * is capped and synchronous, so this costs one bounded read per open rather
     * than a per-keypress one, and a disagreement between the two reads is
     * harmless -- the viewer's own `offset()` clamps every read of the offset,
     * so the window is never outside the file either way.
     */
    const openViewer = (entry: DirEntry) => {
      const file = readForView(entry.path)
      setViewerScroll = undefined
      setViewerPath(entry.path)
      setViewerLines(file.kind === "text" ? file.totalLines : 0)
      context.ui.panel.close()
      setViewerOpen(context.ui.panel.open(VIEWER_PANEL))
      trace("viewer.open", { path: entry.path, lines: viewerLines(), kind: file.kind })
    }

    const closeViewer = () => {
      setViewerScroll = undefined
      setViewerOpen(false)
      context.ui.panel.close()
      trace("viewer.close")
    }

    /**
     * Moves the window, in lines or in half-screens.
     *
     * The row count is passed to the step rather than read again inside it, so
     * the value the step clamps against is the value the trace reports. Read
     * twice it would be two separate measurements of a number that can change
     * between them on a resize.
     */
    const scrollViewer = (rows: number, step: (prev: number) => number) => {
      setViewerScroll?.((prev) => step(prev))
      trace("viewer.scroll", { rows, lines: viewerLines(), open: viewerOpen() })
    }

    const tree = createTreeCommands({
      visibleNodes: state.visibleNodes,
      currentEntry: state.currentEntry,
      setCursor: state.setCursor,
      setExpanded: state.setExpanded,
      clampCursor: state.clampCursor,
      reload: state.reload,
      openInViewer: openViewer,
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
     *
     * `open` no longer awaits anything. Spawning `$EDITOR` returned a promise and
     * a failure to report; showing a file in our own panel returns a boolean and
     * nothing else, so there is no result to inspect and no toast to raise.
     */
    const nav = {
      move: (delta: number) => tree.move(delta),
      toggle: () => tree.toggle(),
      refresh: () => tree.refresh(),
      open: () => tree.open(),
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
     * The viewer's claim on `session.panel`.
     *
     * A plain `if` rather than a `<Show>`, and the reason is the host rather
     * than the tests. Both render nothing when the condition fails, but a claim
     * that returns `null` is unambiguous about owning nothing, and the
     * reconciling side effect below needs to happen on the way out -- a `<Show>`
     * would put the viewer's element behind a component boundary whose child is
     * only reachable by walking `props.children`. (That walk does work: the stub
     * records `createComponent(Show, props)` without invoking the props getters,
     * so the compiled `get children()` survives. An earlier version of this
     * comment claimed the opposite and was wrong; the stub's `Show` has since
     * been made honest, which is the durable fix rather than routing around an
     * artefact of it.)
     *
     * `path` and `height` are NOT equivalent, and the difference is the whole
     * reason `openViewer` closes the panel before reopening it. babel-preset-solid
     * wraps `height={viewerHeight()}` in a getter, because it is a call, so a
     * resize reaches the viewer in place. `path` is a local read once, so it
     * compiles to a plain `path: path` -- a snapshot taken when this render ran.
     * Reopening the same panel with a different path would therefore hand the
     * new path to a component already on screen, whose body already read the old
     * one. Closing the panel is what forces a fresh mount.
     */
    const unregisterViewer = context.ui.slot({
      append: "session.panel",
      render: (input: PanelInput) => {
        // The SDK documents this render as receiving its input reactively, so this
        // guard re-evaluates when the host moves the panel off us -- its own close
        // chrome, or another plugin taking `session.panel` for itself. Reconciling
        // here is what stops a priority-20 layer from eating the arrow keys over a
        // panel that is not ours, with nothing on screen to explain the dead keys.
        if (input.name !== VIEWER_PANEL) {
          if (viewerOpen()) closeViewer()
          return null
        }
        const path = viewerPath()
        if (!path) return null
        return (
          <FileViewer
            path={path}
            height={viewerHeight()}
            context={context}
            // The viewer's own writer, held so the keymap can move the offset
            // without owning it. Reset on every open so a keypress can never
            // reach the writer of a viewer that has been torn down.
            //
            scrollTo={(setOffset: Setter<number>) => {
              setViewerScroll = setOffset
            }}
          />
        )
      },
    })
    trace("viewer.claimed", { unregister: typeof unregisterViewer })

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
            { id: "filetree.open", title: "File tree: open file", bind: "enter", run: () => nav.open() },
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

    /*
     * The viewer's keys, and the layer ordering that makes them work.
     *
     * The priority is higher than the tree's nav layer, and strictly greater
     * than it rather than equal, because both layers bind up/down and equal
     * priorities tie-break on registration order -- which is invisible at the
     * call site. With a strict margin registration order stops mattering, so
     * moving this layer above the nav layer cannot change the outcome. Lowering
     * it *to* 10 would, and the suite asserts the ordering rather than trusting
     * this comment.
     *
     * Against the *host's* layer the same argument applies one level down: it is
     * gated on `currentFocusedEditor === null`, which is true for anything
     * non-editor, viewer included, and it binds down/up for session and subagent
     * navigation. Any positive priority outranks it.
     */
    try {
      context.keymap.layer(() => {
        trace("layer.factory", { layer: "viewer" })
        return {
          enabled: () => viewerOpen(),
          priority: 20,
          commands: [
            {
              id: "filetree.viewer.down",
              title: "File viewer: scroll down",
              bind: "down",
              run: () => {
                const rows = viewerHeight()
                scrollViewer(rows, (prev) => scrollByLine(prev, 1, viewerLines(), rows))
              },
            },
            {
              id: "filetree.viewer.up",
              title: "File viewer: scroll up",
              bind: "up",
              run: () => {
                const rows = viewerHeight()
                scrollViewer(rows, (prev) => scrollByLine(prev, -1, viewerLines(), rows))
              },
            },
            {
              id: "filetree.viewer.page.down",
              title: "File viewer: scroll down a page",
              bind: "pagedown",
              run: () => {
                const rows = viewerHeight()
                scrollViewer(rows, (prev) => scrollByPage(prev, 1, viewerLines(), rows))
              },
            },
            {
              id: "filetree.viewer.page.up",
              title: "File viewer: scroll up a page",
              bind: "pageup",
              run: () => {
                const rows = viewerHeight()
                scrollViewer(rows, (prev) => scrollByPage(prev, -1, viewerLines(), rows))
              },
            },
            {
              id: "filetree.viewer.close",
              title: "File viewer: close",
              bind: "escape",
              run: closeViewer,
            },
          ],
          bindings: [
            "filetree.viewer.down",
            "filetree.viewer.up",
            "filetree.viewer.page.down",
            "filetree.viewer.page.up",
            "filetree.viewer.close",
          ],
        }
      })
      trace("layer.registered", { layer: "viewer" })
    } catch (error) {
      trace("layer.threw", { layer: "viewer", error: String(error) })
    }

    return () => {
      unregisterSlot()
      unregisterViewer()
      context.renderer?.off?.("resize", measureTerminal)
    }
  },
})
