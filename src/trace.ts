import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Click diagnostics, appended to a file so they can be read after a session.
 *
 * The plugin runs inside the host process, so a file is the only way to see
 * what actually reached it. Earlier keyboard traces settled that keys arrived and
 * state updated but nothing repainted; the open question for the mouse is whether
 * any click reaches the sidebar at all.
 *
 * Location: $OPENCODE_FILETREE_TRACE, else filetree-clicks.jsonl in the temp dir.
 */
const target =
  process.env.OPENCODE_FILETREE_TRACE ?? join(tmpdir(), "filetree-clicks.jsonl")

export function traceClick(event: string, data: Record<string, unknown> = {}): void {
  try {
    appendFileSync(target, JSON.stringify({ t: Date.now(), event, ...data }) + "\n")
  } catch {
    // Diagnostics must never break the plugin.
  }
}