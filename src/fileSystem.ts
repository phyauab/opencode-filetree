import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { watch as fsWatch } from "node:fs"
import { join, resolve } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type DirEntry = {
  name: string
  path: string
  isDirectory: boolean
}

export async function readDir(path: string): Promise<DirEntry[]> {
  const items = await readdir(path, { withFileTypes: true })
  const entries: DirEntry[] = items.map((item) => ({
    name: item.name,
    path: join(path, item.name),
    isDirectory: item.isDirectory(),
  }))
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

export function watch(path: string, callback: () => void): () => void {
  const watcher = fsWatch(path, { recursive: true }, callback)
  return () => watcher.close()
}

export async function isGitRepo(path: string): Promise<boolean> {
  return existsSync(join(path, ".git"))
}

export async function getGitStatus(repoPath: string): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>()
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: repoPath })
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue
      const status = line.slice(0, 2).trim()
      const filePath = line.slice(3).trim()
      statusMap.set(filePath, status)
    }
  } catch {
    // Not a git repo or git not available — return empty map
  }
  return statusMap
}

export function resolvePath(base: string, relative: string): string {
  return resolve(base, relative)
}
