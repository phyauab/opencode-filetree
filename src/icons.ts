const EXTENSION_ICONS: Record<string, string> = {
  ts: "📘",
  tsx: "📘",
  js: "📒",
  jsx: "📒",
  json: "📋",
  md: "📝",
  css: "🎨",
  html: "🌐",
  png: "🖼️",
  jpg: "🖼️",
  svg: "🖼️",
  gitignore: "🔒",
  env: "🔒",
}

/** Directories that would flood the tree with noise or build output. */
const HIDDEN_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
])

/**
 * True for entries the tree hides by default: dotfiles, and directories that
 * hold generated or vendored content.
 */
export function isHidden(name: string, isDirectory: boolean): boolean {
  if (name === "." || name === "..") return true
  if (!isDirectory) return false
  if (HIDDEN_DIRECTORIES.has(name)) return true
  // Keep dotfiles like .gitignore and .env visible; hide dot-directories.
  return name.startsWith(".")
}

export function getFileIcon(name: string, isDirectory: boolean): string {
  if (isDirectory) return "📁"
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_ICONS[ext] ?? "📄"
}

const GIT_LABELS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  "?": "untracked",
}

/** Short marker shown after a file name, e.g. " [M]" for modified. */
export function getGitStatusIndicator(status: string | undefined): string {
  if (!status) return ""
  if (status === "?") return " [?]"
  if (status === "M") return " [M]"
  if (status === "A") return " [A]"
  if (status === "D") return " [D]"
  return ` [${status}]`
}

/**
 * Row color for a git status. The bracket marker was too quiet to scan by in a
 * long tree, so the row itself carries the change:
 * yellow for edits, green for additions, red for removals, cyan for new files.
 * A clean or unrecognized row keeps the theme default.
 */
const GIT_STATUS_COLORS: Record<string, string> = {
  M: "yellow",
  A: "green",
  D: "red",
  R: "magenta",
  C: "cyan",
  U: "red",
  "?": "cyan",
}

export function gitStatusColor(status: string | undefined): string | undefined {
  if (!status) return undefined
  return GIT_STATUS_COLORS[status]
}

/** Longer description of a git status code, for tooltips and tests. */
export function describeGitStatus(status: string | undefined): string {
  if (!status) return "clean"
  return GIT_LABELS[status] ?? status
}