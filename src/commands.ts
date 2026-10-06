import { spawn } from "node:child_process"
import type { DirEntry } from "./fileSystem"
import { moveCursor, toggleExpand, type VisibleNode } from "./FileTree"

export type EditorResult = { ok: true } | { ok: false; error: string }

/**
 * Splits `$EDITOR` into a command and its arguments. Values like
 * "code --wait" or "emacsclient -nw" are common, and `spawn` does not
 * word-split on its own.
 */
export function parseEditorCommand(value: string): { command: string; args: string[] } {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { command: "code", args: [] }
  return { command: parts[0], args: parts.slice(1) }
}

/**
 * Opens a file in the configured editor. Returns a result instead of throwing:
 * a missing editor is a normal condition, not a reason to kill the TUI.
 */
export function spawnEditor(
  entry: DirEntry,
  env: Record<string, string | undefined> = process.env,
): Promise<EditorResult> {
  const { command, args } = parseEditorCommand(env.EDITOR || "code")
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args, entry.path], { detached: true, stdio: "ignore" })
      // ENOENT arrives asynchronously, not as a throw, so a missing editor is
      // only observable here.
      child.once("error", (error) => resolve({ ok: false, error: error.message }))
      child.once("spawn", () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

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
  openInEditor: (entry: DirEntry) => Promise<EditorResult>
}

export type TreeCommands = {
  move: (delta: number) => void
  toggle: () => void
  open: () => Promise<EditorResult | undefined>
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

  const open = (): Promise<EditorResult | undefined> => {
    const entry = deps.currentEntry()
    if (!entry) return Promise.resolve(undefined)
    if (entry.isDirectory) {
      toggle()
      return Promise.resolve(undefined)
    }
    return deps.openInEditor(entry)
  }

  const send = () => {
    const entry = deps.currentEntry()
    if (entry) deps.sendToSession(entry)
  }

  const refresh = () => deps.reload()

  return { move, toggle, open, send, refresh }
}