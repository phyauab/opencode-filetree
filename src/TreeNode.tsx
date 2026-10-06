import type { DirEntry } from "./fileSystem"
import { getFileIcon, getGitStatusIndicator } from "./icons"

type TreeNodeProps = {
  entry: DirEntry
  depth: number
  isSelected: boolean
  isExpanded: boolean
  gitStatus: string | undefined
}

export function TreeNode(props: TreeNodeProps) {
  const indent = "  ".repeat(props.depth)
  const chevron = props.entry.isDirectory ? (props.isExpanded ? "▾ " : "▸ ") : "  "
  const icon = getFileIcon(props.entry.name, props.entry.isDirectory)
  const gitIndicator = getGitStatusIndicator(props.gitStatus)
  const fg = props.isSelected ? "white" : undefined

  return (
    <text fg={fg}>
      {indent}
      {chevron}
      {icon} {props.entry.name}
      {gitIndicator}
    </text>
  )
}
