---
schema_version: 2
id: windows-session-experience
kind: feature
document_class: work_item
work_type: feature
title: Stabilize Windows session creation, model metadata, and terminal interaction
status: completed
verifies:
  - rust
paths:
  - apps/gui/src-tauri/tauri.conf.json
  - apps/gui/src/lib/BackendChooser.svelte
  - apps/gui/src/lib/ModeSwitcher.svelte
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/src/lib/codex_mouse_selection.ts
  - apps/gui/src/lib/session_history_path.ts
  - apps/gui/src/lib/terminal_ime.ts
  - apps/gui/tests/backend_chooser_history.test.ts
  - apps/gui/tests/codex_mouse_selection.test.ts
  - apps/gui/tests/terminal_ime.test.ts
  - crates/kode-bridge/src/model_discovery.rs
  - crates/kode-core/src/session/jsonl_tail.rs
  - crates/kode-core/src/session/mod.rs
---

# Stabilize Windows session creation, model metadata, and terminal interaction

## Motivation

Windows users currently encounter a cramped default window, incomplete Tcodex
model discovery, stale `auto` model labels after launch, IME candidate-window
jitter, a mode menu that does not dismiss on outside presses, and terminal
clicks that can interrupt a running session. The new-session chooser also skips
history for Windows paths because it only accepts paths beginning with `/`.

## Scope

- Increase the default and minimum window height while preserving chooser
  scrolling on smaller displays.
- Run Windows npm command shims correctly and request the full model catalogue.
- Initialize Tcodex model metadata from the active Codex configuration and keep
  JSONL-derived updates authoritative.
- Buffer terminal redraws during IME composition and replay them in order.
- Dismiss the Worker/Monitor mode menu on outside pointer presses.
- Apply Codex click-versus-drag handling to Tcodex so expandable content remains
  clickable without interrupting the session.
- Accept Windows drive-letter and UNC working directories when loading session
  history.

## Acceptance criteria

- [x] The default window height is larger and the new-session card is not
  clipped at the minimum supported height.
- [x] Tcodex model discovery returns all models on Windows when the executable is
  installed as an npm `.cmd` shim.
- [x] A newly created Tcodex tab shows its configured model rather than `auto`,
  before the first turn writes `turn_context`.
- [x] IME composition does not repeatedly move the terminal cursor or candidate
  anchor; buffered output replays in order.
- [x] Clicking outside the mode menu closes it.
- [x] Clicking expandable terminal content keeps the session running, while
  drag selection still selects text.
- [x] Creating a session in `D:\...` or a UNC directory shows that directory's
  historical sessions.
- [x] Focused Rust and GUI regression suites pass. Full-suite failures are
  limited to pre-existing POSIX-only tests running on Windows.

## Out of scope

- Redesigning the terminal renderer or replacing xterm.js.
- Changing Codex/Tcodex model routing or account configuration.
- Changing session lifecycle or Ctrl+C confirmation semantics.
- Adding new remote protocol fields.

## Constitution conflicts

None. The change preserves the independent PTY lifecycle and does not alter
backend positional arguments or SpecOps run isolation.
