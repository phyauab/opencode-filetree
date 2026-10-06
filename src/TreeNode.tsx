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
  const git = getGitStatusIndicator(props.gitStatus)
  const described = props.gitStatus ? ` ${describeGitStatus(props.gitStatus)}` : ""

  // A single text node with string children. OpenTUI's TextNodeRenderable
  // accepts only strings, TextNodeRenderables, or StyledText, so a nested
  // <text> element here throws.
  return (
    <text bg={props.isSelected ? "blue" : undefined}>
      {`${indent}${chevron}${icon} ${props.entry.name}${git}${described}`}
    </text>
  )
}