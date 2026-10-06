import { spawn } from "node:child_process"
import type { DirEntry } from "./fileSystem"
import { moveCursor, toggleExpand, type VisibleNode } from "./FileTree"

/**
 * The state and callbacks the file tree commands operate on. Kept separate from
 * the plugin entry so the keymap behaviour can be exercised without a TUI.
 */
export type TreeCommandsDeps = {
  visibleNodes: () => VisibleNode[]
  currentEntry: () => DirEntry | undefined
  setCursor: (fn: (c: number) => number) => void
  setExpanded: (fn: (prev: Set<string>) => Set<string>) => void
  reset: () => void
  sendToSession: (entry: DirEntry) => void
  openInEditor: (entry: DirEntry) => void
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
  }

  const open = () => {
    const entry = deps.currentEntry()
    if (!entry) return
    if (entry.isDirectory) return toggle()
    deps.openInEditor(entry)
  }

  const send = () => {
    const entry = deps.currentEntry()
    if (entry) deps.sendToSession(entry)
  }

  const refresh = () => deps.reset()

  return { move, toggle, open, send, refresh }
}

/** Spawns the user's editor detached from the TUI process. */
export function spawnEditor(entry: DirEntry, env: NodeJS.ProcessEnv = process.env) {
  const editor = env.EDITOR || "code"
  spawn(editor, [entry.path], { detached: true, stdio: "ignore" }).unref()
}