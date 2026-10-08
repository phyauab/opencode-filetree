import { describe, it, expect } from "bun:test"
import { TreeNode } from "./TreeNode"
import type { DirEntry } from "./fileSystem"

const file: DirEntry = { name: "app.ts", path: "/proj/app.ts", isDirectory: false }

/**
 * TreeNode is a plain function component: calling it runs the body and returns
 * the JSX description the stub runtime builds, so the row's props are directly
 * assertable without a renderer.
 */
const row = (props: Partial<Parameters<typeof TreeNode>[0]> = {}) =>
  TreeNode({
    entry: file,
    depth: 0,
    isSelected: false,
    isExpanded: false,
    gitStatus: undefined,
    ...props,
  }) as unknown as { props: { fg?: string; bg?: string; children: string } }

describe("TreeNode", () => {
  it("renders the name and the git indicator as one text row", () => {
    const text = row({ gitStatus: "M" }).props.children
    expect(text).toContain("app.ts")
    expect(text).toContain("[M]")
  })

  it("colors a modified row yellow", () => {
    // The marker alone was easy to miss in a long tree; the row's own color is
    // what makes a change visible at a glance.
    expect(row({ gitStatus: "M" }).props.fg).toBe("yellow")
  })

  it("colors an added row green and a deleted row red", () => {
    expect(row({ gitStatus: "A" }).props.fg).toBe("green")
    expect(row({ gitStatus: "D" }).props.fg).toBe("red")
  })

  it("leaves a clean row uncolored", () => {
    expect(row().props.fg).toBeUndefined()
  })

  it("keeps the selection color over the git color", () => {
    const selected = row({ gitStatus: "M", isSelected: true })
    expect(selected.props.fg).toBe("cyan")
    expect(selected.props.bg).toBe("blue")
  })
})
