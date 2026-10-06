import { describe, it, expect } from "bun:test"
import { createTreeCommands } from "./commands"
import { createTreeState } from "./store"

function setup() {
  const state = createTreeState()
  const sent: string[] = []
  const opened: string[] = []
  let resetCount = 0

  const commands = createTreeCommands({
    visibleNodes: state.visibleNodes,
    currentEntry: state.currentEntry,
    setCursor: state.setCursor,
    setExpanded: state.setExpanded,
    reset: () => {
      resetCount++
    },
    sendToSession: (entry) => sent.push(entry.path),
    openInEditor: (entry) => opened.push(entry.path),
  })

  return { state, commands, sent, opened, resetCount: () => resetCount }
}

const SRC = { name: "src", path: "/proj/src", isDirectory: true }
const INDEX = { name: "index.ts", path: "/proj/src/index.ts", isDirectory: false }
const README = { name: "README.md", path: "/proj/README.md", isDirectory: false }

describe("tree commands", () => {
  it("move clamps at both ends of the tree", () => {
    const { state, commands } = setup()
    state.setEntries([SRC, README])

    commands.move(1)
    expect(state.cursor()).toBe(1)
    commands.move(1)
    expect(state.cursor()).toBe(1)
    commands.move(-1)
    commands.move(-1)
    expect(state.cursor()).toBe(0)
  })

  it("move on an empty tree leaves the cursor at 0", () => {
    const { state, commands } = setup()
    commands.move(1)
    expect(state.cursor()).toBe(0)
    commands.move(-1)
    expect(state.cursor()).toBe(0)
  })

  it("toggle expands a collapsed directory", () => {
    const { state, commands } = setup()
    state.setEntries([SRC])
    state.setChildrenMap(new Map([["/proj/src", [INDEX]]]))

    commands.toggle()
    expect(state.expanded().has("/proj/src")).toBe(true)
    expect(state.visibleNodes()).toHaveLength(2)
  })

  it("toggle collapses an expanded directory", () => {
    const { state, commands } = setup()
    state.setEntries([SRC])
    state.setChildrenMap(new Map([["/proj/src", [INDEX]]]))
    state.setExpanded(new Set(["/proj/src"]))

    commands.toggle()
    expect(state.expanded().has("/proj/src")).toBe(false)
    expect(state.visibleNodes()).toHaveLength(1)
  })

  it("toggle does nothing on a file", () => {
    const { state, commands } = setup()
    state.setEntries([README])
    state.setCursor(0)
    commands.toggle()
    expect(state.expanded().size).toBe(0)
  })

  it("open opens a file in the editor", () => {
    const { state, commands, opened } = setup()
    state.setEntries([SRC, INDEX])
    state.setCursor(1)
    commands.open()
    expect(opened).toEqual(["/proj/src/index.ts"])
  })

  it("open expands a directory instead of opening it", () => {
    const { state, commands, opened } = setup()
    state.setEntries([SRC])
    state.setChildrenMap(new Map([["/proj/src", [INDEX]]]))
    state.setCursor(0)

    commands.open()
    expect(opened).toEqual([])
    expect(state.expanded().has("/proj/src")).toBe(true)
  })

  it("open does nothing on an empty tree", () => {
    const { commands, opened } = setup()
    commands.open()
    expect(opened).toEqual([])
  })

  it("send sends the selected entry to the session", () => {
    const { state, commands, sent } = setup()
    state.setEntries([SRC, INDEX])
    state.setCursor(1)
    commands.send()
    expect(sent).toEqual(["/proj/src/index.ts"])
  })

  it("send works on directories too", () => {
    const { state, commands, sent } = setup()
    state.setEntries([SRC])
    state.setCursor(0)
    commands.send()
    expect(sent).toEqual(["/proj/src"])
  })

  it("refresh resets the tree", () => {
    const { commands, resetCount } = setup()
    commands.refresh()
    expect(resetCount()).toBe(1)
  })
})