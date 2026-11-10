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
| `KODE_RELAY_PALMX_BASE` | no | PalmX API origin; defaults to `https://open.intl.palm.tencent.com`. |
| `KODE_RELAY_PALM_SDK_URL` | no | Palm H5 SDK loader for `/palm/capture`; defaults to `<PALMX_BASE>/palm/x/jssdk/loader/palm-mobile-manager.js`. Palm 1:N sign-in reuses the PalmX app id, API key and service key, and also needs the `kode_palm_sessions(session_id text primary key, used_at timestamptz default now())` table with RLS on and no policies. |

PalmX stays disabled unless all four PalmX values are set.

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
