---
schema_version: 2
id: fix-windows-terminal-selection-copy
document_class: design
status: completed
---

# Design

## Input boundary

Both failures cross the same boundary: terminal UI gestures are translated into
PTY input too early. The fix keeps read-only Windows copy gestures inside the
GUI and only forwards genuine terminal commands.

## Clipboard behavior

`terminal_clipboard.ts` owns the platform classification:

1. Windows `Ctrl+C` with a non-empty xterm selection resolves to `copy`.
2. The keyboard handler consumes the event before xterm's `onData` can produce
   ETX (`\x03`).
3. Windows `Ctrl+C` without a selection remains unresolved, preserving the
   existing PTY interrupt and close-confirmation path.
4. `Ctrl+Shift+C` remains a copy shortcut even when a backend has enabled mouse
   reporting.

The action function receives selection state explicitly so this behavior can
be unit tested without a browser clipboard implementation.

## Tcodex mouse ownership

Tcodex may enable xterm mouse reporting for clickable TUI content. Kode already
uses a capture-phase gesture classifier for Codex and Tcodex:

1. Capture the primary-button down event while mouse reporting is active.
2. Treat movement below the drag threshold as a click and replay one synthetic
   click to the existing xterm/CLI path.
3. Once movement crosses the threshold, classify the whole gesture as a
   selection drag. Suppress move and release events from xterm, update the local
   xterm selection, and emit no PTY input.
4. Reset document-level listeners on release, blur, or disposal.

The implementation must also treat repeated mouse detail (double/triple click)
as selection intent rather than replaying a multi-click to the TUI. That path
must create a local xterm selection without sending mouse input.

## Verification strategy

- Pure clipboard tests cover Windows selection/no-selection and non-Windows
  behavior.
- Fake-DOM mouse tests assert that drag, double-click, and triple-click
  selection do not replay clicks, while a short primary click still does.
- GUI `svelte-check` and the existing terminal/session-input suites guard
  against integration regressions.
- Produce a Windows NSIS debug installer after all checks pass.

## Risks

- xterm private mouse coordinate APIs can differ between upgrades. The helper
  keeps that dependency isolated in `codex_mouse_selection.ts`.
- Intercepting too many clicks would make Tcodex content controls unusable;
  tests must preserve the short single-click path.
- Clipboard permissions or OS clipboard write failures must not send the key to
  the PTY as a fallback.
