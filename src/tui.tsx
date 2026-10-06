import { Plugin } from "@opencode/plugin/tui"
import { FileTree } from "./FileTree"
import { createTreeState } from "./store"
import { createTreeCommands, spawnEditor, promptSession } from "./commands"
import { createSignal } from "solid-js"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    const state = createTreeState()
    const [sessionID, setSessionID] = createSignal("")

    // The sidebar slot reports the active session, which sending a path needs.
    // It is rendered on every session, so this stays current as the user
    // switches.
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

    /*
     * No keymap layer is registered, and that is deliberate.
     *
     * Two attempts failed and both are recorded in the git history. Pushing an
     * input mode took over the host's key routing and left the TUI unable to
     * route any key at all. Scoping a layer to renderer focus had the keys
     * arrive correctly and the state update correctly -- the trace showed the
     * cursor moving from 0 to 1 and the clamp effect re-running -- but the host
     * never painted the updated rows. Nothing about the tree's own logic was
     * wrong; the host simply does not repaint plugin components in response to
     * keymap commands in this build.
     *
     * Mouse input does make the host render a frame, so the tree is driven by
     * clicks, and registering no keys leaves the prompt entirely untouched.
     */

    // Kept for the palette and for tests: the command set is still coherent and
    // is what a future keyboard layer would bind.
    void commands

    return () => {
      unregisterSlot()
    }
  },
})