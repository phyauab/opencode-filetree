import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Diagnostics for the shortcut investigation. Appended to a file because the
 * plugin runs inside the host process where nothing else can see it.
 *
 * Off unless $OPENCODE_FILETREE_TRACE is set. It was unconditional for a while
 * and that cost a syscall on every nav keypress, click, focus change and scroll
 * in the shipping path — a real responsiveness cost for a diagnostic nobody was
 * reading. Gating it keeps the instrument and makes normal use zero-I/O.
 *
 * Location: $OPENCODE_FILETREE_TRACE, else filetrace.jsonl in the temp dir.
 */
const enabled = process.env.OPENCODE_FILETREE_TRACE !== undefined
const target =
  process.env.OPENCODE_FILETREE_TRACE ?? join(tmpdir(), "filetrace.jsonl")

export function trace(event: string, data: Record<string, unknown> = {}): void {
  if (!enabled) return
  try {
    appendFileSync(target, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n")
  } catch {
    // Diagnostics must never break the plugin.
  }
}
