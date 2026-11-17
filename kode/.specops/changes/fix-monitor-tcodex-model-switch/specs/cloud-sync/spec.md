---
schema_version: 2
id: remote/monitor-model-switch
kind: spec
document_class: normative
spec_type: capability
title: Monitor 模式 Worker 模型切换
status: proposed
verifies:
  - rust
  - flutter
paths:
  - apps/gui/src/lib/DeviceSession.svelte
  - apps/gui/src/lib/ipc.ts
  - apps/gui/src-tauri/src/cloud_sync.rs
  - apps/mobile/lib/src/api/api_client.dart
  - crates/kode-bridge/src/cloud_sync.rs
  - crates/kode-bridge/src/model_switch.rs
  - crates/kode-sync-server/src/lib.rs
---

# Monitor 模式 Worker 模型切换

## Requirements

- Desktop Monitor and mobile Monitor must list models from the selected Worker
  backend and may request an in-session model change only while the session is
  idle and has no pending interaction.
- A model command must be routed to the selected Worker and include the target
  cloud session ID. Switching the monitor target must not redirect an in-flight
  command to another Worker.
- HTTP acceptance is not success. The client must observe `command.status`
  `executed` for the same command ID before displaying the new model.
- A `failed` or `expired` command must surface the Worker error and retain the
  last confirmed model.
- Codex/TCodex model changes must use the native `/model` picker, select an exact
  model identity, preserve reasoning effort when available, and accept the
  native "Model changed to" confirmation emitted by current TCodex releases.
- TClaude PTY sessions must use their native model command and the Worker's
  TClaude catalogue; CodeBuddy sessions must use the advertised ACP model
  configuration option (legacy `session/set_model` only when advertised).
- Worker snapshots must include active structured ACP sessions even though they
  have no PTY, so Monitor clients can list and control them.
- A binding with `workers.monitor` may list sessions for any registered Worker
  selected by `X-Kode-Worker-Id`; this does not require or grant the separate
  shared-inventory capability. A binding without that scope remains restricted
  to its own Worker.
- A desktop that has not yet created its monitor binding must mint that binding
  for its own device, cache the token, and then select sibling Workers with
  `X-Kode-Worker-Id`. It must not attempt to mint a monitor binding with another
  Worker's device credentials.
- A model ID and catalogue from one backend must never be sent to another
  backend merely because the Monitor target or session changed.

## Invariants

- Worker command execution remains owned by the Worker-local PTY/ACP process.
- Model catalogue and command requests remain scoped by `X-Kode-Worker-Id`.
- Offline commands are not queued.
- Account-relay behavior is unchanged.
- Optimistic UI never replaces the confirmed model before an execution receipt.
