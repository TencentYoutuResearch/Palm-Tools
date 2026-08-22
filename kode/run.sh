#!/usr/bin/env bash
# kode 仓库统一脚本入口 ——
# 一站管 Rust workspace + GUI 前端 + Tauri 应用打包。
#
# 设计目标:
#   - 一个命令搞定常用循环,免得记 cargo / pnpm / tauri 三套
#   - 子命令分组清晰:dev / build / test / clean / quality
#   - 任何子命令都从仓库根目录跑(本脚本自动 cd 到自身目录)

set -euo pipefail

# 先把"用户调用脚本时的工作目录"记住,再 cd 到仓库根。
# 之后 dev / app 等需要传给子进程的 cwd 就用 INVOKE_PWD 而不是仓库根。
INVOKE_PWD="$PWD"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUI_DIR="$ROOT_DIR/apps/gui"
TAURI_DIR="$GUI_DIR/src-tauri"
SPECOPS_DIR="$ROOT_DIR/apps/specops"
TUI_BIN_NAME="kode-tui"

cd "$ROOT_DIR"

# ===== 颜色(ANSI-C quoting,heredoc / cat 也能正确显示) =====
B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
info()  { printf '%s%s▶%s %s%s%s\n' "$B" "$G" "$N" "$B" "$*" "$N"; }
warn()  { printf '%s%s!%s %s%s%s\n' "$B" "$Y" "$N" "$Y" "$*" "$N"; }
error() { printf '%s%s✗%s %s%s%s\n' "$B" "$R" "$N" "$R" "$*" "$N"; exit 1; }
hint()  { printf '  %s%s%s\n' "$D" "$*" "$N"; }
hdr()   { printf '\n%s%s== %s ==%s\n' "$B" "$C" "$*" "$N"; }

ensure_node_modules() {
  if [ ! -d "$GUI_DIR/node_modules" ]; then
    info "node_modules 不存在,在 $GUI_DIR 里跑 pnpm install"
    (cd "$GUI_DIR" && pnpm install)
  fi
}

# pnpm 11 要求 Node >= 22.13。用户默认 shell 可能还是 Node 20,
# 这里在脚本进程内自动经 nvm 切到 v22(不改用户的全局 default),避免每次手敲 nvm use。
ensure_node() {
  local cur major minor
  cur=$(node --version 2>/dev/null | sed 's/^v//')
  major=$(printf '%s' "$cur" | cut -d. -f1)
  minor=$(printf '%s' "$cur" | cut -d. -f2)
  if [ "${major:-0}" -gt 22 ] 2>/dev/null \
     || { [ "${major:-0}" -eq 22 ] 2>/dev/null && [ "${minor:-0}" -ge 13 ] 2>/dev/null; }; then
    return 0
  fi
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
    local best
    best=$(nvm ls --no-colors 2>/dev/null | grep -oE 'v22\.[0-9]+\.[0-9]+' | sort -V | tail -1)
    if [ -n "$best" ]; then
      nvm use --silent "$best" >/dev/null 2>&1 || true
      return 0
    fi
  fi
  error "需要 Node >= 22.13(pnpm 11 要求),当前为 ${cur:-缺失}。请先 'nvm use 22'。"
}
ensure_node

