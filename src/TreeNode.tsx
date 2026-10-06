import type { DirEntry } from "./fileSystem"
import { getFileIcon, getGitStatusIndicator, describeGitStatus } from "./icons"

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

  return (
    <text bg={props.isSelected ? "blue" : undefined}>
      {indent}
      {chevron}
      {icon} {props.entry.name}
      {gitIndicator}
      <text fg="dim">{props.gitStatus ? ` ${describeGitStatus(props.gitStatus)}` : ""}</text>
    </text>
  )
}