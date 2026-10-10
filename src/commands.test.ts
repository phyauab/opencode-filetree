import { describe, it, expect } from "bun:test"
import { createTreeCommands, promptSession } from "./commands"
import { createTreeState } from "./store"

function setup() {
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
    openInViewer: (entry) => {
      opened.push(entry.path)
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

/*
 * `parseEditorCommand`, `spawnEditor` and `EditorResult` are deleted from
 * commands.ts, and these tests went with them. Their subject was a child
 * process; `open()` now opens a panel, which the "tree commands" block below
 * covers as `openInViewer`. See the comment in commands.ts.
 */

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

  it("open opens a file in the viewer", () => {
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

    // A directory still folds. The viewer refuses to read one and would show
    // that refusal where the reader expected the tree to move.
    expect(opened).toEqual([])
    expect(state.expanded().has("/proj/src")).toBe(true)
  })

  it("open does nothing on an empty tree", () => {
    const { commands, opened } = setup()

    commands.open()

    expect(opened).toEqual([])
  })

  it("open returns nothing, so a keypress never awaits a panel", () => {
    const { state, commands } = setup()
    state.setEntries([INDEX])

    // The editor it replaced returned a promise, and `nav.open` had to await it
    // and toast on failure. Opening a panel is synchronous, and there is no
    // result to inspect.
    expect(commands.open()).toBeUndefined()
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