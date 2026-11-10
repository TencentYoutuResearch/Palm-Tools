---
schema_version: 2
id: gui/windows-session-experience
kind: spec
document_class: normative
spec_type: capability
title: Windows session creation, model metadata, and terminal interaction
status: active
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

# Windows session experience

## Requirements

- The main window opens with enough vertical space for the new-session
  configuration surface. The chooser remains scrollable when the display is
  smaller than the preferred window size.
- On Windows, model discovery executes npm `.cmd` shims through `cmd.exe`.
  Codex-family discovery must request and consume every page returned by
  `model/list`.
- A newly created Tcodex tab reports the model already active in the Codex
  runtime. If Codex has not written a `turn_context` yet, the session must use
  the configured model from the Codex profile instead of the `auto` placeholder.
- Terminal output may be buffered while an IME composition is active, but it
  must be replayed in order when composition ends. Composition must not drop
  terminal bytes.
- The Worker/Monitor mode menu closes when the user presses anywhere outside the
  menu.
- Pointer interaction with expandable Codex/Tcodex terminal content must not
  terminate or interrupt the session. Codex-family terminals use the compatible
  click-versus-drag selection behavior.
- New-session history is queried for the current absolute working directory on
  both POSIX-style and Windows-style paths.

## Invariants

- Model discovery failures fall back to editable custom input; they never block
  session creation.
- Session metadata updates are monotonic: an actual model may replace `auto`,
  but a later empty value must not erase it.
- Terminal input and output ordering is preserved across IME buffering.
- No terminal mouse gesture, selection gesture, or expandable-content click may
  send an interrupt sequence to the PTY.

## Verification

- `cargo test -p kode-bridge -- --test-threads=1`
- `cargo test -p kode-core -- --test-threads=1`
- `pnpm --dir apps/gui test:session-input`
- `pnpm --dir apps/gui test:chooser-history`
- `pnpm --dir apps/gui check`
