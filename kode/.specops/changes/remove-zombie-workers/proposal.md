---
schema_version: 2
id: remove-zombie-workers
kind: feature
document_class: work_item
work_type: feature
title: Remove stale offline Workers from the shared sync server
status: proposed
verifies:
  - rust
paths:
  - crates/kode-sync-server/src
  - crates/kode-bridge/src
  - apps/gui/src
  - apps/gui/src-tauri/src
---

# Remove stale offline Workers

## Motivation

Debug builds can register multiple Worker identities on the same sync server.
When those processes are no longer running, their directory entries remain
Offline forever. The current UI can rename a Worker but cannot retire it, so
the Worker picker gradually fills with stale debug records.

Removal is destructive and uncommon. It must not compete with mode switching,
session navigation, or everyday Worker controls.

## Scope

- Add an authenticated API to retire an **offline** Worker registration.
- Soft-revoke the Worker, its monitor bindings and its actionable sessions.
- Prevent a revoked installation/token from silently registering itself again.
- Add a low-frequency danger zone inside Worker Details only for Offline
  Workers.
- Require a second confirmation that names the Worker and explains recovery.
- Refresh Desktop/Mobile-visible directory state through the normal APIs.

## Acceptance criteria

- [ ] Online Workers cannot be removed; the server returns a clear conflict.
- [ ] Removing an Offline Worker hides it from `GET /api/v1/workers`.
- [ ] All bindings for the removed Worker are revoked and mobile WebSockets
      bound to it receive `binding.revoked`.
- [ ] Non-exited sessions are marked exited and monitors receive
      `session.exited` with a `worker_removed` reason.
- [ ] A revoked installation/token cannot silently register a new Worker.
- [ ] Worker Details shows removal only for an Offline Worker, below inventory,
      as a subdued danger zone rather than a primary action.
- [ ] Clicking Remove opens a destructive confirmation with the Worker name and
      impact; Cancel is the default focus.
- [ ] Successful removal refreshes the selector, clears an invalid Monitor
      target, and displays a clear failure without optimistic removal.
- [ ] Existing rename, inventory, session control, account relay and
      cross-Worker routing behavior remain unchanged.

## Out of scope

- Removing online or self while the Worker process is connected.
- Removing account-relay devices.
- Bulk cleanup or automatic age-based deletion.
- Deleting audit/history rows physically.

## Constitution conflicts

None. PTY lifecycle, session ownership, backend defaults and SpecOps run
isolation remain unchanged.
