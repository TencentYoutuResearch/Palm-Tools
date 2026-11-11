---
schema_version: 2
id: fix-windows-terminal-selection-copy
kind: bug
title: Prevent Windows terminal selection and copy from interrupting sessions
status: completed
verifies:
  - typescript
paths:
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/src/lib/codex_mouse_selection.ts
  - apps/gui/src/lib/terminal_clipboard.ts
  - apps/gui/tests/codex_mouse_selection.test.ts
  - apps/gui/tests/terminal_clipboard.test.ts
  - docs/UX-CONTRACT.md
---

# Prevent Windows terminal selection and copy from interrupting sessions

## User request

On Windows, selecting text in a running Tcodex session can unexpectedly
interrupt the session. Users may only want to copy part of the conversation.

## Motivation

Windows terminal users conventionally use a mouse drag to select conversation
output and bare `Ctrl+C` to copy it. Tcodex enables terminal mouse reporting,
so a selection gesture can currently be interpreted as terminal input. Bare
`Ctrl+C` with an active selection can also reach the PTY and participate in the
consecutive-`Ctrl+C` close confirmation. Both behaviors make a read-only copy
workflow capable of stopping the task or closing the session.

The previous Windows session-experience work deliberately preserved bare
`Ctrl+C` as a terminal interrupt and applied Codex click-versus-drag handling to
Tcodex. This bug closes the remaining selection/copy gap without changing the
keyboard interrupt contract when no text is selected.

## Scope

- On Windows, bare `Ctrl+C` with an active terminal selection copies that exact
  selection and is consumed before xterm, the PTY, or the consecutive-`Ctrl+C`
  guard receives it.
- `Ctrl+Shift+C` remains a copy shortcut. A bare `Ctrl+C` without a selection
  remains a terminal interrupt.
- A Tcodex mouse gesture that becomes a text-selection drag must be owned by
  Kode for its full mouse sequence: it must not emit terminal mouse reports,
  `Ctrl+C`, or any other PTY input.
- Short clicks retain their existing click-versus-drag behavior so expandable
  Tcodex content remains usable.
- Add focused regression tests for clipboard classification and Tcodex mouse
  gesture routing.

## Acceptance criteria

- [x] Dragging to select terminal text in a running Tcodex session does not
  change session status, interrupt the active turn, or close the tab.
- [x] Releasing a selection drag does not forward a click or mouse report to
  the PTY.
- [x] On Windows, pressing bare `Ctrl+C` with a non-empty selection copies the
  selected text, prevents the key from reaching xterm/PTY, and does not open
  the close-session confirmation.
- [x] `Ctrl+Shift+C` still copies the selection.
- [x] Bare `Ctrl+C` without a selection retains the existing terminal interrupt
  and consecutive-`Ctrl+C` confirmation behavior.
- [x] Clicking expandable Tcodex content still sends exactly the intended
  click, while non-Windows terminal behavior is unchanged.
- [x] Focused Node tests, `svelte-check`, and the GUI test suite pass.
- [x] A Windows debug build containing the fix is generated for manual testing.

## Out of scope

- Removing the consecutive-`Ctrl+C` close confirmation for keyboard use.
- Changing Codex/Tcodex backend arguments, model routing, or PTY lifecycle.
- Replacing xterm.js or redesigning the terminal renderer.
- Adding a new application menu or visible copy button.

## Constitution conflicts

None. This change only filters user input before it reaches the existing PTY and
does not alter session ownership, backend launch arguments, or SpecOps run
isolation.
