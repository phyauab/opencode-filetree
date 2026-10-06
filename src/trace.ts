import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Diagnostics for the keymap, appended to a file so the plugin's real behaviour
 * can be read after a session.
 *
 * The plugin runs inside the host process, so this is the only way to see what
 * the host's keymap resolved and which commands actually ran. Every earlier
 * attempt to diagnose this from the outside was wrong; the log is the ground
 * truth. Writes only happen when the observed state changes.
 *
 * Location: $OPENCODE_FILETREE_TRACE, else filetree-trace.jsonl in the temp dir.
 */
const target = process.env.OPENCODE_FILETREE_TRACE ?? join(tmpdir(), "filetree-trace.jsonl")

export function trace(event: string, data: Record<string, unknown> = {}): void {
  try {
    appendFileSync(target, JSON.stringify({ t: Date.now(), event, ...data }) + "\n")
  } catch {
    // Diagnostics must never break the plugin.
  }
}

/** True when OPENCODE_FILETREE_FORCE_ACTIVE is set, for headless probing. */
export const forceActive = process.env.OPENCODE_FILETREE_FORCE_ACTIVE === "1"