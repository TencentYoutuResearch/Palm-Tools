---
schema_version: 2
id: optimize-tcodex-new-session
kind: bug
title: Speed up Tcodex session creation and resume startup
status: completed
verifies:
  - typescript
  - rust
paths:
  - apps/gui/src/lib/BackendChooser.svelte
  - apps/gui/src/lib/ipc.ts
  - apps/gui/src-tauri/src/commands.rs
  - crates/kode-bridge/src/model_discovery.rs
  - crates/kode-core/src/session/backend.rs
  - crates/kode-core/src/session/codex_title.rs
  - crates/kode-core/src/session/jsonl_tail.rs
  - apps/gui/tests/backend_chooser_history.test.ts
  - crates/kode-core/src/session/backend.rs
---

# Speed up Tcodex session creation and resume startup

## User request

Creating a Tcodex session is slow: the model catalogue and local session
history take too long to appear, and starting a new or resumed session after
selection is also slow. History-row selection itself already works.

## Measurements

On the current Windows workspace:

- `tcodex app-server` takes about `2.4s` to finish initialization; the actual
  `model/list` request takes about `6ms`.
- `~/.tcodex/sessions` contains only 7 rollouts but about `95.6MB` of JSONL.
- `codex_session_cwd` currently reads each complete rollout before inspecting
  its first eight lines.
- The history page recursively scans rollouts and fully parses selected
  transcripts even though Tcodex's `state_5.sqlite` already stores session id,
  cwd, title, model, token usage, and update time.

## Scope

- Cache Tcodex/Codex model catalogues across chooser instances and application
  restarts, with a bounded TTL, request de-duplication, and an explicit refresh
  path.
- Keep model discovery asynchronous so choosing a model or starting a session
  never waits for the catalogue request.
- Use Tcodex/Codex `state_5.sqlite` as the primary history index and rollout
  path lookup, with the existing filesystem scan as a compatibility fallback.
- Stop reading complete rollout files merely to inspect their first
  `session_meta` line.
- Avoid parsing full transcripts when the database already supplies list
  metadata.
- Keep the existing history-row selection interaction, but make the subsequent
  Start/Resume command reach PTY spawn without blocking searches or routine
  metadata work.
- Reduce avoidable serial work before local PTY spawn where tasks are
  independent and safe to run concurrently.

## Acceptance criteria

- [x] A warm Tcodex chooser returns the model catalogue without starting a new
  `app-server` process.
- [x] The explicit model refresh still bypasses cached data.
- [x] Opening the model selector and starting a session remain non-blocking
  while discovery is pending.
- [x] Tcodex history for an absolute cwd is served from SQLite when the
  database schema is available, without scanning all rollout files or parsing
  complete transcripts.
- [x] Missing or older SQLite schemas fall back to the current filesystem
  discovery behavior.
- [x] First-eight-line rollout metadata reads stop after eight lines instead of
  loading the complete file.
- [x] Starting a selected history row does not recursively scan rollout files
  or read complete transcripts before PTY spawn.
- [x] Starting a new session does not wait for model discovery or history-list
  loading.
- [x] Focused UI/Rust tests and the GUI suite pass.
- [x] A latest Windows debug build is generated and launched for manual
  verification.

## Out of scope

- Changing Tcodex authentication, model routing, or plugin behavior.
- Removing the history filesystem fallback.
- Changing remote bridge protocol fields.
- Replacing the renderer or redesigning the chooser.

## Constitution conflicts

None. The changes preserve PTY/session ownership, backend launch semantics, and
the existing remote protocol.
