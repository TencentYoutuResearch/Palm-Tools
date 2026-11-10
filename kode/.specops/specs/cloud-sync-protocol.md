---
schema_version: 1
id: remote/cloud-sync-protocol
kind: spec
title: kode centralized session sync and command routing v1
status: active
verifies:
  - rust
  - flutter
paths:
  - crates/kode-sync-server
  - apps/gui/src-tauri/src/cloud_sync.rs
  - apps/mobile
  - deploy/docker-compose.sync.yml
---

# Kode centralized sync protocol v1

This contract replaces direct desktop-LAN pairing for Kode Mobile. The direct
Bridge protocol remains available for SSH/remote-desktop transports, but the
mobile companion uses only the centralized service.

## Trust and execution model

- The desktop is the only process allowed to write to a local PTY.
- The desktop opens an outbound WebSocket to the center; the center never
  initiates a connection to the desktop and the phone never learns a LAN IP.
- The center stores a durable mirror of session metadata and semantic events.
- Mobile commands are online-only with a 30-second TTL. If the desktop is
  offline the API returns `409` and does not queue the message.
- Text input reuses `kode_bridge::submit_text_input`: body first, then a
  separate carriage return after 50 ms.

## Credentials and pairing

1. The desktop registers an installation at `POST /api/v1/devices/register`.
   It stores the opaque device token in `cloud-sync.json` with mode `0600`.
2. The desktop creates a two-minute, single-use pairing at
   `POST /api/v1/devices/:id/pairings` using its device bearer token.
3. The QR is
   `kode://cloud-pair?server=…&pairing_id=…&secret=…`. The secret is random,
   shown only through the QR/copy action, and stored server-side as SHA-256.
4. Mobile claims it through `POST /api/v1/pairings/:id/claim` and stores the
   returned mobile access token in platform secure storage.
5. A binding grants `sessions.read`, `sessions.content.read`,
   `sessions.send`, and `workers.monitor`. Server authorization is mandatory
   for every REST/WS path. Older bindings without `workers.monitor` remain
   scoped to their issuing Worker.
6. `DELETE /api/v1/bindings/current` revokes the current mobile token. When the
   last binding is revoked, the desktop agent immediately stops uploading.

Session synchronization remains disabled while binding count is zero. A claim
notifies an already-connected agent with `pairing.bound`; a reconnect learns
the same state from `server.hello`.

## Stable IDs and persistence

- A desktop process creates a random `boot_id`.
- The center maps `(device_id, boot_id, local_session_id)` to an autoincrement
  cloud session ID. Mobile continues to use numeric IDs without collisions
  across desktop restarts.
- Sessions, non-PTY semantic events, pairings, bindings, and commands are stored
  in SQLite. WAL and foreign keys are enabled; the database lives in the
  `kode-sync-data` deployment volume.
- Event identity is a SHA-256 digest of device, boot, local session, timestamp,
  event type, and payload. Replayed bus history is inserted idempotently.

## Desktop agent WebSocket

Endpoint: `GET /api/v1/agent/ws?device_id=…` with a device bearer header.

Desktop to center frames:

- `hello { boot_id, sessions: [{ local_id, dto }] }`
- `event { boot_id, local_session_id, event }`
- `command.result { command_id, status, error? }`
- `ping`

Center to desktop frames:

- `server.hello { sync_enabled, binding_count }`
- `pairing.bound { binding_count }`
- `binding.changed { sync_enabled, binding_count }`
- `command { command_id, local_session_id, kind, payload, expires_at }`
- `pong`

The desktop sends its current snapshot and up to 1,000 retained semantic bus
events per active session after binding/reconnect. The center deduplicates all
replays. If a session is created after that snapshot, the desktop refreshes the
snapshot before sending the session's first event; events must never arrive at
the center before their session mapping exists. The desktop keeps the most
recent 512 command receipts. It records
`accepted` before PTY execution and never replays a command whose previous
execution outcome is uncertain.

