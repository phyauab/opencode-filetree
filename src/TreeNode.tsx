import type { DirEntry } from "./fileSystem"
import { getFileIcon, getGitStatusIndicator, gitStatusColor, describeGitStatus } from "./icons"

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

  // The selected row wears cyan on blue and nothing else. The `›` marker that
  // used to carry the selection is gone: it earned its keep when only text
  // content repainted, the rows now rebuild on every visible change (cursor
  // included), and it cost two columns of a 42-column sidebar.

  // Changed rows wear the git status color; the selection's cyan wins so the
  // cursor stays unmistakable on top of them. Clean rows pass `undefined` and
  // keep the theme default.
  const fg = props.isSelected ? "cyan" : gitStatusColor(props.gitStatus)

  /*
   * One row per entry, always. A wrapped name breaks that shape -- the second
   * line reads as another entry, and the viewport's row-per-index math stops
   * matching the screen. `wrapMode="none"` refuses the wrap and `truncate` cuts
   * the row at the renderable's own width, so it adapts by itself: a 42-column
   * sidebar and a wide panel both get one line per row.
   *
   * A single text node with string children. OpenTUI's TextNodeRenderable
   * accepts only strings, TextNodeRenderables, or StyledText, so a nested
   * <text> element here throws.
   */
  return (
    <text fg={fg} bg={props.isSelected ? "blue" : undefined} wrapMode="none" truncate>
      {`${indent}${chevron}${icon} ${props.entry.name}${git}${described}`}
    </text>
  )
}