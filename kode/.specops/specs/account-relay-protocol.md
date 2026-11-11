---
schema_version: 1
id: remote/account-relay-protocol
kind: spec
title: kode multi-account relay v1
status: active
verifies:
  - rust
  - flutter
paths:
  - crates/kode-relay
  - crates/kode-relay/src/palmx.rs
  - crates/kode-relay/src/palm.rs
  - crates/kode-relay/src/palm_capture.html
  - apps/mobile/lib/src/ui/palm/palm_capture_screen.dart
  - crates/kode-relay-protocol
  - crates/kode-bridge/src/account.rs
  - crates/kode-bridge/src/cloud_sync.rs
  - crates/kode-bridge/src/mobile_setup.rs
  - apps/gui/src/lib/PairingDialog.svelte
  - apps/gui/src/lib/AccountPane.svelte
  - apps/gui/src/lib/AccountMenu.svelte
  - apps/gui/src/lib/DevicesSection.svelte
  - apps/gui/src/lib/DeviceSession.svelte
  - crates/kode-bridge/src/remote_devices.rs
  - apps/mobile/lib/src/api/account_client.dart
  - apps/mobile/lib/src/state/providers.dart
  - deploy/Dockerfile.relay
---

# Kode multi-account relay v1

`kode-relay` serves many accounts from one deployment. It complements the
single-user [cloud sync server](./cloud-sync-protocol.md), which is unchanged:
self-hosted servers keep QR pairing, SQLite mirrors and their own frames.

## Trust model

- Identity comes from an external OIDC provider (CloudBase Auth). The relay
  verifies RS256 access tokens locally against `<issuer>/auth/v1/certs`,
  requiring `iss`, `exp`, `sub` and `role: authenticated`, and rejecting
  `user_type: anonymous`. The provider's keys may also sign API and
  publishable keys, which must never own a tenant. CloudBase sets `aud` to the
  environment id; pin it with `KODE_RELAY_AUDIENCE`.
- **The tenant is the token's `sub`. Nothing else selects a tenant.** Paths,
  bodies, headers and query strings only name things inside that tenant.
- Unknown and foreign devices or sessions are the same `404`. Invalid tokens
  are `401`; an unreachable JWKS is `503`.
- Open agent and phone sockets re-verify their token every 5 minutes and close
  once it expires; clients reconnect with a refreshed token.
- Verification is local, so provider-side revocation is not seen: a deleted
  user's access token keeps working until `exp` (at most 2 hours on CloudBase;
  measured against a live environment).
- Nothing is persisted. Session lists are the last desktop snapshot, history
  is read from the desktop per request, and the process holds no content
  once a desktop stops streaming.

## Tenant isolation invariants

1. State lives in `Tenant` objects keyed by `sub`; there is no cross-tenant
   index. Device ids are scoped per tenant, so two accounts may use the same
   id without conflict.
2. Command receipts and setup replies are looked up inside the replying
   device only; an agent cannot settle another desktop's request.
3. Every device route is covered by the cross-tenant test
   `every_device_route_hides_foreign_devices`; a new route must join it.

## Desktop agent

`GET /api/v1/agent/ws?device_id=<installation id>&name=<host name>` with
`Authorization: Bearer <account access token>`. One socket per
`(tenant, device_id)`; a second is `409`.

Frames are `kode-relay-protocol::{AgentFrame, ServerFrame}`, identical to the
sync server's wire format. For the relay:

- `server.hello` / `binding.changed` carry `sync_enabled` = "a phone is
  viewing" and `binding_count` = open phone sockets.
- The agent uploads hello snapshots and events only while `sync_enabled`.
  The relay ignores uploads that arrive while disabled.
- `setup.request` kind `history` with `{local_session_id, from, limit}`
  returns `{events}`: the desktop's semantic timeline without `pty_bytes`,
  `shell.pty_bytes` or `session.status`; `from = 0` is the newest window.
- Dispatched commands that are still live are re-sent when an agent
  reconnects; the agent's receipt ledger prevents double execution.