An authoritative hello snapshot publishes `session.created` for a new cloud
row and `session.updated` with the complete DTO for an existing row. Mobile
must replace its cached DTO on either event. A new/reconnected mobile socket
also refreshes `GET /api/v1/sessions` after `connection.hello`, because mobile
operating systems may suspend the incremental WebSocket while backgrounded.
Desktop title changes additionally emit sparse `meta { title }` events so a
live mobile view updates without waiting for either reconnect.
Every desktop rename entry point (dialog and sidebar inline edit) must call
`set_title`; a frontend-only rename never reaches the bus. Once a title is
pinned by the user, JSONL-derived `meta` events carry `title: null` so a late
AI title cannot overwrite the user's name on mobile.

Snapshots contain active sessions only. Exited sessions remain server-side for
audit/history retention but are excluded from the mobile list, and a live
`session.exited` event removes the row immediately. Raw `pty_bytes` frames stay
local: only semantic events are persisted, replayed, and forwarded to mobile.
An initial history request (`from=0`) returns the newest bounded semantic window
in chronological order so high-volume sessions still show their current
conversation.

## Mobile compatibility API

The center intentionally preserves the existing v1 mobile read surface:

- `GET /api/v1/sessions`
- `GET /api/v1/sessions/:id`
- `GET /api/v1/sessions/:id/history?from=&limit=`
- `POST /api/v1/sessions/:id/input`
- `DELETE /api/v1/sessions/:id`
- `GET /ws` with the mobile bearer header; access tokens are never accepted in URLs

Mobile monitor routing adds the optional `X-Kode-Worker-Id` header to every
session, setup-catalogue and mobile WebSocket request. The bearer token remains
bound to the Worker that issued the pairing. A different target is authorized
only when the binding has `workers.monitor`; the header never changes command
execution ownership, which remains the selected Worker. The WebSocket hello
returns both the selected `device_id` and the credential-owning
`bound_device_id`. Omitting the header preserves single-Worker behavior for
older mobile clients.

`POST input` accepts `{ "text": "…" }`, requires `sessions.send`, validates a
64 KiB maximum, and accepts `Idempotency-Key`. It returns `202` only after the
command has been persisted and dispatched to an online desktop. Command state
is `dispatched → accepted → executed` or `failed/expired`; transitions are also
published as `command.status` events.

`DELETE /api/v1/sessions/:id` uses the same dispatch rules with command kind
`delete`. The desktop stops that session and emits `session.exited`, which
removes it from the mobile list. An offline desktop returns `409` and the
session stays visible.


## Mobile session creation and desktop catalogues

The paired desktop owns backend discovery, models and filesystem paths. Mobile
uses `GET /api/v1/backends`, `GET /api/v1/backends/:key/models` and
`GET /api/v1/fs/list?path=&show_hidden=` through the center. These reads require
`sessions.content.read`; directory browsing returns directories only, never file
contents. The backend response includes the desktop `home` directory.

`POST /api/v1/sessions` requires `sessions.send` and `Idempotency-Key`. Its
allowlisted body is `{ backend_key, cwd?, model? }`. The desktop verifies the
backend is enabled and executable and the working directory is an existing
absolute directory. Permission defaults and transport selection remain owned by
the bridge (new CodeBuddy sessions use ACP). Mobile cannot inject CLI arguments,
initial prompts, permission bypass flags, or arbitrary bridge endpoints.

The relay uses `setup.request { request_id, kind, payload, expires_at }` and
`setup.result { request_id, boot_id, status, body }` over the existing outbound
WebSocket. Kinds are `backends`, `models`, `directories`, `create_session`.
Requests start only while the desktop is online and expire before execution
after 30 seconds. Desktop setup runs separately from the socket receive loop;
slow model discovery does not block heartbeats or session events. The REST call
waits up to 50 seconds for a response. Older desktop/center installations must
be upgraded together to expose this feature.

