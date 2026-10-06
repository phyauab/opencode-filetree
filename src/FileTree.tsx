import { createEffect, onCleanup, For, type Component } from "solid-js"
import { usePlugin } from "@opencode/plugin/tui"
import { readDir, watch, isGitRepo, getGitStatus, type DirEntry } from "./fileSystem"
import { TreeNode } from "./TreeNode"
import type { TreeState } from "./store"

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
  state: TreeState
}

export const FileTree: Component<FileTreeProps> = (props) => {
  const context = usePlugin()
  const state = props.state

  createEffect(() => {
    const dir = context.location?.directory
    if (!dir) return

    readDir(dir).then((result) => {
      state.setEntries(result)
      state.setExpanded(new Set([dir]))
    })

    isGitRepo(dir).then((isGit) => {
      if (isGit) getGitStatus(dir).then(state.setGitStatusMap)
    })

    const unwatch = watch(dir, () => {
      readDir(dir).then(state.setEntries)
      isGitRepo(dir).then((isGit) => {
        if (isGit) getGitStatus(dir).then(state.setGitStatusMap)
      })
    })

    onCleanup(unwatch)
  })

  createEffect(() => {
    const currentExpanded = state.expanded()
    for (const path of currentExpanded) {
      if (!state.childrenMap().has(path)) {
        readDir(path).then((children) => {
          state.setChildrenMap((prev) => {
            const next = new Map(prev)
            next.set(path, children)
            return next
          })
        })
      }
    }
  })

  return (
    <box>
      <For each={state.visibleNodes()}>
        {(node, index) => (
          <TreeNode
            entry={node.entry}
            depth={node.depth}
            isSelected={index() === state.cursor()}
            isExpanded={state.expanded().has(node.entry.path)}
            gitStatus={state.gitStatusMap().get(node.entry.path)}
          />
        )}
      </For>
    </box>
  )
}