The desktop stores the account session in `cloud-sync.json` (mode `0600`) on
a backend with `kind: account_relay`, refreshes the access token five minutes
before expiry, and shows `standby` while connected but not uploading.

## Viewer gate

Streaming is on while a phone socket is open or a viewing lease is live.
Every phone REST call and every closed phone socket extends the lease to now
+ 60 s. When streaming turns on, list/get requests wait up to 5 s for the
desktop's snapshot. When the lease lapses with no socket open, the relay
sends `binding.changed{sync_enabled:false}` and marks its snapshot stale.

## Phone API

Same paths and bodies as the sync server; the desktop is named by the
`X-Kode-Device` header, or `?device_id=` on `/ws`.

- `GET /api/v1/account/devices` → `{devices:[{device_id,name,online,last_seen_at}]}`
- `GET|POST /api/v1/sessions`, `GET|DELETE /api/v1/sessions/:id`,
  `GET /sessions/:id/history`, `POST /sessions/:id/{input,interrupt,answer,plan_response,mode,model}`
- `GET /api/v1/backends`, `/api/v1/backends/:key/models`, `/api/v1/fs/list`
- `GET /ws?device_id=` sends `connection.hello{server_kind:"kode-relay",...}`
- `DELETE /api/v1/bindings/current` is accepted as a no-op.

Phone session ids are relay-assigned and reset when the relay restarts;
phones refresh on `connection.hello`. Ordinary local ids are scoped by
`boot_id`; shared-runtime ids (`>= 2^40`) are stable across boots.

`/history` merges the desktop page with command receipts kept for 5 minutes,
so phones waiting on `command.status` through history keep working.

Phones close relay sockets when the app leaves the foreground, which lets
the lease lapse and the desktop stop uploading.

## Desktop viewer

A signed-in desktop can view and converse with the account's other desktops
through the same phone API, using its own account token (the relay does not
distinguish viewers). The workbench service exposes only
`POST /api/v1/messaging/cloud/account/devices` with a typed request
(`kode-bridge::remote_devices::Request`): `devices`, `sessions`, `history`
and `command` with `op` in `input | interrupt | answer | plan_response`.
Session creation, deletion, mode and model changes stay phone/owner-only.

- `devices` adds `self_device_id` (this installation) so the GUI hides itself.
- The device list does not extend a viewing lease. Session lists load only
  for devices the user expands, and the open conversation polls `/history`
  every 2 s while the window is visible, so a remote desktop streams only
  while someone is looking at it.
- Grouped AskUserQuestion answers are sent in order, each waiting for its
  `command.status` receipt, with `submit` on the last one (same as mobile).

## Client configuration

Clients ship without a relay, so source builds never point users at someone
else's service. The desktop reads its default at runtime: `KODE_RELAY_URL`,
else `[account] relay_url` in its `config.toml`. Mobile builds take
`--dart-define-from-file=relay.env` (see `apps/mobile/relay.env.example`).
Otherwise users enter the relay URL; the last one used is remembered.

## Sign-in (CloudBase HTTP API)

Clients read the issuer from the relay's `/api/v1/healthz` and require it to
be HTTPS (plain HTTP only on loopback).

1. `POST /auth/v1/verification {email, target:"ANY"}` → `{verification_id, expires_in, is_user}`
2. `POST /auth/v1/verification/verify {verification_id, verification_code}` → `{verification_token}`
3. `POST /auth/v1/signin` (or `/signup` when `is_user` is false)
   `{email, verification_token}` → `{access_token, refresh_token, expires_in, sub}`
4. Refresh: `POST /auth/v1/token {grant_type:"refresh_token", refresh_token}`.
   The documented `/auth/v1/token/refresh` path does not exist. CloudBase
   rotates the refresh token on use, so clients must save the new one.

### Device ids and concurrent sessions

