#!/usr/bin/env bash
# 编译 kode-memory / kode-memory-mcp 并拷贝到 src-tauri/binaries/ (Tauri sidecar)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TARGET=$(rustc --print host-tuple)
# Windows 产物带 .exe 后缀:tauri externalBin 按 <name>-<triple>.exe 查找,
# cargo 输出与 sidecar 命名都要补后缀。
EXE=""
case "$TARGET" in
  *-windows-*) EXE=".exe" ;;
esac
mkdir -p "$SCRIPT_DIR/src-tauri/binaries"

echo "▶ Building kode-memory sidecars for $TARGET ..."
cargo build --release -p kode-memory --bin kode-memory --bin kode-memory-mcp --manifest-path "$WORKSPACE_ROOT/Cargo.toml"

echo "▶ Building SpecOps sidecar for $TARGET ..."
SPECOPS_DIR="$WORKSPACE_ROOT/apps/specops"
pnpm --dir "$SPECOPS_DIR" install --frozen-lockfile
pnpm --dir "$SPECOPS_DIR" run build:frontend
# bun --compile 在 Windows 上会自动给 outfile 补 .exe,与 tauri 期望一致。
pnpm --dir "$SPECOPS_DIR" exec bun build "$SPECOPS_DIR/src/cli/main.ts" \
  --compile --minify --outfile "$SCRIPT_DIR/src-tauri/binaries/specops-${TARGET}"

cp "$WORKSPACE_ROOT/target/release/kode-memory$EXE" "$SCRIPT_DIR/src-tauri/binaries/kode-memory-${TARGET}$EXE"
cp "$WORKSPACE_ROOT/target/release/kode-memory-mcp$EXE" "$SCRIPT_DIR/src-tauri/binaries/kode-memory-mcp-${TARGET}$EXE"

echo "✓ Sidecars ready:"
echo "  - src-tauri/binaries/kode-memory-${TARGET}$EXE"
echo "  - src-tauri/binaries/kode-memory-mcp-${TARGET}$EXE"
echo "  - src-tauri/binaries/specops-${TARGET}$EXE"
