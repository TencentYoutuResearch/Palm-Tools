#!/usr/bin/env bash
# Exercise the real bundle guards without Docker or a native app build.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export ROOT_DIR="$fixture"
export TAURI_DIR="$fixture/tauri"
mkdir -p "$TAURI_DIR/resources"
info() { :; }
warn() { :; }
error() { echo "$*" >&2; exit 17; }
docker() { echo 'unexpected Docker invocation' >&2; exit 99; }
eval "$(sed -n '/^validate_prebuilt_linux_bundle() {/,/^# 全局初始化/{ /^# 全局初始化/d; p; }' "$root/run.sh")"
export KODE_USE_PREBUILT_LINUX_BUNDLES=1
printf 'fixture\n' > "$fixture/payload"
for name in kode-sync-server kode-remote-memory-bridge; do
  tar -czf "$TAURI_DIR/resources/$name-linux-musl.tar.gz" -C "$fixture" payload
done
# Later source timestamps must not invalidate same-run downloaded artifacts.
touch "$fixture/Cargo.toml" "$fixture/Cargo.lock"
ensure_sync_server_bundle
ensure_remote_bridge_bundle
for guard in ensure_sync_server_bundle ensure_remote_bridge_bundle; do
  if [ "$guard" = ensure_sync_server_bundle ]; then
    resource="$TAURI_DIR/resources/kode-sync-server-linux-musl.tar.gz"
  else
    resource="$TAURI_DIR/resources/kode-remote-memory-bridge-linux-musl.tar.gz"
  fi
  printf 'invalid archive\n' > "$resource"
  if ( "$guard" ) >/dev/null 2>&1; then
    echo 'corrupt bundle was accepted' >&2
    exit 1
  fi
  rm "$resource"
  if ( "$guard" ) >/dev/null 2>&1; then
    echo 'missing bundle was accepted' >&2
    exit 1
  fi
done
echo 'Prebuilt bundle checks passed'