Every client keeps one `x-device-id` per install and sends it on all
sign-in and refresh calls, to CloudBase and to the relay's sign-in routes
(`/api/v1/auth/palm`, `…/palm/register/finish`, `…/palm/handoff`,
`/api/v1/auth/palmx`). Desktops use their `installation_id`; phones store a
v4 UUID in app-private storage (not the Keychain, so a reinstall is a new
device). The relay forwards it to `/auth/v1/signin/custom`; a handoff is
signed in with the id the waiting desktop sent to `…/handoff`, not the
approving phone's. Ids must be 8–64 characters of `[A-Za-z0-9_-]`; missing
or malformed ids get a fresh random id per sign-in.

When the relay signed everyone in with one fixed id, each sign-in revoked
the previous session's refresh token, so a phone sign-in logged the desktop
out. The environment's client `MaxDevice` (最大会话数) caps sessions per
user; it is 5, and the sixth sign-in evicts the oldest session.

## Sign-in methods

`/api/v1/healthz` lists `login_methods` in the relay's preferred order, e.g.
`[{id:"palm", app_id, sdk_url}, {id:"palmx", app_id, base_url}, {id:"email"}]`. Clients show only methods
listed there and ignore ids they don't know, so enabling a method (WeChat,
Google later) is relay configuration, not a client release. Relays without
the list offer email only.

## PalmX palm-scan sign-in (disabled)

Not offered: PalmX identities live in the platform-wide palm pool, while
Kode accounts live in Kode's own palm library (see Palm 1:N below). The
relay keeps the code for a later "link PalmX" option but never enables it.

PalmX is not an OIDC provider; the relay bridges it into CloudBase.

1. The client calls PalmX directly (no secret):
   `POST {base_url}/palm/openai/x/oauth/qr/authorize {AppId, CodeChallenge, CodeChallengeMethod:"S256", State}`
   → `data{SessionId, QrcodePayload, ExpiresAt}`. `QrcodePayload` is a
   `palmauth://scan?…` link: phones open it to launch PalmxApp, desktops
   render it as a QR. Poll `…/qr/poll {SessionId}` every 2 s until
   `Status` is `confirmed` (with `Code`), `denied` or `expired`. PalmX
   errors are HTTP 200 with a non-zero `code`.
2. `POST /api/v1/auth/palmx {code, code_verifier}` (no auth). The relay
   redeems the code with its PalmX API key for the user's `OpenId`, picks
   the CloudBase user — the account the OpenId is bound to, else the
   deterministic `px_<sha256(palmx:OpenId)[..28]>` — and signs a CloudBase
   custom-login ticket for it (`<key id>/@@/<RS256 JWT>`, 1024-bit key
   signed with the `rsa` crate; ring rejects keys that small). It returns
   CloudBase `{access_token, refresh_token, expires_in, sub, provider}`.
   Custom-login tokens carry `sub` = the ticket uid and `role:
   authenticated`, so tenant isolation is unchanged.
3. Linking: `POST /api/v1/auth/palmx/bind {code, code_verifier}` with the
   account's Bearer token stores `OpenId → sub`; `DELETE` unlinks;
   `GET /api/v1/account/logins` → `{linked:["palmx"]}`. A palm can be
   linked to one account (409 otherwise) and `px_` accounts can't link.
   Bindings live in `public.kode_palmx_bindings` with RLS on and no
   policies: only the relay's `service_role` API key reaches it; end-user
   tokens get 403 (verified live).

Secrets live only in the relay's environment: `KODE_RELAY_PALMX_API_KEY`,
`KODE_RELAY_CUSTOM_LOGIN_KEY` (the CloudBase key JSON from
`CreateCustomLoginKey`; the plural `CreateCustomLoginKeys` makes v1 keys
that v2 auth rejects) and `KODE_RELAY_SERVICE_KEY`. Regenerating the custom
key expires the previous one after two hours. Exchanges are capped at 60
per minute; PalmX codes are single-use; only business code 2090007 is
reported to users as "scan again".

## Palm 1:N sign-in (Palm H5 SDK)

