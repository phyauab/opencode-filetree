import { Plugin } from "@opencode/plugin/tui"
import { FileTree, moveCursor, toggleExpand } from "./FileTree"
import { createTreeState } from "./store"
import { spawn } from "node:child_process"
import { createSignal } from "solid-js"
import type { DirEntry } from "./fileSystem"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    const state = createTreeState()
    const [sessionID, setSessionID] = createSignal<string>("")

    // Register sidebar slot
    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID: sid }) => {
        if (sid) setSessionID(sid)
        return <FileTree state={state} />
      },
    })

    // Helper: get the entry at the current cursor position
    const getSelectedEntry = () => {
      const nodes = state.visibleNodes()
      const idx = state.cursor()
      return idx >= 0 && idx < nodes.length ? nodes[idx].entry : undefined
    }

    // Register keymap for navigation
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "filetree.up",
          title: "Move up",
          bind: "up",
          run: () => {
            state.setCursor((c) => moveCursor(c, -1, state.visibleNodes().length))
          },
        },
        {
          id: "filetree.down",
          title: "Move down",
          bind: "down",
          run: () => {
            state.setCursor((c) => moveCursor(c, 1, state.visibleNodes().length))
          },
        },
        {
          id: "filetree.expand",
          title: "Expand folder",
          bind: "right",
          run: () => {
            const entry = getSelectedEntry()
            if (entry?.isDirectory) {
              state.setExpanded((prev) => toggleExpand(entry.path, prev))
            }
          },
        },
        {
          id: "filetree.collapse",
          title: "Collapse folder",
          bind: "left",
          run: () => {
            const entry = getSelectedEntry()
            if (entry?.isDirectory) {
              state.setExpanded((prev) => toggleExpand(entry.path, prev))
            }
          },
        },
        {
          id: "filetree.open",
          title: "Open file in editor",
          bind: "enter",
          run: () => {
            const entry = getSelectedEntry()
            if (entry && !entry.isDirectory) {
              const editor = process.env.EDITOR || "code"
              spawn(editor, [entry.path], { detached: true, stdio: "ignore" }).unref()
            } else if (entry?.isDirectory) {
              state.setExpanded((prev) => toggleExpand(entry.path, prev))
            }
          },
        },
        {
          id: "filetree.send-to-session",
          title: "Send file to session",
          bind: "ctrl+o",
          run: () => {
            const entry = getSelectedEntry()
            if (entry && sessionID()) {
              context.client.session.prompt({
                sessionID: sessionID(),
                text: `Read ${entry.path}`,
              })
            }
          },
        },
        {
          id: "filetree.refresh",
          title: "Refresh tree",
          bind: "r",
          run: () => {
            const dir = context.location?.directory
            if (dir) {
              state.setEntries([])
              state.setExpanded(new Set<string>())
              state.setChildrenMap(new Map<string, DirEntry[]>())
            }
          },
        },
      ],
    }))

    return () => {
      // Cleanup
    }
  },
})
