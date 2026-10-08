# Fix plan — review of `master` @ 065867c

Ten findings. Each is a TDD cycle: failing test first, then minimal code.

| # | Finding | Cycle | Test location |
|---|---------|-------|---------------|
| F2 | nav keymap layer leaks per remount; N keypresses move cursor N rows | 1 | `src/tui.test.ts` |
| F1 | pending repaint reopens the panel after Escape | 2 | `src/tui.test.ts` |
| F4 | `commands.ts` unreachable; editor + send-to-session removed | 3 | `src/tui.test.ts` |
| F3 | each remount re-reads root + forks `git status` | 4 | `src/FileTree.test.ts` |
| F6 | click no longer expands a folder | 5 | `src/FileTree.test.ts` |
| F7 | dead `viewportHeight` prop on `TreeRows` | 6 | delete, no test (trivial) |
| F8 | `context: any` | 7 | resolved by deleting `TreePanel` |
| F9 | stray whitespace lines, missing trailing newlines | 8 | no test |
| F10 | README drift | 9 | no test (human prose) |

## Key structural change

`TreePanel` is deleted. Its only job was holding the navigation keymap layer in a
component body, which is what leaked a layer per remount. With the layer moved
into `setup` (still gated by `enabled: () => panel.current()?.name === PANEL`),
the navigation commands become reachable from `setup()` — which is also what
makes F1/F2 testable at all. Under the stub `Show` the component body never ran,
so none of the 214 existing tests could see them.

## Order

1. Tests for F2 + F1 in `tui.test.ts` → watch fail → refactor `tui.tsx` → pass
2. Tests for F4 in `tui.test.ts` → watch fail → restore `createTreeCommands` wiring → pass
3. Tests for F3 + F6 in `FileTree.test.ts` → watch fail → fix `FileTree.tsx` → pass
4. Cleanups F7–F10
5. Full suite + typecheck

## Status: complete — 238 pass / 2 skip / 0 fail, typecheck and build clean

An adversarial review pass after the fixes surfaced four more defects, each closed
with its own failing test first:

- `nav.open` expanded a folder without asking for a repaint, so `enter` on a
  folder changed nothing on screen (`src/tui.tsx`)
- a click on the "N more below" hint selected and toggled the off-screen tree
  entry at that index; `onClick` now bounds by the rows actually rendered
  (`src/FileTree.tsx`)
- `rootLoaded` was set even when the read failed, which reported "no files" for a
  directory that has files and never recovered, because `watch` on a missing path
  returns a no-op. It is now set on success only (`src/FileTree.tsx`)
- the slot render captured `sessionID` from *every* panel, so `s` could prompt a
  neighbouring plugin's session (`src/tui.tsx`)

Three new tests were tightened after being shown to pass against the reverted
code, and one used a Windows-only `$EDITOR` stand-in.

### Third round: the real root cause

The first two rounds treated symptoms. The trace from the live host showed the
truth: `rows-render` fired once at mount and never again, while the repaint
effect fired on every change and `requestRender()` scheduled a frame every time.
Reactivity worked; the rows were never rebuilt.

`dist/FileTree.js` contained `when: snapshot()` -- a plain value. Solid's `Show`
reads `props.when` from inside a memo, so a plain value gives it no dependency and
it never re-runs. The babel transform emits `get when() { return snapshot(); }`;
the shipped dist did not.

**`tsc` cannot compile Solid JSX.** `tsconfig.build.json` used `"jsx": "react-jsx"`,
whose automatic runtime passes props as a plain object. Every `<Show>` and `<For>`
in the built plugin was therefore inert, and had been since the plugin was first
built. That is the actual reason the author concluded the host does not repaint,
why `invalidate()` appeared to fail (it only refreshes `context.data` caches), why
`<For>` "did not repaint", and why closing and reopening the panel was the only
thing that ever worked -- remounting is the one way to rebuild renderables that
Solid was never rebuilding.

`scripts/build.mjs` now compiles the JS with `babel-preset-solid` and leaves `tsc`
to declarations only. A test asserts the dist contains `get when()` so the build
cannot silently regress.

Two supporting findings from reading the host rather than guessing:

- The plugin that actually runs is a single-file shim at
  `~/.config/opencode/plugins/filetree/tui.ts`, which calls
  `ensureRuntimePluginSupport()` and then imports this repo's `dist/tui.js`. Its
  comment points at anomalyco/opencode#37836, "V2 plugin JSX crashes with No
  renderer found" -- the bug that shim works around.
- `CliRenderer.requestRender(): void` is the documented repaint primitive
  ("Use `requestRender()` for a one-shot repaint"), and upstream has shipped the
  identical stale-display bug in its own renderables
  (anomalyco/opentui#965: "the display stayed stale indefinitely").

**The test stub was why this survived four fix attempts.** `createEffect` ran its
body once and never again, so no state change ever re-ran anything in the tree.
A stale panel and a working one were indistinguishable from a test. The stub now
tracks signal subscriptions and re-runs effects whose dependencies changed, which
is what let "changing the selection must request a frame" become a real test.

**The stuck folder, `./scripts`.** Two causes, both required:

- the persist effect skipped writing when the expansion set was empty, so
  collapsing the last open folder was never recorded; and
- the restore effect re-applied the stored layout on every remount, overwriting
  the user's change -- and it never consumed its "already decided" flag when
  there was nothing to restore, so it stayed armed for the next one.

With the panel remounting on every navigation, the folder the user had just
closed sprang open again. Now the empty set is persisted (guarding on "root
read" rather than "something expanded") and the restore is a once-per-session
decision. The existing "still reopens a folder that really was left expanded"
test pins the behaviour that must not regress.

The storage stub was hiding all of this: it returned a getter where the host
returns a reactive proxy object, and `readLayout` rejects anything whose `typeof`
is not `"object"` -- so every persisted layout read back as empty.

### Deliberately not changed

- **The navigation layer is not gated on panel focus.** `PanelInput` exposes
  `focused()` and `KeymapLayer` a `target`, so an open-but-unfocused panel is a
  real state where `enter`/`s` would swallow typing. That depends on host
  behaviour that cannot be exercised here, so it is left as a known question
  rather than a speculative fix.