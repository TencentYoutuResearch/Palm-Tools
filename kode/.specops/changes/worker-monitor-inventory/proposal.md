---
schema_version: 2
id: worker-monitor-inventory
kind: feature
document_class: work_item
work_type: feature
title: Worker directory and read-only worker inventory
status: proposed
verifies:
  - rust
paths:
  - crates/kode-sync-server/src
  - crates/kode-bridge/src
  - apps/gui/src
  - apps/gui/src-tauri/src
targets:
  - kode/worker-monitor
---

# Worker directory and read-only worker inventory

## Motivation

Device engineers work from different PCs with different operating systems,
agent installations, local resources and attached Android devices. Before
choosing which Worker to monitor, users need enough information to know whether
that Worker can perform the current device-validation task.

This change adds a low-impact first slice: discover Workers registered on the
same sync server and inspect a Worker's current system, resources, agents and
ADB devices without granting any new command execution surface.

## Scope

- Add a Worker directory API on the sync server.
- Add an authenticated, read-only Worker inventory API.
- Extend the existing desktop setup request channel with
  `worker_inventory`; do not add a new low-level WebSocket frame.
- Add optional Worker capability advertisement so older Workers reject
  unsupported inventory requests without protocol breakage.
- Collect OS, host, Kode version, CPU, memory, disk, Agent availability/version,
  ADB version and ADB device metadata on the Worker.
- Add a desktop Worker directory/detail dialog accessible from the sidebar.
- Keep session, binding, command and messaging persistence unchanged.

## Acceptance criteria

- [ ] `GET /api/v1/workers` lists Workers on the current sync server with
      stable Worker id, display name, online state, last-seen time, Kode version,
      platform and inventory capability.
- [ ] `GET /api/v1/workers/:worker_id/inventory` returns the selected Worker's
      read-only inventory and never returns another Worker's data.
- [ ] Old Workers without inventory capability return a clear unsupported
      response and remain usable for sessions and commands.
- [ ] Inventory collection never exposes arbitrary command execution, Agent
      arguments, environment variables or credentials.
- [ ] Desktop users can open Worker Details from the session sidebar, refresh
      the directory and inspect system, resources, Agents and ADB devices.
- [ ] Offline Workers retain their last known directory status without showing
      fabricated live inventory.
- [ ] Existing pairing, session synchronization, command routing and mobile
      behavior remain compatible.
- [ ] Rust and Svelte checks pass.
- [ ] A local sync server and at least two isolated debug Kode Workers can be
      discovered and inspected through the new flow.

## Out of scope

- User, tenant or membership accounts.
- Typed cross-Worker delegation and task inboxes.
- Cross-Worker session migration or handoff.
- Arbitrary ADB, shell, build or flash command execution.
- Continuous high-frequency telemetry upload.

## Constitution conflicts

No conflict. The change does not alter PTY lifecycle, backend default arguments,
session ownership, or SpecOps run isolation.
