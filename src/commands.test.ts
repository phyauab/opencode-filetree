import { describe, it, expect } from "bun:test"
import {
  createTreeCommands,
  parseEditorCommand,
  spawnEditor,
  promptSession,
} from "./commands"
import { createTreeState } from "./store"

function setup(options: { editorFails?: boolean } = {}) {
  const state = createTreeState()
  const sent: string[] = []
  const opened: string[] = []
  let reloadCount = 0

  const commands = createTreeCommands({
    visibleNodes: state.visibleNodes,
    currentEntry: state.currentEntry,
    setCursor: state.setCursor,
    setExpanded: state.setExpanded,
    clampCursor: state.clampCursor,
    reload: () => {
      reloadCount++
    },
    sendToSession: (entry) => sent.push(entry.path),
    openInEditor: async (entry) => {
      opened.push(entry.path)
      return options.editorFails ? { ok: false, error: "ENOENT" } : { ok: true }
    },
  })

  return {
    state,
    commands,
    sent,
    opened,
    reloadCount: () => reloadCount,
  }
}

const SRC = { name: "src", path: "/proj/src", isDirectory: true }
const INDEX = { name: "index.ts", path: "/proj/src/index.ts", isDirectory: false }
const README = { name: "README.md", path: "/proj/README.md", isDirectory: false }

describe("parseEditorCommand", () => {
  it("splits a command with arguments", () => {
    expect(parseEditorCommand("code --wait")).toEqual({ command: "code", args: ["--wait"] })
  })

  it("handles a bare command", () => {
    expect(parseEditorCommand("vim")).toEqual({ command: "vim", args: [] })
  })

  it("falls back to code for an empty value", () => {
    expect(parseEditorCommand("   ")).toEqual({ command: "code", args: [] })
  })
})

describe("spawnEditor", () => {
  it("returns ok for a runnable editor", async () => {
    // A real, always-present executable stands in for the user's editor.
    const result = await spawnEditor(INDEX, { EDITOR: "cmd" })
    expect(result.ok).toBe(true)
  })

  it("reports a missing editor instead of throwing", async () => {
    const result = await spawnEditor(INDEX, { EDITOR: "definitely-not-a-real-editor-xyz" })
    expect(result.ok).toBe(false)
  })

  it("does not throw when $EDITOR is unset", async () => {
    expect((await spawnEditor(INDEX, {})).ok).toBe(true)
  })
})

describe("promptSession", () => {
  const client = (impl: (input: { sessionID: string; text: string }) => Promise<unknown>) => ({
    session: { prompt: impl },
  })

  it("sends a Read prompt for the entry", async () => {
    const sent: any[] = []
    const result = await promptSession(
      client((input) => {
        sent.push(input)
        return Promise.resolve({})
      }),
      "ses_1",
      INDEX,
    )
    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([{ sessionID: "ses_1", text: "Read /proj/src/index.ts" }])
  })

  it("reports an error instead of rejecting when the prompt fails", async () => {
    const result = await promptSession(
      client(() => Promise.reject(new Error("server unreachable"))),
      "ses_1",
      INDEX,
    )
    expect(result).toEqual({ ok: false, error: "server unreachable" })
  })

  it("reports an error when there is no session", async () => {
    const result = await promptSession(client(() => Promise.resolve({})), undefined, INDEX)
    expect(result).toEqual({ ok: false, error: "no active session" })
  })

  it("reports an error when the prompt throws synchronously", async () => {
    const result = await promptSession(
      client(() => {
        throw new Error("sync boom")
      }),
      "ses_1",
      INDEX,
    )
    expect(result).toEqual({ ok: false, error: "sync boom" })
  })
})

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

  it("collapsing the selected folder shrinks the tree and re-clamps the cursor", () => {
    const { state, commands } = setup()
    const children = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}.ts`,
      path: `/proj/src/f${i}.ts`,
      isDirectory: false,
    }))
    state.setEntries([SRC])
    state.setChildrenMap(new Map([["/proj/src", children]]))
    state.setExpanded(new Set(["/proj/src"]))

    state.setCursor(10) // last child
    expect(state.visibleNodes()).toHaveLength(11)

    state.setCursor(0) // back onto src so toggle has a folder to collapse
    commands.toggle()

    expect(state.visibleNodes()).toHaveLength(1)
    expect(state.cursor()).toBe(0)
    expect(state.currentEntry()?.name).toBe("src")
  })

  it("open opens a file in the editor", async () => {
    const { state, commands, opened } = setup()
    state.setEntries([SRC, INDEX])
    state.setCursor(1)
    await commands.open()
    expect(opened).toEqual(["/proj/src/index.ts"])
  })

  it("open expands a directory instead of opening it", async () => {
    const { state, commands, opened } = setup()
    state.setEntries([SRC])
    state.setChildrenMap(new Map([["/proj/src", [INDEX]]]))
    state.setCursor(0)

    await commands.open()
    expect(opened).toEqual([])
    expect(state.expanded().has("/proj/src")).toBe(true)
  })

  it("open does nothing on an empty tree", async () => {
    const { commands, opened } = setup()
    expect(await commands.open()).toBeUndefined()
    expect(opened).toEqual([])
  })

  it("open surfaces an editor failure without throwing", async () => {
    const { state, commands } = setup({ editorFails: true })
    state.setEntries([INDEX])
    expect(await commands.open()).toEqual({ ok: false, error: "ENOENT" })
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

  it("send does nothing on an empty tree", () => {
    const { commands, sent } = setup()
    commands.send()
    expect(sent).toEqual([])
  })

  it("refresh reloads rather than clearing state", () => {
    const { state, commands, reloadCount } = setup()
    state.setEntries([SRC])
    commands.refresh()
    expect(reloadCount()).toBe(1)
    // State is untouched: reload is responsible for re-reading, not wiping.
    expect(state.entries()).toHaveLength(1)
  })
})