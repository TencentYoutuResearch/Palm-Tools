#!/usr/bin/env bash
# update-specops.sh — 开发者热更新已安装 kode.app 内的 SpecOps sidecar。
# 正式发布仍必须使用 ./run.sh app;本脚本会把 app 改为本机 ad-hoc 签名。
# 用法: ./scripts/update-specops.sh [--no-restart]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPECOPS_DIR="$WORKSPACE_ROOT/apps/specops"
APP_BUNDLE="/Applications/kode.app"
APP_BIN="$APP_BUNDLE/Contents/MacOS/specops"
RESTART=true

for arg in "$@"; do
  [[ "$arg" == "--no-restart" ]] && RESTART=false
done

# ── 1. 确认 app bundle 存在 ──────────────────────────────────────────────
if [[ ! -f "$APP_BIN" ]]; then
  echo "✗ 未找到 $APP_BIN，请先安装 kode.app 到 /Applications"
  exit 1
fi

# ── 2. 编译 specops sidecar（Bun single binary，内嵌所有静态资源）────────
echo "▶ 编译 specops..."
cd "$SPECOPS_DIR"
# 确保依赖是最新的（frozen-lockfile 跳过 lockfile 更新）
pnpm install --frozen-lockfile --silent
pnpm exec bun build src/cli/main.ts --compile --minify --outfile /tmp/specops-update
"/tmp/specops-update" --version >/dev/null
echo "   编译完成: $(du -sh /tmp/specops-update | cut -f1)"

# ── 3. 替换 .app bundle 内的 specops 二进制 ──────────────────────────────
echo "▶ 替换 $APP_BIN..."
# macOS 不允许直接覆盖已运行的二进制，先删后复制
if pgrep -xq "specops" 2>/dev/null; then
  echo "   停止正在运行的 specops 进程..."
  pkill -x "specops" 2>/dev/null || true
  sleep 0.5
fi

# 移除旧文件再写入（绕过 macOS 运行中文件锁定）
rm -f "$APP_BIN"
install -m 0755 /tmp/specops-update "$APP_BIN"
echo "   替换完成 ✓"

# 替换 bundle 内容会破坏原签名。热更新只用于本机调试,因此重新做 ad-hoc
# 签名;对外分发必须回到 `./run.sh app` 生成正式签名产物。
echo "▶ 重新签名本机调试 app..."
codesign --force --deep --sign - "$APP_BUNDLE"
codesign --verify --deep --strict "$APP_BUNDLE"

# ── 4. 可选：重启 kode.app ──────────────────────────────────────────────
if [[ "$RESTART" == "true" ]]; then
  if pgrep -xq "kode-gui" 2>/dev/null; then
    echo "▶ 重启 kode..."
    pkill -x "kode-gui" 2>/dev/null || true
    sleep 1
  fi
  open "$APP_BUNDLE"
  echo "   kode 已重启，用 Cmd+S 打开 SpecOps ✓"
else
  echo "ℹ  跳过重启（--no-restart）"
  echo "   在 kode 里关闭并重新用 Cmd+S 打开 SpecOps 即可生效"
fi

echo ""
echo "✓ specops 更新完成"
