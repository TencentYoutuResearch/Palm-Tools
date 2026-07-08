#!/usr/bin/env bash
# Build a deployable remote bridge bundle:
#   - kode-bridge: headless Rust bridge server for remote sessions
#   - kode-memory: CLI used by remote memory review endpoints
#   - kode-memory-mcp: stdio MCP server used by remote agents
#
# Usage:
#   bash deploy/build-remote-memory-bridge.sh
#   bash deploy/build-remote-memory-bridge.sh --docker
#   bash deploy/build-remote-memory-bridge.sh --musl
#   APT_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian APT_SECURITY_MIRROR=https://mirrors.tuna.tsinghua.edu.cn/debian-security bash deploy/build-remote-memory-bridge.sh --docker
#   DOCKER_PLATFORM=linux/arm64 TARGET_TRIPLE=aarch64-unknown-linux-gnu bash deploy/build-remote-memory-bridge.sh --docker
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="native"
MUSL=0

for arg in "${@}"; do
  case "$arg" in
    --docker) MODE="docker" ;;
    --musl) MUSL=1 ;;
    -h|--help)
      sed -n '1,18p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

TARGET_TRIPLE="${TARGET_TRIPLE:-}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-}"
APT_MIRROR="${APT_MIRROR:-}"
APT_SECURITY_MIRROR="${APT_SECURITY_MIRROR:-}"
BUILDER_IMAGE="${BUILDER_IMAGE:-}"
VERSION="${VERSION:-dev}"
OUT_DIR="${OUT_DIR:-$ROOT/target/remote-memory-bridge}"
STAGE="$OUT_DIR/stage"

build_native() {
  if [[ -z "$TARGET_TRIPLE" ]]; then
    TARGET_TRIPLE="$(rustc --print host-tuple)"
  fi
  cargo build --release \
    -p kode-bridge --bin kode-bridge \
    -p kode-memory --bin kode-memory \
    -p kode-memory --bin kode-memory-mcp \
    --manifest-path "$ROOT/Cargo.toml"
}

build_docker() {
  if [[ $MUSL -eq 1 ]]; then
    build_docker_musl
    return
  fi
  if [[ -z "$TARGET_TRIPLE" ]]; then
    TARGET_TRIPLE="x86_64-unknown-linux-gnu"
  fi
  if [[ -z "$DOCKER_PLATFORM" ]]; then
    case "$TARGET_TRIPLE" in
      x86_64-unknown-linux-gnu) DOCKER_PLATFORM="linux/amd64" ;;
      aarch64-unknown-linux-gnu) DOCKER_PLATFORM="linux/arm64" ;;
      *)
        echo "unsupported docker target: $TARGET_TRIPLE" >&2
        echo "set DOCKER_PLATFORM explicitly if you know what you are doing" >&2
        exit 2
        ;;
    esac
  fi
  if [[ -z "$BUILDER_IMAGE" ]]; then
    BUILDER_IMAGE="kode-remote-memory-bridge-builder:${TARGET_TRIPLE}"
  fi

  DOCKER_BUILDKIT=0 docker build \
    --platform "$DOCKER_PLATFORM" \
    --build-arg RUST_IMAGE=rust:1.89-bookworm \
    --build-arg APT_MIRROR="$APT_MIRROR" \
    --build-arg APT_SECURITY_MIRROR="$APT_SECURITY_MIRROR" \
    -f "$ROOT/deploy/remote-memory-bridge-builder.Dockerfile" \
    -t "$BUILDER_IMAGE" \
    "$ROOT/deploy"

  mkdir -p "$ROOT/target/docker-cargo-home"
  docker run --rm \
    --platform "$DOCKER_PLATFORM" \
    -e TARGET_TRIPLE="$TARGET_TRIPLE" \
    -e VERSION="$VERSION" \
    -e CARGO_HOME=/cargo-home \
    -v "$ROOT/target/docker-cargo-home:/cargo-home" \
    -v "$ROOT:/work" \
    -w /work \
    "$BUILDER_IMAGE" \
    bash -lc '
      set -euo pipefail
      export PATH="/usr/local/cargo/bin:$PATH"
      cargo build --release \
        -p kode-bridge --bin kode-bridge \
        -p kode-memory --bin kode-memory \
        -p kode-memory --bin kode-memory-mcp \
        --manifest-path /work/Cargo.toml
      chown -R '"$(id -u):$(id -g)"' /work/target
      chown -R '"$(id -u):$(id -g)"' /cargo-home
    '
}