Kode's own palm sign-in. Enrolment registers the palm under the Kode
account id itself (CloudBase `sub`, which fits Palm's `[A-Za-z0-9_-]{1,64}`),
so a 1:N match *is* the account and no mapping table exists.

- `GET /palm/capture?mode=recognition|registration&app_id&token&user_id`
  serves a static page that loads the SDK loader (`sdk_url`) and returns
  `{code, message, data:{sessionId,…}}` through the `KodePalm` JS channel or
  a `kodepalm://result#<json>` navigation that hosts intercept. CSP allows
  only the SDK origin; `referrer` is `no-referrer` because the SDK answers
  `document.referrer`'s origin. Needs iOS 16.4+ (SIMD wasm, MediaRecorder);
  WKWebView must add `Safari` to its UA or the SDK picks the wrong format.
- `POST /api/v1/auth/palm {session_id}` (no auth). The relay reads the
  session with its API key (`get_session_result`) and accepts it only if it
  is a search with `IsMatch: true`, not a registration, with a valid
  `UserId`. Sessions stay readable for two hours, so each is claimed once in
  `public.kode_palm_sessions` (RLS on, no policies); a reused one is `409`.
  It then signs the custom-login ticket for `uid = UserId`. Rejections are
  `401 sign_in_rejected`.
- `POST /api/v1/palm/enroll_token` (Bearer) → `{token, user_id, app_id}`: an
  SDK user token (TTL 600 s) that can only enrol the caller's own `sub`.
  `GET /api/v1/palm` → `{enrolled, sides}`; `DELETE /api/v1/palm` deletes
  both sides. The client-reported user id is never trusted.
- Sign-up: `POST /api/v1/auth/palm/register` → `{registration_id, secret,
  user_id, token, app_id, expires_in:600}`; the relay mints `user_id`
  (`pl_…`) and the SDK token can enrol only that id. After a registration
  capture, `POST …/register/finish {registration_id, secret, session_id}`
  requires a registration session for exactly that id, claims it, and
  signs the new account in. Sign-ups are capped at 10 per minute; the SDK
  rejects palms already in the library (10103/10104).
- CloudBase test domains (`*.tcloudbase.com`) show a notice page on browser
  navigations, so clients fetch `/palm/capture` over HTTP and load it
  locally (mobile: HTML with the relay as base URL; desktop: a one-shot
  `127.0.0.1` server). The CSP is also in a `<meta>` tag for that reason.
- Desktop handoff: `POST /api/v1/auth/palm/handoff` → `{handoff_id, secret,
  expires_in:120}`; the desktop shows `kode://palm-login?relay=<url>&id=<id>`
  and polls `GET …/handoff/:id?secret=` (tokens are released once). The
  phone scans the QR, runs a recognition capture, and posts
  `POST …/handoff/:id/approve {session_id}`, verified like sign-in. Handoffs
  live in memory and vanish on restart.
- Phones offer palm first when the relay lists it and the device can run
  the SDK; they ask for consent before every capture and enrol/delete from
  the account menu. Desktops show the handoff QR; local-camera capture on
  the Mac waits on recognition-quality tests.

## Deployment

One container instance (see `deploy/README-relay.md`). Desktops keep agent
sockets open, so the instance stays resident; costs scale with uptime, not
content. A later phase replaces the resident socket with an on-demand wake
signal so the relay can scale to zero.

## Open verification items

- Palm capture on real devices (iPhone Safari/WKWebView, Android WebView,
  Mac camera) and whether anonymous 1:N calls share one rate bucket.
- 云托管 WebSocket idle timeout and HTTP access routing for upgrades.
- Email delivery and the signin/signup calls with a real emailed code. Token
  verification, refresh and tenant isolation were verified against the live
  provider using username sign-in.
- Claims of a real publishable or API key, to confirm the `role` check rejects
  them; only constructed tokens have been tested.
- A low-cost wake channel (CloudBase Realtime broadcast/presence) for the
  scale-to-zero phase.
