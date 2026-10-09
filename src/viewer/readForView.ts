import { openSync, readSync, closeSync, statSync } from "node:fs"
import { describeReadError } from "../fileTreeData"

/**
 * Caps for a single view of a file.
 *
 * The byte cap exists because readFileSync has no length argument -- it loads
 * the whole file, so opening a 400MB log would push all of it into the
 * plugin's memory on a keypress. The line cap exists because 200k short lines
 * cost more to lay out and draw than the reader is worth.
 */
export const MAX_VIEW_BYTES = 512 * 1024
export const MAX_VIEW_LINES = 2000

export type ViewFile =
  | { kind: "text"; path: string; lines: string[]; truncated: boolean; totalLines: number }
  | { kind: "binary"; path: string }
  | { kind: "error"; path: string; reason: string }

/** Reads at most `maxBytes` from the start of `path`, closing the handle even on a failed read. */
function readCappedBytes(path: string, maxBytes: number): Buffer {
  const handle = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(maxBytes)
    return buffer.subarray(0, readSync(handle, buffer, 0, maxBytes, 0))
  } finally {
    closeSync(handle)
  }
}

/**
 * Falls back to the default for a limit that is not a positive number.
 *
 * A cap of zero would render every file as a single empty line while claiming
 * truncation, which is indistinguishable from a bug in the caller.
 */
function limit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Drops the single CR that pairs with a line terminator.
 *
 * This repo's working tree is CRLF -- `git ls-files --eol` reports w/crlf on
 * FileTree.tsx, TreeNode.tsx and tui.tsx -- so most files the viewer opens here
 * end their lines with "\r\n". Trimming here gives the CR one owner instead of
 * N consumers each having to remember: left in the line it reaches the gutter
 * as a stray character, and it also survives into the last highlight span of
 * every line, where the highlighter regroups spans by splitting their text on
 * "\n" and the CR corrupts the colour boundaries too. Only the terminator's CR
 * goes, so a line whose content ends in a CR keeps it.
 */
function stripTerminatorCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line
}

/**
 * Reads a file for display, converting every failure into a value.
 *
 * Synchronous throughout, for the reason `readDirSync` exists: the TUI plugin
 * runtime does not reliably run promise continuations, so a read that settles
 * on a later tick would paint an empty viewer and never fill it in.
 *
 * Never throws. The viewer is opened from a keypress inside a panel, and a
 * throw here would leave the user with a blank panel and a stack trace in the
 * log rather than a sentence explaining what went wrong.
 */
export function readForView(path: string, limits: { maxBytes?: number; maxLines?: number } = {}): ViewFile {
  const maxBytes = limit(limits.maxBytes, MAX_VIEW_BYTES)
  const maxLines = limit(limits.maxLines, MAX_VIEW_LINES)
  try {
    const stats = statSync(path)
    // Opening a directory succeeds on Linux and only fails at the read, with a
    // platform-specific message; asking stat first gives every platform the
    // same answer.
    if (stats.isDirectory()) return { kind: "error", path, reason: "is a directory" }

    const bytes = readCappedBytes(path, maxBytes)
    // Only the bytes actually read can be judged, so a NUL past the byte cap
    // does not turn a readable text prefix into "binary". One NUL is enough:
    // no source file the viewer is meant to show contains one.
    if (bytes.includes(0)) return { kind: "binary", path }

    // A byte cap can land in the middle of a multi-byte character; the tail of
    // it decodes to U+FFFD, which is visible and honest about the cut.
    const text = bytes.toString("utf8")
    const lines = text.split("\n").map(stripTerminatorCr)
    // A newline terminates a line rather than opening a new one, so the empty
    // element a trailing "\n" produces is not a line of the file. The test is
    // on the raw text, not on the trimmed lines, so "a\r\n" still loses the
    // element the final newline produced. Interior blank lines are kept: they
    // are content.
    if (text.endsWith("\n")) lines.pop()

    // Compared against what was read, not against the cap: the cap is routinely
    // larger than the file, and the notice has to mean that content was lost.
    const droppedBytes = stats.size > bytes.length
    const droppedLines = lines.length > maxLines
    const kept = droppedLines ? lines.slice(0, maxLines) : lines

    // totalLines counts the lines handed over, not the file's real line count:
    // the rest of the file was never read, and a wrong number in the header is
    // worse than an honest "first 2000 lines".
    return { kind: "text", path, lines: kept, truncated: droppedBytes || droppedLines, totalLines: kept.length }
  } catch (error) {
    return { kind: "error", path, reason: describeReadError(error) }
  }
}