build_docker_musl() {
  # musl static build — glibc-free, runs on any Linux 2.6.32+
  TARGET_TRIPLE="x86_64-unknown-linux-musl"
  DOCKER_PLATFORM="linux/amd64"
  if [[ -z "$BUILDER_IMAGE" ]]; then
    BUILDER_IMAGE="kode-remote-memory-bridge-builder:${TARGET_TRIPLE}"
  fi

  DOCKER_BUILDKIT=0 docker build \
    --platform "$DOCKER_PLATFORM" \
    -f "$ROOT/deploy/remote-memory-bridge-builder-musl.Dockerfile" \
    -t "$BUILDER_IMAGE" \
    "$ROOT/deploy"

  mkdir -p "$ROOT/target/docker-cargo-home"
  docker run --rm \
    --platform "$DOCKER_PLATFORM" \
    -e CARGO_HOME=/cargo-home \
    -v "$ROOT/target/docker-cargo-home:/cargo-home" \
    -v "$ROOT:/work" \
    -w /work \
    "$BUILDER_IMAGE" \
    sh -c '
      set -e
      export PATH="/usr/local/cargo/bin:$PATH"
      cargo build --release --target '"$TARGET_TRIPLE"' \
        -p kode-bridge --bin kode-bridge \
        -p kode-memory --bin kode-memory \
        -p kode-memory --bin kode-memory-mcp \
        --manifest-path /work/Cargo.toml
      chown -R '"$(id -u):$(id -g)"' /work/target
      chown -R '"$(id -u):$(id -g)"' /cargo-home
    '
}

