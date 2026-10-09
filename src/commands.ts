import type { DirEntry } from "./fileSystem"
import { moveCursor, toggleExpand, type VisibleNode } from "./treeLogic"

/** The slice of the OpenCode client the plugin uses. */
export type PromptClient = {
  session: {
    prompt: (input: { sessionID: string; text: string }) => Promise<unknown>
  }
}

export type SendResult = { ok: true } | { ok: false; error: string }

/**
 * Sends a "Read <path>" prompt to a session, converting any failure into a
 * value. A rejecting prompt must never become an unhandled rejection, which
 * would terminate the TUI.
 */
export async function promptSession(
  client: PromptClient,
  sessionID: string | undefined,
  entry: DirEntry,
): Promise<SendResult> {
  if (!sessionID) return { ok: false, error: "no active session" }
  try {
    await client.session.prompt({ sessionID, text: `Read ${entry.path}` })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/*
 * The external-editor path is gone, by request.
 *
 * `parseEditorCommand`, `spawnEditor` and `EditorResult` used to live here,
 * along with the `node:child_process` import and the tests over them, and
 * `open()` returned a promise because spawning one did. Reading a file in the
 * terminal (`src/viewer/FileViewer.tsx`, reached through
 * `TreeCommandsDeps.openInViewer`) replaced all of it: `enter` now shows the
 * file in `session.panel`, which is a keypress rather than a process the TUI
 * loses track of. Retrieve the deleted code from git history rather than
 * re-adding it blind -- a plugin that shells out to `$EDITOR` gives away the
 * terminal to another process and cannot tell when the user comes back.
 */

/**
 * The state and callbacks the file tree commands operate on. Kept separate from
 * the plugin entry so the keymap behaviour can be exercised without a TUI.
 */
export type TreeCommandsDeps = {
  visibleNodes: () => VisibleNode[]
  currentEntry: () => DirEntry | undefined
  setCursor: (fn: (c: number) => number) => void
  setExpanded: (fn: (prev: Set<string>) => Set<string>) => void
  clampCursor: () => void
  reload: () => void
  sendToSession: (entry: DirEntry) => void
  /** Shows a file in the plugin's own panel; the host owns the presentation. */
  openInViewer: (entry: DirEntry) => void
}

export type TreeCommands = {
  move: (delta: number) => void
  toggle: () => void
  open: () => void
  send: () => void
  refresh: () => void
}

/** Builds the pure command handlers the keymap binds to. */
export function createTreeCommands(deps: TreeCommandsDeps): TreeCommands {
  const move = (delta: number) =>
    deps.setCursor((c) => moveCursor(c, delta, deps.visibleNodes().length))

  const toggle = () => {
    const entry = deps.currentEntry()
    if (entry?.isDirectory) deps.setExpanded((prev) => toggleExpand(entry.path, prev))
    deps.clampCursor()
  }

  /*
   * A folder still folds: `enter` on a directory has to keep toggling, and a
   * viewer that opened a folder would show the reader's own refusal to read one
   * instead of the tree they were navigating.
   */
  const open = (): void => {
    const entry = deps.currentEntry()
    if (!entry) return
    if (entry.isDirectory) {
      toggle()
      return
    }
    deps.openInViewer(entry)
  }

  const send = () => {
    const entry = deps.currentEntry()
    if (entry) deps.sendToSession(entry)
  }

  const refresh = () => deps.reload()

  return { move, toggle, open, send, refresh }
}