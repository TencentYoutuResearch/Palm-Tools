---
schema_version: 2
id: remove-zombie-workers
kind: feature
document_class: work_item
work_type: feature
title: Stale Worker removal interaction and lifecycle design
status: proposed
verifies:
  - rust
paths:
  - crates/kode-sync-server/src
  - crates/kode-bridge/src
  - apps/gui/src
  - apps/gui/src-tauri/src
---

# Stale Worker removal interaction and lifecycle design

## Interaction model

Removal is intentionally not part of the Worker switcher, list row, or rename
controls. Those surfaces are frequent and must stay free of destructive actions.

Worker Details renders a low-emphasis **Danger zone** after the inventory:

- only for an Offline Worker;
- with one sentence explaining that the entry is a server registration;
- with a secondary/destructive button labelled `Remove Worker…`.

Online Workers show no remove button. The user must stop the debug process and
wait for Offline state, which prevents terminating an active Agent or PTY.

The confirmation dialog is the required second action:

- title names the Worker;
- body states that monitor bindings and actionable sessions will be revoked;
- body states that the same registration cannot silently reconnect;
- Cancel is focused by default;
- confirm uses the existing destructive style.

## Server lifecycle

```text
DELETE /api/v1/workers/:worker_id
Authorization: Bearer <same-server device token or monitor token>
```

Authentication remains within the existing single-server trust boundary. A
device bearer may retire another Offline Worker on the same server. A mobile
binding may do so only when it has `workers.monitor`; otherwise it is limited
to its issuing Worker.

The server rejects removal while the Worker has an active Agent WebSocket.
Successful removal is transactional:

1. find non-exited sessions and active bindings;
2. set `sessions.dto_json.status=exited`;
3. set `bindings.revoked_at`;
4. set `devices.revoked_at`;
5. publish `session.exited`, `binding.revoked` and `worker.removed`.

Rows remain in SQLite for audit/recovery. `GET /api/v1/workers` already filters
`revoked_at IS NULL`, so the removed entry disappears everywhere on refresh.

Registration checks revoked installations before creating a new identity. A
revoked installation/token receives `403`; intentional reuse requires pairing
the installation again or resetting its cloud-sync configuration.

## Desktop data flow

```text
WorkerDetailsPanel
  -> Tauri cloud_sync_remove_worker
  -> local workbench service
  -> DELETE /api/v1/workers/:id
  -> remove response
  -> local directory refresh + parent callback
```

The front end does not optimistically remove the row. On success it removes the
row and selects another Worker. The parent clears `monitorWorkerId` if the
removed Worker was the selected Monitor target.

## Compatibility

- Existing servers without the route return 404; the UI keeps the Worker and
  reports that the server must be upgraded.
- Existing clients ignore `worker.removed`; they stop seeing the Worker on the
  next directory refresh.
- Account-relay device removal remains outside this API.
- No session, event or command isolation key changes.

## Verification

- server tests for offline removal, online conflict, tenant-boundary behavior,
  binding/session revocation, directory hiding, and rejected re-registration;
- bridge/API tests for encoding and error propagation;
- GUI tests for offline-only visibility, cancellation, failure retention and
  successful target cleanup;
- focused `pnpm check`, `cargo test -p kode-sync-server`, and
  `cargo test -p kode-bridge`.
