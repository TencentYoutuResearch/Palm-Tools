# Kode centralized sync deployment

This stack runs the Rust sync/router service behind Caddy. Caddy obtains and
renews the public TLS certificate; SQLite data and certificates live in named
Docker volumes.

For Tencent DevCloud hosts whose public HTTPS response contains
`X-Proxy-By: AIO-Forward`, AIO already terminates TLS. Set
`KODE_SYNC_CADDYFILE=Caddyfile.sync.devcloud` so the local Caddy listener does
not redirect AIO's HTTP upstream request back to the same public HTTPS URL.

## Prerequisites

- A Linux host with Docker Engine and the Compose plugin.
- A public DNS `A`/`AAAA` record pointing at the host.
- Inbound TCP 80/443 and UDP 443 allowed by the firewall/security group.

On DevCloud/AIO, the platform-managed ingress replaces the direct DNS and ACME
requirements. Its upstream must target this VM's HTTP port 80 and support
WebSocket upgrades.

## Deploy

```bash
cd kode
chmod +x deploy/deploy-sync-server.sh
./deploy/deploy-sync-server.sh init
# Edit deploy/.env.sync and replace sync.example.com.
# On DevCloud/AIO also set KODE_SYNC_CADDYFILE=Caddyfile.sync.devcloud.
./deploy/deploy-sync-server.sh up
./deploy/deploy-sync-server.sh smoke
```

Then open Kode desktop's command palette, choose **Show Pairing QR…**, enter
`https://<KODE_SYNC_DOMAIN>`, and create a one-time QR. Scan it in Kode Mobile.

## Deploy from the desktop app over SSH

Release builds can embed a static Linux service bundle:

```bash
bash deploy/build-sync-server.sh
```

In **Mobile sync relay**, choose **Deploy over SSH** and provide the SSH host,
ports, and public HTTPS origin. Kode uploads and starts the service, verifies
the remote and public health routes, saves it as a switchable backend, and then
shows the one-time QR.

This path assumes the public HTTPS ingress already exists and forwards HTTP and
WebSocket traffic to the selected service port. Kode reuses system SSH config
and ssh-agent; it does not collect passwords or private keys. Data is preserved
under `~/.local/kode-sync-server/data` across redeployments. The bundled service
currently targets x86_64 Linux; the app checks the remote architecture and base
commands before it uploads anything.

## Operations

```bash
./deploy/deploy-sync-server.sh status
./deploy/deploy-sync-server.sh logs
./deploy/deploy-sync-server.sh restart
./deploy/deploy-sync-server.sh down
```

`down` does not remove volumes. Do not add `-v` unless you intentionally want
to delete all device bindings, sessions, events, and Caddy certificates.

The application database is `/data/kode-sync.db` in the `kode-sync-data`
volume. SQLite runs in WAL mode. Back up the named volume (including the
database, `-wal`, and `-shm` files) from a stopped `sync-server` container for a
consistent filesystem-level snapshot.
