import { Plugin } from "@opencode/plugin/tui"
import { FileTree, moveCursor, toggleExpand } from "./FileTree"
import { createSignal } from "solid-js"

export default Plugin.define({
  id: "filetree",
  setup(context) {
    const [cursor, setCursor] = createSignal(0)
    const [expanded, setExpanded] = createSignal<Set<string>>(new Set())

    // Register sidebar slot
    context.ui.slot({
      append: "sidebar.content",
      render: () => <FileTree cursor={cursor} setCursor={setCursor} expanded={expanded} setExpanded={setExpanded} />,
    })

    // Register keymap for navigation
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "filetree.up",
          title: "Move up",
          bind: "up",
          run: () => {
            setCursor((c) => moveCursor(c, -1, 1000))
          },
        },
        {
          id: "filetree.down",
          title: "Move down",
          bind: "down",
          run: () => {
            setCursor((c) => moveCursor(c, 1, 1000))
          },
        },
        {
          id: "filetree.expand",
          title: "Expand folder",
          bind: "right",
          run: () => {
            // TODO: expand folder at cursor
          },
        },
        {
          id: "filetree.collapse",
          title: "Collapse folder",
          bind: "left",
          run: () => {
            // TODO: collapse folder at cursor
          },
        },
        {
          id: "filetree.open",
          title: "Open file in editor",
          bind: "enter",
          run: () => {
            // TODO: open file at cursor in $EDITOR
          },
        },
        {
          id: "filetree.send-to-session",
          title: "Send file to session",
          bind: "ctrl+o",
          run: () => {
            // TODO: send file path to session
          },
        },
        {
          id: "filetree.refresh",
          title: "Refresh tree",
          bind: "r",
          run: () => {
            // TODO: refresh tree
          },
        },
      ],
    }))

    return () => {
      // Cleanup
    }
  },
})