# rustup 装好后把 `source ~/.cargo/env` 写进 shell rc,但已开着的旧 shell 不会自动有。
# 这里兜底:cargo/rustc 不在 PATH 时 source 一次 ~/.cargo/env。
ensure_rust() {
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    return 0
  fi
  if [ -s "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env" >/dev/null 2>&1 || true
  fi
  command -v cargo >/dev/null 2>&1 \
    || error "需要 Rust toolchain(cargo/rustc)。装 rustup:curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
}
ensure_rust

build_specops_dev() {
  if [ ! -d "$SPECOPS_DIR/node_modules" ]; then
    info "SpecOps node_modules 不存在,在 $SPECOPS_DIR 里跑 pnpm install"
    (cd "$SPECOPS_DIR" && pnpm install --frozen-lockfile)
  fi
  info "构建 SpecOps 开发产物"
  (cd "$SPECOPS_DIR" && pnpm build)
}

ensure_sync_server_bundle() {
  local resource="$TAURI_DIR/resources/kode-sync-server-linux-musl.tar.gz"
  local stale=0
  if [ ! -s "$resource" ]; then
    stale=1
  elif find "$ROOT_DIR/crates/kode-sync-server" "$ROOT_DIR/Cargo.toml" "$ROOT_DIR/Cargo.lock" \
      -type f -newer "$resource" -print -quit | grep -q .; then
    stale=1
  fi
  if [ "$stale" -eq 1 ]; then
    command -v docker >/dev/null 2>&1 \
      || error "发布包需要内置 Linux sync server,但没有找到 Docker。请先安装/启动 Docker,或手动生成 resources/kode-sync-server-linux-musl.tar.gz。"
    info "构建并嵌入 x86_64 Linux sync server"
    bash "$ROOT_DIR/deploy/build-sync-server.sh"
  else
    info "sync server 内置资源已是最新"
  fi
}

# 全局初始化,避免 set -u 下 ${TAURI_RESOURCE_ARGS[@]} 报 unbound
TAURI_RESOURCE_ARGS=()

set_tauri_resource_args() {
  local bridge_resource="$TAURI_DIR/resources/kode-remote-memory-bridge-linux-musl.tar.gz"
  local sync_resource="$TAURI_DIR/resources/kode-sync-server-linux-musl.tar.gz"
  TAURI_RESOURCE_ARGS=()
  if [ -f "$bridge_resource" ] && [ -f "$sync_resource" ]; then
    info "remote bridge 与 sync server 资源已存在,将打入 app"
  else
    local resources='["resources/skills"]'
    if [ -f "$bridge_resource" ]; then
      resources='["resources/skills","resources/kode-remote-memory-bridge-linux-musl.tar.gz"]'
    fi
    if [ -f "$sync_resource" ]; then
      if [ -f "$bridge_resource" ]; then
        resources='["resources/skills","resources/kode-remote-memory-bridge-linux-musl.tar.gz","resources/kode-sync-server-linux-musl.tar.gz"]'
      else
        resources='["resources/skills","resources/kode-sync-server-linux-musl.tar.gz"]'
      fi
    fi
    warn "部分 Linux 部署资源不存在,本次只打包现有资源"
    # 数组 override 会替换 tauri.conf.json 的全部 resources,因此始终保留 skills。
    TAURI_RESOURCE_ARGS=(--config "{\"bundle\":{\"resources\":$resources}}")
  fi
}

# tauri.conf.json 钉死了 Developer ID 签名证书。本机 keychain 没有该证书时,
# codesign 会失败;DMG 步骤也需要证书签名。这里检测后自动降级:
#   - 无证书 → ad-hoc 签名(signingIdentity=null)+ 只打 .app(跳过 DMG)
#   - 有证书 → 走原配置(打 .app + .dmg)
# CI 可设 KODE_FORCE_DMG=1 在 ad-hoc 模式下也生成 DMG(用户需手动绕过 Gatekeeper)。
SIGN_ARGS=()
BUNDLE_TARGETS=()
SIGN_ADHOC=0
set_signing_args() {
  SIGN_ARGS=()
  BUNDLE_TARGETS=()
  SIGN_ADHOC=0
  if ! security find-identity -p codesigning -v 2>/dev/null | grep -q "Developer ID Application"; then
    SIGN_ARGS=(--config '{"bundle":{"macOS":{"signingIdentity":null}}}')
    SIGN_ADHOC=1
    if [ "${KODE_FORCE_DMG:-0}" = "1" ]; then
      warn "未找到 Developer ID 签名证书 → ad-hoc 签名,KODE_FORCE_DMG=1 → 打 .app + .dmg"
      BUNDLE_TARGETS=(--bundles app,dmg)
    else
      warn "未找到 Developer ID 签名证书 → ad-hoc 签名,只打 .app(跳过 DMG)"
      BUNDLE_TARGETS=(--bundles app)
    fi
  fi
}

CMD="${1:-help}"
shift || true

case "$CMD" in
  # ===========================================================
  # 开发循环
  # ===========================================================
  dev)
    ensure_node_modules
    build_specops_dev
    # session 的 cwd 优先级:
    #   1. 命令行第 1 个参数(./run.sh dev /path/to/project)
    #   2. 已设置的 KODE_CWD
    #   3. ${B}调用 run.sh 时的当前目录${N} —— 你在哪儿敲命令,codebuddy 就在哪儿跑
    if [ -n "${1:-}" ]; then
      KODE_CWD_RESOLVED="$(cd "$1" && pwd)"
    elif [ -n "${KODE_CWD:-}" ]; then
      KODE_CWD_RESOLVED="$KODE_CWD"
    else
      KODE_CWD_RESOLVED="$INVOKE_PWD"
    fi
    info "启动 vite + tauri dev (Svelte HMR + Rust auto-rebuild)"
    hint "改 .svelte / .css / .ts 自动热更新"
    hint "改 src-tauri/ 或 crates/kode-core/ 会触发重编"
    hint "session cwd: ${KODE_CWD_RESOLVED}"
    hint "  覆盖方式:./run.sh dev /path/to/project   或   KODE_CWD=/path ./run.sh dev"
    hint "Ctrl+C 退出"
    set_tauri_resource_args
    export KODE_CWD="$KODE_CWD_RESOLVED"
    cd "$GUI_DIR"
    # --features devtools:启用 WKWebView devtools(右键 Inspect / F12 / Cmd+Opt+I)。
    # release 打包(./run.sh app)不传该 feature,最终用户机器上彻底关闭调试器。
    # `--` 后的参数会转发给 Cargo；Tauri 自身的 --config 必须放在它前面。
    exec pnpm tauri dev \
      ${TAURI_RESOURCE_ARGS[@]+"${TAURI_RESOURCE_ARGS[@]}"} \
      -- --features devtools
    ;;

  fe|frontend)
    ensure_node_modules
    info "重新打包前端 → apps/gui/dist/"
    (cd "$GUI_DIR" && pnpm build)
    info "完成。如果 .app 已经在跑,需要 quit + 重启或 ./run.sh open"
    ;;

  tui)
    info "启动 TUI 版(冻结的 v0.1)"
    hint "必须在真终端跑,不能在 IDE 输出面板"
    cargo run -p "$TUI_BIN_NAME" -- "$@"
    ;;

  # ===========================================================
  # 打包 / 安装
  # ===========================================================
  app|release)
    ensure_node_modules
    ensure_sync_server_bundle
    APP_PATH="$ROOT_DIR/target/release/bundle/macos/kode.app"
    DMG_DIR="$ROOT_DIR/target/release/bundle/dmg"
    # 避免打包中途失败后误装上一次遗留的 DMG。
    rm -f "$DMG_DIR"/kode_*.dmg

    set_tauri_resource_args
    set_signing_args

    info "完整打包 release .app(60-90s,首次更慢)"
    cd "$GUI_DIR"
    pnpm tauri build \
      ${TAURI_RESOURCE_ARGS[@]+"${TAURI_RESOURCE_ARGS[@]}"} \
      ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"} \
      ${BUNDLE_TARGETS[@]+"${BUNDLE_TARGETS[@]}"} \
      "$@"
    cd "$ROOT_DIR"
    shopt -s nullglob
    DMG_FILES=("$DMG_DIR"/kode_*.dmg)
    shopt -u nullglob
    # ad-hoc 模式只产 .app(跳过了 DMG);有证书时要求 .app + .dmg 都在。
    if [ -d "$APP_PATH" ] && { [ "$SIGN_ADHOC" -eq 1 ] || [ ${#DMG_FILES[@]} -gt 0 ]; }; then
      info "产物 → $APP_PATH"
      if [ ${#DMG_FILES[@]} -gt 0 ]; then
        for dmg in "${DMG_FILES[@]}"; do
          info "安装包 → $dmg"
        done
        hint "挂载 DMG 后把 kode.app 拖到 Applications,或 ./run.sh open 直接运行 bundle"
      else
        hint "ad-hoc 签名,未打 DMG。./run.sh open 直接运行,或手动拷到 /Applications"
      fi
      du -sh "$APP_PATH" 2>/dev/null | awk '{ printf "  '${D}'.app size: %s'${N}'\n", $1 }'
    else
      warn "打包命令结束但产物不完整,看看 $ROOT_DIR/target/release/bundle/ 里有什么"
      ls -la "$ROOT_DIR/target/release/bundle/" 2>/dev/null || true
      exit 1
    fi
    ;;

  open)
    APP_PATH="$ROOT_DIR/target/release/bundle/macos/kode.app"
    if [ ! -d "$APP_PATH" ]; then
      error "没找到 $APP_PATH。先跑 ./run.sh app"
    fi
    info "打开 $APP_PATH(自动 kill 旧实例)"
    pkill -f "kode.app/Contents/MacOS/kode" 2>/dev/null || true
    sleep 0.2
    open "$APP_PATH"
    ;;

  install-tui)
    info "编译 release TUI 并 install 到 ~/.cargo/bin/"
    cargo install --path "$ROOT_DIR/crates/kode-tui" --force
    hint "已安装。在终端任意位置 \`kode\` 启动 TUI 版"
    ;;

  # ===========================================================
  # 构建
  # ===========================================================
  build)
    info "构建整个 Rust workspace(debug)"
    cargo build --workspace "$@"
    ;;

  build-release|br)
    info "构建整个 Rust workspace(release,LTO + strip)"
    cargo build --workspace --release "$@"
    ;;

  build-core)
    info "只构建 kode-core(纯 Rust 逻辑,无 UI)"
    cargo build -p kode-core "$@"
    ;;

  build-tui)
    info "只构建 TUI"
    cargo build -p kode-tui "$@"
    ;;

  build-tauri)
    info "只构建 Tauri 后端(不打前端)"
    (cd "$TAURI_DIR" && cargo build "$@")
    ;;

  # ===========================================================
  # 测试 / 检查
  # ===========================================================
  test|t)
    info "cargo test --workspace -- --test-threads=1"
    hint "PTY 测试有 fd 竞争,必须单线程"
    cargo test --workspace -- --test-threads=1 "$@"
    ;;

  check)
    hdr "Rust workspace check"
    cargo check --workspace --all-targets
    hdr "Svelte / TypeScript check"
    ensure_node_modules
    (cd "$GUI_DIR" && pnpm check) || true
    hdr "cargo test --workspace -- --test-threads=1"
    cargo test --workspace -- --test-threads=1
    info "全部通过"
    ;;

  fmt)
    info "cargo fmt --all"
    cargo fmt --all
    ;;

  fmt-check)
    info "cargo fmt --all --check(CI 风格)"
    cargo fmt --all -- --check
    ;;

  clippy)
    info "cargo clippy --workspace --all-targets"
    cargo clippy --workspace --all-targets "$@"
    ;;

  # ===========================================================
  # 维护
  # ===========================================================
  clean)
    warn "将清理 target/ apps/gui/dist/ apps/gui/src-tauri/target/(确认?[y/N])"
    read -r ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
      rm -rf "$ROOT_DIR/target" "$GUI_DIR/dist" "$TAURI_DIR/target"
      info "清理完成"
    else
      info "取消"
    fi
    ;;

  size)
    hdr "Rust workspace target sizes"
    [ -d "$ROOT_DIR/target" ] && du -sh "$ROOT_DIR/target" 2>/dev/null || echo "  (no target/)"
    [ -d "$TAURI_DIR/target" ] && du -sh "$TAURI_DIR/target" 2>/dev/null || echo "  (no apps/gui/src-tauri/target/)"
    hdr "Frontend build outputs"
    [ -d "$GUI_DIR/dist" ] && du -sh "$GUI_DIR/dist" 2>/dev/null || echo "  (no dist/)"
    [ -d "$GUI_DIR/node_modules" ] && du -sh "$GUI_DIR/node_modules" 2>/dev/null || echo "  (no node_modules/)"
    APP_PATH="$ROOT_DIR/target/release/bundle/macos/kode.app"
    if [ -d "$APP_PATH" ]; then
      hdr "Release app"
      du -sh "$APP_PATH"
    fi
    ;;

  deps)
    hdr "Rust workspace deps (top-level)"
    cargo tree --workspace --depth 1 || true
    hdr "Frontend deps"
    (cd "$GUI_DIR" && pnpm list --depth 0) || true
    ;;

  version)
    NEW_VERSION="${1:-}"
    if [ -z "$NEW_VERSION" ]; then
      error "用法: ./run.sh version <版本号>  例: ./run.sh version 0.2.1-dev"
    fi
    hdr "更新版本号 → $NEW_VERSION"
    # 1. Cargo workspace version
    sed -i.bak 's/^version = ".*"/version = "'"$NEW_VERSION"'"/' "$ROOT_DIR/Cargo.toml"
    rm -f "$ROOT_DIR/Cargo.toml.bak"
    info "  Cargo.toml [workspace.package] → $NEW_VERSION"
    # 2. GUI package.json
    sed -i.bak 's/"version": *"[^"]*"/"version": "'"$NEW_VERSION"'"/' "$GUI_DIR/package.json"
    rm -f "$GUI_DIR/package.json.bak"
    info "  apps/gui/package.json → $NEW_VERSION"
    # 3. Tauri config
    sed -i.bak 's/"version": *"[^"]*"/"version": "'"$NEW_VERSION"'"/' "$TAURI_DIR/tauri.conf.json"
    rm -f "$TAURI_DIR/tauri.conf.json.bak"
    info "  apps/gui/src-tauri/tauri.conf.json → $NEW_VERSION"
    # 4. Refresh Cargo.lock
    cargo update -p kode-core --precise "$NEW_VERSION" 2>/dev/null || true
    cargo update -p kode-bridge --precise "$NEW_VERSION" 2>/dev/null || true
    cargo update -p kode-gui --precise "$NEW_VERSION" 2>/dev/null || true
    info "  Cargo.lock 已刷新"
    hint "git diff 确认后 commit"
    ;;

  # ===========================================================
  # 信息
  # ===========================================================
  status|st)
    hdr "Repo"
    git -C "$ROOT_DIR" status --short --branch
    hdr "Rust toolchain"
    rustc --version
    cargo --version
    hdr "Node / pnpm"
    node --version 2>/dev/null || echo "  node missing"
    pnpm --version 2>/dev/null || echo "  pnpm missing"
    hdr "Workspace members"
    cargo metadata --format-version 1 --no-deps 2>/dev/null \
      | python3 -c "import json,sys; m=json.load(sys.stdin); [print('  -', p['name'], 'v'+p['version']) for p in m['packages']]" \
      || warn "(cargo metadata 解析失败,跳过)"
    ;;

  help|--help|-h|"")
    printf '%skode run.sh%s  — 仓库统一脚本入口 (Rust workspace + GUI + Tauri)\n\n' "$B" "$N"
    printf '%s开发循环%s\n' "$C" "$N"
    printf '  %s./run.sh dev [cwd]%s     起 vite + tauri dev(HMR,最常用)\n' "$G" "$N"
    printf '                       %s└ cwd 默认 = 调用 run.sh 时的 PWD%s\n' "$D" "$N"
    printf '  %s./run.sh fe%s             只重打前端 dist/(快,需重启 .app)\n' "$G" "$N"
    printf '  %s./run.sh tui [args...]%s  跑 TUI 版(v0.1 冻结)\n\n' "$G" "$N"

    printf '%s打包 / 安装%s\n' "$C" "$N"
    printf '  %s./run.sh app%s            打 release .app(macOS bundle)\n' "$G" "$N"
    printf '  %s./run.sh open%s           打开当前 .app(自动 kill 旧实例)\n' "$G" "$N"
    printf '  %s./run.sh install-tui%s    把 TUI 装到 ~/.cargo/bin/kode\n\n' "$G" "$N"

    printf '%s构建%s\n' "$C" "$N"
    printf '  %s./run.sh build%s          整个 Rust workspace(debug)\n' "$G" "$N"
    printf '  %s./run.sh build-release%s  workspace release(LTO + strip)\n' "$G" "$N"
    printf '  %s./run.sh build-core%s     只构建 kode-core\n' "$G" "$N"
    printf '  %s./run.sh build-tui%s      只构建 TUI\n' "$G" "$N"
    printf '  %s./run.sh build-tauri%s    只构建 Tauri 后端(不打前端)\n\n' "$G" "$N"

    printf '%s测试 / 检查%s\n' "$C" "$N"
    printf '  %s./run.sh test%s           cargo test --workspace --test-threads=1\n' "$G" "$N"
    printf '  %s./run.sh check%s          %s全套%s: cargo check + svelte-check + cargo test\n' "$G" "$N" "$B" "$N"
    printf '  %s./run.sh fmt%s            cargo fmt --all\n' "$G" "$N"
    printf '  %s./run.sh fmt-check%s      检查格式(CI 风)\n' "$G" "$N"
    printf '  %s./run.sh clippy%s         cargo clippy --workspace --all-targets\n\n' "$G" "$N"

    printf '%s维护%s\n' "$C" "$N"
    printf '  %s./run.sh clean%s          清 target/ dist/(谨慎)\n' "$G" "$N"
    printf '  %s./run.sh size%s           各个产物体积\n' "$G" "$N"
    printf '  %s./run.sh deps%s           列依赖\n\n' "$G" "$N"

    printf '%s版本%s\n' "$C" "$N"
    printf '  %s./run.sh version <ver>%s  更新所有版本号(Cargo + package.json + tauri.conf.json)\n\n' "$G" "$N"

    printf '%s信息%s\n' "$C" "$N"
    printf '  %s./run.sh status%s         git/toolchain/workspace 摘要\n\n' "$G" "$N"

    printf '%s所有命令均从仓库根目录跑;脚本自动定位到 $ROOT。%s\n' "$D" "$N"
    ;;

  *)
    error "未知命令: ${CMD}。跑 ./run.sh help 查看支持的命令。"
    ;;
esac
