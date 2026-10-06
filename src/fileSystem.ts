import { readdir, stat } from "node:fs/promises"
import { existsSync, readdirSync as nativeReaddirSync, statSync } from "node:fs"
import { watch as fsWatch } from "node:fs"
import { join, resolve, dirname, basename } from "node:path"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type DirEntry = {
  name: string
  path: string
  isDirectory: boolean
}

/** True for a symlink that resolves to a directory; false for broken links. */
async function resolvesToDirectory(fullPath: string): Promise<boolean> {
  try {
    return (await stat(fullPath)).isDirectory()
  } catch {
    return false
  }
}

/** Sorts folders first, then files, alphabetically within each group. */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

/** Symlinked directory check that never awaits, for the sync path. */
function resolvesToDirectorySync(fullPath: string): boolean {
  try {
    return statSync(fullPath).isDirectory()
  } catch {
    return false
  }
}

/**
 * Synchronous directory read.
 *
 * The TUI plugin runtime does not reliably run promise continuations, so the
 * tree must not depend on them: this version settles before the frame is
 * painted and needs no microtask turn.
 */
export function readDirSync(path: string): DirEntry[] {
  const items = nativeReaddirSync(path, { withFileTypes: true })
  const entries: DirEntry[] = items.map((item) => {
    const fullPath = join(path, item.name)
    const isDirectory = item.isDirectory()
      ? true
      : item.isSymbolicLink()
        ? resolvesToDirectorySync(fullPath)
        : false
    return { name: item.name, path: fullPath, isDirectory }
  })
  return sortEntries(entries)
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const items = await readdir(path, { withFileTypes: true })
  const entries: DirEntry[] = await Promise.all(
    items.map(async (item) => {
      const fullPath = join(path, item.name)
      // Dirent.isDirectory() is false for symlinks; stat() follows them.
      const isDirectory = item.isDirectory()
        ? true
        : item.isSymbolicLink()
          ? await resolvesToDirectory(fullPath)
          : false
      return { name: item.name, path: fullPath, isDirectory }
    }),
  )
  return sortEntries(entries)
}

export function watch(path: string, callback: () => void): () => void {
  try {
    const watcher = fsWatch(path, { recursive: true }, callback)
    return () => watcher.close()
  } catch {
    // Recursive watch is unsupported on some platforms or for missing paths.
    return () => {}
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  return existsSync(join(path, ".git"))
}

export function isGitRepoSync(path: string): boolean {
  return existsSync(join(path, ".git"))
}

/**
 * Synchronous git status. Same reason as readDirSync: the TUI runtime does not
 * reliably drain promise continuations, and a `git status` fork costs only a
 * few milliseconds.
 */
export function getGitStatusSync(repoPath: string): Map<string, string> {
  if (!isGitRepoSync(repoPath)) return new Map()
  try {
    const stdout = execFileSync(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain", "-z"],
      { cwd: repoPath, timeout: 5000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
    )
    return parseGitStatus(repoPath, stdout)
  } catch {
    // Not a git repo, git unavailable, or the command timed out.
    return new Map()
  }
}

/**
 * Parses `git status --porcelain` output into absolute-path keys.
 * Handles both newline- and NUL-separated output, and unquotes C-quoted paths.
 */
export function parseGitStatus(repoRoot: string, output: string): Map<string, string> {
  const status = new Map<string, string>()
  // -z output is NUL-separated; newline-separated output reaches here in tests
  // and from any caller that omits -z.
  const lines = output.includes("\0") ? output.split("\0") : output.split("\n")
  for (const record of lines) {
    const line = record.trimEnd()
    if (!line || line.length < 3) continue

    const code = line.slice(0, 2)
    let filePath = line.slice(3).trim()

    // Rename records read "old -> new"; the new path is the one on disk now.
    const arrow = filePath.indexOf(" -> ")
    if (arrow !== -1) filePath = filePath.slice(arrow + 4)

    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = unquoteCPath(filePath)
    }

    // Porcelain has two status columns: index then worktree. Take whichever is
    // populated so " M" reads as modified and "M " as staged.
    const first = code[0] === " " ? code[1] : code[0]
    if (!first || first === " ") continue
    // `??` means untracked; the indicator uses a single `?`.
    status.set(resolve(repoRoot, filePath), first === "?" ? "?" : first)
  }
  return status
}

/** Decodes git's C-style octal escapes, e.g. "caf\303\251". */
function unquoteCPath(value: string): string {
  const inner = value.slice(1, -1)
  return inner.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(parseInt(octal, 8)),
  )
}

export async function getGitStatus(repoPath: string): Promise<Map<string, string>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "core.quotepath=false", "status", "--porcelain", "-z"],
      { cwd: repoPath, timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
    )
    return parseGitStatus(repoPath, stdout)
  } catch {
    // Not a git repo, git unavailable, or the command timed out.
    return new Map()
  }
}

export function resolvePath(base: string, relative: string): string {
  return resolve(base, relative)
}