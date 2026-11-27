---
schema_version: 2
id: fix-windows-tcodex-wheel-conversation-scroll
kind: bug
document_class: work_item
work_type: bug
title: Restore Windows TCodex mouse-wheel transcript scrolling
status: proposed
verifies:
  - typescript
paths:
  - apps/gui/src/lib/terminal_mouse_tracking.ts
  - apps/gui/src/lib/terminal_mouse_reports.ts
---

# Restore Windows TCodex mouse-wheel transcript scrolling

## Motivation

On Windows Kode sessions with the TCodex backend, scrolling the mouse wheel
does not scroll the Codex transcript. The wheel is instead converted by xterm
into cursor-key sequences, which the Codex TUI interprets as prompt-history
navigation.

The Codex TUI enters the alternate screen and enables SGR mouse reporting with
`CSI ? 1003 ; 1006 h`. Kode strips that activation from the PTY output before
it reaches xterm, so xterm never enters mouse reporting. Its no-scrollback
wheel fallback then emits cursor keys, producing the prompt switch.

## Scope

- Let the Windows TCodex terminal enable SGR mouse reporting.
- Keep dropping legacy and non-SGR mouse-tracking modes.
- Continue stripping click, release, and motion reports before they reach the
  PTY, while preserving SGR wheel reports (buttons 64/65).
- Preserve macOS, Linux, remote terminals, and every non-TCodex backend.

## Acceptance Criteria

- [ ] A real Windows TCodex session scrolls the transcript with the wheel.
- [ ] The wheel no longer changes the in-dialog prompt selection.
- [ ] Clicks and drags still never reach the TCodex PTY.
- [ ] Non-Windows and non-TCodex behavior is unchanged.
- [ ] Focused tests and the full GUI check pass.

## Out of Scope

- Adding wheel gestures to non-terminal or structured views.
- Changing TCodex/TUI click handling or the accidental-exit policy.
- Altering terminal mouse selection or Ctrl+C semantics.

## Constitution Conflicts

None. The change stays inside the terminal input/output boundary and is gated
to Windows-local TCodex sessions.
