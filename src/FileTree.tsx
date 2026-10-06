import { createSignal, createEffect, onCleanup, For, type Component } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { readDir, watch, isGitRepo, getGitStatus, type DirEntry } from "./fileSystem"
import { TreeNode } from "./TreeNode"

// --- Pure navigation logic (exported for testing) ---

export type VisibleNode = {
  entry: DirEntry
  depth: number
}

export function computeVisibleNodes(
  rootEntries: DirEntry[],
  expanded: Set<string>,
  childrenMap?: Map<string, DirEntry[]>,
  depth: number = 0,
  result: VisibleNode[] = [],
): VisibleNode[] {
  for (const entry of rootEntries) {
    result.push({ entry, depth })
    if (entry.isDirectory && expanded.has(entry.path) && childrenMap?.has(entry.path)) {
      computeVisibleNodes(childrenMap.get(entry.path)!, expanded, childrenMap, depth + 1, result)
    }
  }
  return result
}

export function moveCursor(current: number, delta: number, max: number): number {
  return Math.max(0, Math.min(max - 1, current + delta))
}

export function toggleExpand(path: string, expanded: Set<string>): Set<string> {
  const next = new Set(expanded)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

// --- Component ---

type FileTreeProps = {
  cursor?: () => number
  setCursor?: (fn: ((c: number) => number) | number) => void
  expanded?: () => Set<string>
  setExpanded?: (fn: ((prev: Set<string>) => Set<string>) | Set<string>) => void
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const context = usePlugin()
  const [entries, setEntries] = createSignal<DirEntry[]>([])
  const [childrenMap, setChildrenMap] = createSignal<Map<string, DirEntry[]>>(new Map())
  const [localExpanded, setLocalExpanded] = createSignal<Set<string>>(new Set())
  const [localCursor, setLocalCursor] = createSignal(0)
  const [gitStatusMap, setGitStatusMap] = createSignal<Map<string, string>>(new Map())

  const expanded = props.expanded ?? localExpanded
  const setExpanded = props.setExpanded ?? setLocalExpanded
  const cursor = props.cursor ?? localCursor
  const setCursor = props.setCursor ?? setLocalCursor

  createEffect(() => {
    const dir = context.location?.directory
    if (!dir) return

    readDir(dir).then((result) => {
      setEntries(result)
      setExpanded(new Set([dir]))
    })

    isGitRepo(dir).then((isGit) => {
      if (isGit) getGitStatus(dir).then(setGitStatusMap)
    })

    const unwatch = watch(dir, () => {
      readDir(dir).then(setEntries)
      isGitRepo(dir).then((isGit) => {
        if (isGit) getGitStatus(dir).then(setGitStatusMap)
      })
    })

    onCleanup(unwatch)
  })

  createEffect(() => {
    const currentExpanded = expanded()
    for (const path of currentExpanded) {
      if (!childrenMap().has(path)) {
        readDir(path).then((children) => {
          setChildrenMap((prev) => {
            const next = new Map(prev)
            next.set(path, children)
            return next
          })
        })
      }
    }
  })

  const visibleNodes = () => computeVisibleNodes(entries(), expanded(), childrenMap())

  return (
    <box>
      <For each={visibleNodes()}>
        {(node, index) => (
          <TreeNode
            entry={node.entry}
            depth={node.depth}
            isSelected={index() === cursor()}
            isExpanded={expanded().has(node.entry.path)}
            gitStatus={gitStatusMap().get(node.entry.path)}
          />
        )}
      </For>
    </box>
  )
}
