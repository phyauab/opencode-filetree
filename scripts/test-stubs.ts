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
type Effect = () => void

/**
 * The effect currently reading a signal, if any. Real Solid tracks this per
 * computation; one global is enough here because effects only nest through
 * `untrack`.
 */
let activeEffect: Effect | null = null

/**
 * A signal with Solid's value-or-updater setter semantics, plus enough
 * subscription tracking to re-run effects when a value they read changes.
 *
 * The tracking matters. With `createEffect` firing once and never again, the
 * plugin's repaint path was unreachable from any test: a stale panel and a
 * working one behaved identically, because nothing in the tree ever ran twice.
 * That is how "the screen silently stopped updating" survived four fix attempts.
 */
function createSignal<T>(initial: T) {
  let value = initial
  const subscribers = new Set<Effect>()

  const read = () => {
    if (activeEffect) subscribers.add(activeEffect)
    return value
  }

  const write = (next: T | Updater<T>) => {
    const previous = value
    value = typeof next === "function" ? (next as Updater<T>)(previous) : next
    // Solid compares by identity and skips equal writes, so an effect that writes
    // back the value it just read does not re-trigger itself forever.
    if (Object.is(value, previous)) return value
    for (const run of [...subscribers]) run()
    return value
  }

  return [read, write] as const
}

/** Creates an effect: runs once, then again whenever a signal it read changes. */
function createEffect(fn: () => void): void {
  const run: Effect = () => {
    const previous = activeEffect
    activeEffect = run
    try {
      fn()
    } finally {
      activeEffect = previous
    }
  }
  run()
}

/**
 * Runs `fn` without subscribing the surrounding effect to what it reads.
 * FileTree depends on this: reading the plugin's live stores directly would
 * re-run those effects on every session event.
 */
function untrack<T>(fn: () => T): T {
  const previous = activeEffect
  activeEffect = null
  try {
    return fn()
  } finally {
    activeEffect = previous
  }
}

const cleanupCallbacks: (() => void)[] = []

mock.module("solid-js", () => ({
  createSignal,
  createMemo: <T,>(fn: () => T) => fn,
  createEffect,
  onCleanup: (fn: () => void) => {
    cleanupCallbacks.push(fn)
  },
  onMount: (fn: () => void) => fn(),
  createRoot: <T,>(fn: () => T) => fn(),
  untrack,
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