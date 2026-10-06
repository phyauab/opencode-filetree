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

export function getFileIcon(name: string, isDirectory: boolean): string {
  if (isDirectory) return "📁"
  const ext = name.split(".").pop()?.toLowerCase() ?? ""
  return EXTENSION_ICONS[ext] ?? "📄"
}

export function getGitStatusIndicator(status: string | undefined): string {
  if (!status) return ""
  if (status === "M") return " [M]"
  if (status === "A") return " [A]"
  if (status === "?") return " [?]"
  return ` [${status}]`
}
