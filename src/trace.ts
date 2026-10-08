import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * TEMPORARY diagnostics for the dead-shortcut investigation. Appended to a file
 * because the plugin runs inside the host process where nothing else can see
 * it. Remove once the shortcut works.
 *
 * Location: $OPENCODE_FILETREE_TRACE, else filetrace.jsonl in the temp dir.
 */
const target =
  process.env.OPENCODE_FILETREE_TRACE ?? join(tmpdir(), "filetrace.jsonl")

export function trace(event: string, data: Record<string, unknown> = {}): void {
  try {
    appendFileSync(target, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n")
  } catch {
    // Diagnostics must never break the plugin.
  }
}
