#!/usr/bin/env bash
# 编译 kode-memory / kode-memory-mcp 并拷贝到 src-tauri/binaries/ (Tauri sidecar)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TARGET=$(rustc --print host-tuple)
mkdir -p "$SCRIPT_DIR/src-tauri/binaries"

echo "▶ Building kode-memory sidecars for $TARGET ..."
cargo build --release -p kode-memory --bin kode-memory --bin kode-memory-mcp --manifest-path "$WORKSPACE_ROOT/Cargo.toml"

echo "▶ Building SpecOps sidecar for $TARGET ..."
SPECOPS_DIR="$WORKSPACE_ROOT/apps/specops"
pnpm --dir "$SPECOPS_DIR" install --frozen-lockfile
pnpm --dir "$SPECOPS_DIR" run build:frontend
pnpm --dir "$SPECOPS_DIR" exec bun build "$SPECOPS_DIR/src/cli/main.ts" \
  --compile --minify --outfile "$SCRIPT_DIR/src-tauri/binaries/specops-${TARGET}"

cp "$WORKSPACE_ROOT/target/release/kode-memory" "$SCRIPT_DIR/src-tauri/binaries/kode-memory-${TARGET}"
cp "$WORKSPACE_ROOT/target/release/kode-memory-mcp" "$SCRIPT_DIR/src-tauri/binaries/kode-memory-mcp-${TARGET}"

echo "✓ Sidecars ready:"
echo "  - src-tauri/binaries/kode-memory-${TARGET}"
echo "  - src-tauri/binaries/kode-memory-mcp-${TARGET}"
echo "  - src-tauri/binaries/specops-${TARGET}"