Create receipts are persisted in SQLite by binding and idempotency key before
dispatch; they are never queued or replayed on reconnect. The desktop also
records acceptance before execution. A retry with the same payload/key returns
the saved result, or `202 creation_unconfirmed` while no result is known. Reusing
a key with a changed payload returns `409`. A timeout returns
`504 creation_unconfirmed`; it does not assert that creation failed. Mobile
locks the selections and offers **Check creation result**, retaining the same
key. Leaving that state prompts the user to inspect the session list before
starting another request. Definitive failures permit editing and a fresh retry.

Before returning a successful create response, the center maps the local ID
and boot ID into the canonical cloud session ID and publishes the complete DTO.
The response opens that session in mobile. Create results persist even when the
original HTTP waiter has timed out. Read results are ephemeral, scoped to the
requesting device, and mobile authorization is checked again before returning.

## Deployment

`deploy/docker-compose.sync.yml` runs the Rust service behind Caddy. Caddy owns
public HTTPS/WSS and HSTS; the application port is available only on the
internal Compose network. See `deploy/README-sync.md`.

The desktop app also supports an SSH-managed deployment for hosts that already
have a public HTTPS ingress (including DevCloud/AIO):

1. release packaging embeds `kode-sync-server-linux-musl.tar.gz`;
2. the desktop verifies that the host is x86_64 Linux with the required base
   tools, then uploads it using the system `scp`, reusing `~/.ssh/config`, keys,
   and ssh-agent without collecting SSH secrets;
3. deployment stops only the prior managed binary, installs under
   `~/.local/kode-sync-server`, preserves its SQLite data directory, and starts
   the static service with `nohup`;
4. the desktop verifies the remote loopback `/healthz` and the public HTTPS
   `/api/v1/healthz` before saving the backend or creating a pairing code. The
   namespaced public route avoids platform ingress health-check interception.

DNS, TLS certificates, firewall policy, and the public reverse proxy remain the
host owner's responsibility. The public ingress must forward HTTP and WebSocket
traffic to the chosen service port.

## Multiple deployment backends

### Multiple desktops on one center

Several independent Kode installations can use the same sync server URL. Each
installation registers its own device identity and opens its own outbound agent
WebSocket. Pair each desktop separately: the phone's Devices screen adds QR
bindings without replacing existing ones, and stores credentials by server URL
plus device ID. Tapping a saved desktop probes its API and activates that binding.
The session header names the selected desktop.

Changing the selected desktop replaces the phone's API and WebSocket context;
late refresh responses from the previous context must not overwrite the new
session list. Switching does not revoke bindings or stop other desktops from
uploading. The center scopes REST reads, event fanout, and command routing to the
device authorized by each binding. An offline desktop rejects input without
affecting other connected desktops. Each desktop must be paired before uploading;
sharing a server URL alone does not grant access to another device.

### Switching a desktop's deployment backend

`cloud-sync.json` stores a list of sync backends and one active backend. Each
backend owns its URL, optional SSH deployment metadata, device identity/token,
and command receipt ledger. Switching a backend restarts the outbound agent
generation and never copies credentials or uncertain command receipts across
origins. Existing single-backend configs migrate in place without changing the
installation identity or losing credentials.

### Worker directory and read-only inventory

The center exposes a Worker directory over the existing bearer model:

- `GET /api/v1/workers` returns registered Workers with stable Worker id, name,
  online state, last-seen time, Kode version, OS, architecture and inventory
  capability.
- `GET /api/v1/workers/:worker_id/inventory` returns a read-only snapshot of
  system, CPU, memory, disks, configured Agents and attached ADB devices.

Inventory is an allowlisted setup request. An Agent advertises
`capabilities: ["inventory.v1"]` in its hello; older Agents remain usable and
report `inventory_capable: false`. Inventory never accepts caller-supplied
commands or arguments, never returns credentials, and never bypasses Worker
isolation.

Cross-Worker inventory is disabled by default. A controlled single-tenant
deployment can set `KODE_SYNC_ALLOW_SHARED_INVENTORY=1` to allow one registered
Worker to inspect another's read-only inventory. Session data, events and
commands remain scoped to each Worker independently of this flag.