make_bundle() {
  local target_dir="$ROOT/target/release"
  if [[ "$TARGET_TRIPLE" == "x86_64-unknown-linux-musl" ]]; then
    target_dir="$ROOT/target/$TARGET_TRIPLE/release"
  fi
  rm -rf "$STAGE"
  mkdir -p "$STAGE/bin"

  cp "$target_dir/kode-bridge" "$STAGE/bin/kode-bridge"
  cp "$target_dir/kode-memory" "$STAGE/bin/kode-memory"
  cp "$target_dir/kode-memory-mcp" "$STAGE/bin/kode-memory-mcp"

  cat > "$STAGE/README.md" <<'EOF'
# kode remote memory bridge bundle

This bundle is for a remote machine that already has `codebuddy` / `claude`
logged in. It runs the Rust bridge without the desktop GUI, and exposes:

- remote terminal sessions over `/api/v1/*` and `/ws`
- remote memory review endpoints over `/api/v1/memory/*`
- `kode-memory-mcp` for the remote agent to propose facts

## Install

```bash
./install.sh
```

`install.sh` automatically configures `memory` MCP for any detected
`codebuddy`, `claude`, `claude-internal`, and `codex` CLIs.

```bash
SKIP_MCP_SETUP=1 ./install.sh   # install binaries only
KODE_MEMORY_ROOT=/data/kode-memory ./install.sh
~/.local/kode-remote-memory-bridge/setup-mcp.sh  # rerun MCP setup later
```

## Run

```bash
KODE_BRIDGE_BIND=127.0.0.1 \
KODE_BRIDGE_PORT=9870 \
KODE_MEMORY_ROOT="$HOME/.kode-memory" \
"$HOME/.local/kode-remote-memory-bridge/bin/kode-bridge"
```

The bearer token is stored in `~/.kode/state.json` as `bridge_token`.

Use SSH mode in kode GUI:

- base_url: `http://127.0.0.1:9870`
- token: value of `~/.kode/state.json.bridge_token`
- ssh_host: `user@remote` or a `~/.ssh/config` host alias
- ssh_remote_port: `9870`

## systemd user service

```ini
[Unit]
Description=kode remote memory bridge
After=network.target

[Service]
Environment=KODE_BRIDGE_BIND=127.0.0.1
Environment=KODE_BRIDGE_PORT=9870
Environment=KODE_MEMORY_ROOT=%h/.kode-memory
ExecStart=%h/.local/kode-remote-memory-bridge/bin/kode-bridge
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```
EOF

  cat > "$STAGE/setup-mcp.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$SCRIPT_DIR/bin"
MCP_BIN="$BIN_DIR/kode-memory-mcp"
MEMORY_ROOT="${KODE_MEMORY_ROOT:-$HOME/.kode-memory}"
SERVER_NAME="${KODE_MEMORY_MCP_NAME:-memory}"

if [[ ! -x "$MCP_BIN" ]]; then
  echo "kode-memory-mcp not found or not executable: $MCP_BIN" >&2
  exit 1
fi

mkdir -p "$MEMORY_ROOT"

configured=0
failed=0

run_cmd() {
  local label="$1"
  shift
  echo "▶ configuring $label MCP..."
  if "$@"; then
    echo "✓ $label MCP configured"
    configured=$((configured + 1))
  else
    echo "✗ $label MCP setup failed" >&2
    failed=$((failed + 1))
  fi
}

if command -v codebuddy >/dev/null 2>&1; then
  # codebuddy/commander.js: positional command must be before variadic -e.
  run_cmd codebuddy \
    codebuddy mcp add -s user "$SERVER_NAME" "$MCP_BIN" -e "KODE_MEMORY_ROOT=$MEMORY_ROOT"
else
  echo "- codebuddy not found; skipped"
fi

for cli in claude claude-internal; do
  if command -v "$cli" >/dev/null 2>&1; then
    run_cmd "$cli" \
      "$cli" mcp add -s user "$SERVER_NAME" -e "KODE_MEMORY_ROOT=$MEMORY_ROOT" -- "$MCP_BIN"
  else
    echo "- $cli not found; skipped"
  fi
done

if command -v codex >/dev/null 2>&1; then
  run_cmd codex \
    codex mcp add "$SERVER_NAME" --env "KODE_MEMORY_ROOT=$MEMORY_ROOT" -- "$MCP_BIN"
else
  echo "- codex not found; skipped"
fi

echo "MCP setup summary: configured=$configured failed=$failed memory_root=$MEMORY_ROOT"
if [[ "$configured" -eq 0 ]]; then
  echo "No supported agent CLI was found on PATH. Install/login codebuddy, claude, or codex, then rerun: $SCRIPT_DIR/setup-mcp.sh" >&2
fi
if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
EOF
  chmod +x "$STAGE/setup-mcp.sh"

  cat > "$STAGE/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DEST="${DEST:-$HOME/.local/kode-remote-memory-bridge}"
mkdir -p "$DEST"
rm -rf "$DEST/bin"
cp -R "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bin" "$DEST/bin"
cp "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-mcp.sh" "$DEST/setup-mcp.sh"
chmod +x "$DEST/setup-mcp.sh"
echo "installed to $DEST"
echo "add to PATH: export PATH=\"$DEST/bin:\$PATH\""
if [[ "${SKIP_MCP_SETUP:-0}" != "1" ]]; then
  "$DEST/setup-mcp.sh"
else
  echo "MCP setup skipped by SKIP_MCP_SETUP=1"
fi
EOF
  chmod +x "$STAGE/install.sh"

  local archive="$OUT_DIR/kode-remote-memory-bridge-${TARGET_TRIPLE}.tar.gz"
  COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$archive" .
  echo "bundle ready: $archive"

  # musl 产物额外 copy 一份到 GUI Tauri resources 目录,供"部署远端 Bridge"面板
  # 打包进 app 使用(固定名,去掉 target triple,简化 resource_dir 查找)。
  # 非 musl 产物(darwin / gnu)不 copy —— 部署功能只面向远端 Linux 机器。
  if [[ "$TARGET_TRIPLE" == "x86_64-unknown-linux-musl" ]]; then
    local res_name="kode-remote-memory-bridge-linux-musl.tar.gz"
    local gui_res_dir="$ROOT/apps/gui/src-tauri/resources"
    mkdir -p "$gui_res_dir"
    cp "$archive" "$gui_res_dir/$res_name"
    echo "also copied to GUI resources: $gui_res_dir/$res_name"

    # 同步刷新 target/{debug,release}/resources/ 里的副本 ——
    # dev 模式 Tauri 的 resource_dir() 指向 target/debug/resources/,
    # release 模式指向 target/release/resources/。
    # 这些副本是上次 `tauri dev` / `tauri build` 启动时从 src-tauri/resources/
    # 复制过去的,如果 build-remote-memory-bridge.sh 重新构建后不刷新它们,
    # 部署会推上次的旧 tarball(典型坑:修了 bridge 代码,重新构建部署,
    # 但远端 binary 还是旧的)。
    local tconf
    for tconf in debug release; do
      local tdir="$ROOT/target/$tconf/resources"
      if [[ -d "$tdir" ]]; then
        cp "$archive" "$tdir/$res_name"
        echo "also refreshed: $tdir/$res_name"
      fi
    done

    # 刷新已打包的 .app bundle 里的 Resources/resources/ 副本
    # (release 模式部署时 resource_dir() 可能指向 .app/Contents/Resources/)
    local bundle_res="$ROOT/target/release/bundle/macos"
    if [[ -d "$bundle_res" ]]; then
      find "$bundle_res" -type d -name resources -path "*/kode.app/*" 2>/dev/null | while read -r d; do
        cp "$archive" "$d/$res_name"
        echo "also refreshed: $d/$res_name"
      done
    fi
  fi
}

cd "$ROOT"
if [[ $MUSL -eq 1 ]]; then
  # musl 静态编译强制走 Docker（Alpine + musl target）
  MODE="docker"
  build_docker_musl
elif [[ "$MODE" == "docker" ]]; then
  build_docker
else
  build_native
fi
make_bundle
