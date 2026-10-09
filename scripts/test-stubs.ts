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
  /**
   * `<Show>`, honestly rather than as a hole.
   *
   * It used to be `() => null`, on the reasoning that the stub records
   * `createComponent(Show, props)` without ever calling the component, so nothing
   * inside a `<Show>` was reachable from a test. That reasoning was half right
   * and it was used to justify keeping JSX out of `tui.tsx`. What actually
   * happens is narrower: `createComponent` records the props object *uninvoked*,
   * but it does not invoke the props getters either, so the compiled
   * `get children()` survives intact and a test can walk it -- exactly as
   * `FileViewer.test.ts` walks `props.children` for its rows.
   *
   * So the component is implemented rather than stubbed out, and both child
   * shapes are handled: a plain child is returned as-is, and a function child is
   * called with the `when` value, which is what `keyed` means.
   *
   * No test exercises this yet -- nothing invokes the component, because
   * `createComponent` records rather than calls, and no test in the suite needs
   * to. It was verified by a throwaway `.tsx` probe when it was written (all
   * three shapes above, against real compiled JSX) and the probe was deleted.
   * It is here so the next test that reaches inside a `<Show>` can rely on it
   * rather than rediscover that the stub used to return `null`.
   */
  Show: (props: {
    when?: unknown
    keyed?: boolean
    fallback?: unknown
    children?: unknown
  }) => {
    const child = props.when ? props.children : props.fallback
    if (typeof child === "function") return (child as (value: unknown) => unknown)(props.when)
    return (child as unknown) ?? null
  },
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

/**
 * The host's `SyntaxStyle.create()` allocates a native handle on every call, and
 * `fromTheme` builds on top of it, so neither is a singleton. This stub hands
 * back one shared object instead, and that is the single deliberate difference
 * from the real API: the tests assert the empty-theme fallback by identity --
 * `toBe(SyntaxStyle.create())` compares what `buildSyntaxStyle` returned against
 * a second, separate call -- and a factory that built a new object each time
 * would fail them for a reason that has nothing to do with the theme mapping.
 * Value equality is what those assertions mean, and a shared object is the
 * cheapest way to let identity stand in for it. Every other member returns a
 * fresh object, as the real ones do.
 */
const emptySyntaxStyle = { __stub: "SyntaxStyle.create", scopes: [] as unknown[] }

/**
 * `@opentui/core`, for the markdown preview.
 *
 * The real package loads a native render library over FFI, which a unit test has
 * no business doing, and the plugin is never supposed to ship its own copy. This
 * stands in for exactly the three members the viewer calls.
 *
 * `fromTheme` records the scope list it was handed rather than interpreting it,
 * which is what lets a test assert the theme→scope mapping without a renderer.
 *
 * Nothing else in the suite imports this module yet, so a member the markdown
 * viewer does not reach was left out rather than guessed at: `SyntaxStyle` has a
 * dozen more methods and the renderables are a whole tree, none of which a unit
 * test here can exercise without a real renderer.
 */
mock.module("@opentui/core", () => ({
  SyntaxStyle: {
    fromTheme: (scopes: unknown[]) => ({ __stub: "SyntaxStyle.fromTheme", scopes }),
    create: () => emptySyntaxStyle,
  },
  getTreeSitterClient: () => ({ __stub: "TreeSitterClient" }),
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