/**
 * Test-only stubs for the runtime packages OpenCode supplies.
 *
 * The plugin must not ship copies of solid-js or @opentui/solid, or it ends up
 * with different module instances than the host and every Solid context read
 * fails at runtime. That leaves nothing on disk for the test run to import, so
 * these stubs stand in. They implement the signals the store relies on and
 * nothing more; components that need a real renderer are skipped instead.
 */

import { mock } from "bun:test"

type Updater<T> = (prev: T) => T

/** A minimal signal with Solid's value-or-updater setter semantics. */
function createSignal<T>(initial: T) {
  let value = initial
  const read = () => value
  const write = (next: T | Updater<T>) => {
    value = typeof next === "function" ? (next as Updater<T>)(value) : next
    return value
  }
  return [read, write] as const
}

const cleanupCallbacks: (() => void)[] = []

mock.module("solid-js", () => ({
  createSignal,
  createMemo: <T,>(fn: () => T) => fn,
  createEffect: (fn: () => void) => fn(),
  onCleanup: (fn: () => void) => {
    cleanupCallbacks.push(fn)
  },
  onMount: (fn: () => void) => fn(),
  createRoot: <T,>(fn: () => T) => fn(),
  untrack: <T,>(fn: () => T) => fn(),
  getOwner: () => null,
  runWithOwner: <T,>(_owner: unknown, fn: () => T) => fn(),
  mergeProps: <T extends object>(...parts: T[]) => Object.assign({}, ...parts),
  splitProps: <T extends object>(props: T, keys: (keyof T)[]) => [props, {}] as const,
  indexArray: <T,>(list: T[]) => list.map((item, i) => [i, item] as const),
  mapArray: <T,>(list: T[], fn: (item: T, i: number) => T) => list.map(fn),
  For: () => null,
  Show: () => null,
  ErrorBoundary: (props: { children?: unknown }) => props.children ?? null,
  // JSX compiles to createComponent/mergeProps. The elements are never rendered
  // in these tests; they only need to exist.
  createComponent: (comp: unknown, props: Record<string, unknown>) => ({ comp, props }),
  createElement: (comp: unknown, props: Record<string, unknown>) => ({ comp, props }),
  // A context whose read returns the default rather than throwing, so importing
  // a component that declares one does not need a provider.
  createContext: <T,>(defaultValue: T) => {
    const read = () => defaultValue
    read.provider = (props: { value: T; children?: unknown }) => props.children ?? null
    return read
  },
  useContext: <T,>(context: { (): T }) => context(),
}))

/**
 * A JSX runtime that builds a plain description of the tree instead of calling
 * OpenTUI. Registration tests need `setup()` to run, and the components are
 * never rendered, so the elements only have to exist and be inspectable.
 */
mock.module("@opentui/solid/jsx-dev-runtime", () => ({
  jsx: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxs: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  jsxDEV: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
  Fragment: (props: Record<string, unknown>) => props,
  createComponent: (comp: unknown, props: Record<string, unknown>) => ({ comp, props }),
}))

/** Runs and clears the callbacks `onCleanup` collected during a test. */
export function runCleanups(): void {
  while (cleanupCallbacks.length > 0) {
    const fn = cleanupCallbacks.pop()
    try {
      fn?.()
    } catch {
      // A failing cleanup must not mask the test's own result.
    }
  }
}