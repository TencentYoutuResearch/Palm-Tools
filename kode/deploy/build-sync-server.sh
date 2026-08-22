#!/usr/bin/env bash
# Build the static Linux sync service bundle embedded in the kode desktop app.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_TRIPLE="${TARGET_TRIPLE:-x86_64-unknown-linux-musl}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"
BUILDER_IMAGE="${BUILDER_IMAGE:-kode-sync-server-builder:${TARGET_TRIPLE}}"
CARGO_REGISTRY_VOLUME="${CARGO_REGISTRY_VOLUME:-kode-sync-server-cargo-registry}"
OUT_DIR="${OUT_DIR:-$ROOT/target/sync-server}"
STAGE="$OUT_DIR/stage"

if [[ "$TARGET_TRIPLE" != "x86_64-unknown-linux-musl" ]]; then
  echo "unsupported sync-server bundle target: $TARGET_TRIPLE" >&2
  exit 2
fi

DOCKER_BUILDKIT=0 docker build \
  --platform "$DOCKER_PLATFORM" \
  -f "$ROOT/deploy/remote-memory-bridge-builder-musl.Dockerfile" \
  -t "$BUILDER_IMAGE" \
  "$ROOT/deploy"

docker run --rm \
  --platform "$DOCKER_PLATFORM" \
  -v "$CARGO_REGISTRY_VOLUME:/usr/local/cargo/registry" \
  -v "$ROOT:/work" \
  -w /work \
  "$BUILDER_IMAGE" \
  sh -c '
    set -e
    export PATH="/usr/local/cargo/bin:$PATH"
    cargo build --release --locked --target '"$TARGET_TRIPLE"' \
      -p kode-sync-server --bin kode-sync-server \
      --manifest-path /work/Cargo.toml
  '

rm -rf "$STAGE"
mkdir -p "$STAGE/bin"
cp "$ROOT/target/$TARGET_TRIPLE/release/kode-sync-server" "$STAGE/bin/kode-sync-server"

ARCHIVE="$OUT_DIR/kode-sync-server-${TARGET_TRIPLE}.tar.gz"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$ARCHIVE" .

GUI_RESOURCE="$ROOT/apps/gui/src-tauri/resources/kode-sync-server-linux-musl.tar.gz"
cp "$ARCHIVE" "$GUI_RESOURCE"
for PROFILE in debug release; do
  RESOURCE_DIR="$ROOT/target/$PROFILE/resources"
  if [[ -d "$RESOURCE_DIR" ]]; then
    cp "$ARCHIVE" "$RESOURCE_DIR/kode-sync-server-linux-musl.tar.gz"
  fi
done

echo "sync server bundle ready: $ARCHIVE"
echo "embedded resource refreshed: $GUI_RESOURCE"
