# Kode account relay

`kode-relay` connects signed-in desktops with their owners' phones. It keeps
everything in memory: there is no database and no volume. See
`.specops/specs/account-relay-protocol.md` for the contract.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `KODE_RELAY_ISSUER` | yes | OIDC issuer whose JWKS signs access tokens. For CloudBase: `https://<env-id>.api.tcloudbasegateway.com` (keys at `/auth/v1/certs`). |
| `KODE_RELAY_AUDIENCE` | recommended | Expected `aud`; unchecked when unset. CloudBase uses the environment id. |
| `PORT` / `KODE_RELAY_BIND` | no | Listen port (default 8080) or full `host:port`. |
| `KODE_RELAY_DEPLOYMENT_ID` | no | Echoed by `/api/v1/healthz` to verify a rollout. |
| `KODE_RELAY_PALMX_APP_ID` | for PalmX | Public PalmX app id, published in `login_methods`. |
| `KODE_RELAY_PALMX_API_KEY` | for PalmX | PalmX OpenAPI key; redeems authorization codes. |
| `KODE_RELAY_CUSTOM_LOGIN_KEY` | for PalmX | CloudBase custom-login key JSON (`env_id`, `private_key_id`, `private_key`). |
| `KODE_RELAY_SERVICE_KEY` | for PalmX | CloudBase `api_key` (service role) for the `kode_palmx_bindings` table. |
| `KODE_RELAY_SESSION_SECRET` | recommended | At least 32 random bytes (`openssl rand -base64 48`). Enables per-device relay sessions; without it every sign-in shares CloudBase's single session per account and devices sign each other out. Rotating it signs every device out. |
| `KODE_RELAY_PALMX_BASE` | no | PalmX API origin; defaults to `https://open.intl.palm.tencent.com`. |
| `KODE_RELAY_PALM_SDK_URL` | no | Palm H5 SDK loader for `/palm/capture`; defaults to `<PALMX_BASE>/palm/x/jssdk/loader/palm-mobile-manager.js`. Palm 1:N sign-in reuses the PalmX app id, API key and service key, and also needs the `kode_palm_sessions(session_id text primary key, used_at timestamptz default now())` table with RLS on and no policies. |

PalmX stays disabled unless all four PalmX values are set.

Relay sessions persist in two CloudBase tables reached with
`KODE_RELAY_SERVICE_KEY` (create them before enabling the secret):

```sql
create table kode_relay_sessions (
  session_id text primary key, user_id text not null, device_id text not null,
  device_name text not null default '', method text not null default '',
  salt text not null, generation bigint not null default 0,
  rotated_at bigint not null, created_at bigint not null,
  last_used_at bigint not null, expires_at bigint not null, revoked_at bigint);
create index kode_relay_sessions_user on kode_relay_sessions (user_id);
create table kode_relay_profiles (
  user_id text primary key, name text not null default '',
  picture text not null default '', email text not null default '');
alter table kode_relay_sessions enable row level security;
alter table kode_relay_profiles enable row level security;
revoke all on kode_relay_sessions, kode_relay_profiles from anon, authenticated;
```

The `tcb cloudrun deploy` CLI asks whether to use a gray release when the
service already exists, even with `--force`; answer with a newline
(`printf '\n' | tcb cloudrun deploy …`) or it waits forever.

## Running locally

```bash
KODE_RELAY_ISSUER=https://<env-id>.api.tcloudbasegateway.com \
  cargo run -p kode-relay
curl -s http://127.0.0.1:8080/api/v1/healthz
```

## CloudBase 云托管

Run exactly one instance. Agent sockets, the viewer gate and command routing
live in that process, so a second instance would split desktops from phones.

1. Enable email sign-in in the CloudBase console (身份认证 → 登录方式) and
   configure its SMTP sender there.
2. Build from the repository root with `deploy/Dockerfile.relay`.
3. Deploy as a container service with min instances = max instances = 1 and
   `KODE_RELAY_ISSUER` and `KODE_RELAY_AUDIENCE` set; expose it through the HTTP access service with
   WebSocket enabled.
4. Check `GET /api/v1/healthz` reports `server_kind: kode-relay` and the
   issuer. Desktops and phones only need the relay URL.

The instance stays resident because desktops keep an agent socket open; they
upload nothing until a phone opens them.
