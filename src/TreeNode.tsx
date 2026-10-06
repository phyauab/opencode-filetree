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

  // The cursor is a character in the text, not a background colour. `bg` on a
  // <text> does not repaint when the selection moves: state updated correctly
  // but the row looked unchanged until something else forced a redraw. Text
  // content always repaints, so the marker cannot go stale.
  const marker = props.isSelected ? "› " : "  "

  // A single text node with string children. OpenTUI's TextNodeRenderable
  // accepts only strings, TextNodeRenderables, or StyledText, so a nested
  // <text> element here throws.
  return (
    <text fg={props.isSelected ? "cyan" : undefined} bg={props.isSelected ? "blue" : undefined}>
      {`${marker}${indent}${chevron}${icon} ${props.entry.name}${git}${described}`}
    </text>
  )
}