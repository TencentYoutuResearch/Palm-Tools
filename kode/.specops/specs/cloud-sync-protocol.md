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
5. A binding grants exactly `sessions.read`, `sessions.content.read`, and
   `sessions.send`. Server authorization is mandatory for every REST/WS path.
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
- `GET /ws` with the mobile bearer header; access tokens are never accepted in URLs

`POST input` accepts `{ "text": "…" }`, requires `sessions.send`, validates a
64 KiB maximum, and accepts `Idempotency-Key`. It returns `202` only after the
command has been persisted and dispatched to an online desktop. Command state
is `dispatched → accepted → executed` or `failed/expired`; transitions are also
published as `command.status` events.

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
4. the desktop verifies both the remote loopback `/healthz` and the public HTTPS
   `/healthz` before saving the backend or creating a pairing code.

DNS, TLS certificates, firewall policy, and the public reverse proxy remain the
host owner's responsibility. The public ingress must forward HTTP and WebSocket
traffic to the chosen service port.

## Multiple deployment backends

`cloud-sync.json` stores a list of sync backends and one active backend. Each
backend owns its URL, optional SSH deployment metadata, device identity/token,
and command receipt ledger. Switching a backend restarts the outbound agent
generation and never copies credentials or uncertain command receipts across
origins. Existing single-backend configs migrate in place without changing the
installation identity or losing credentials.
