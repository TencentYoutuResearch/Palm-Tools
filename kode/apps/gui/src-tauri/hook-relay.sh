#!/bin/bash
# kode-hook-relay: 把 stdin JSON 通过 Unix Domain Socket 发给 kode GUI。
#
# 用法: hook-relay.sh <socket-path>
# codebuddy/claude hook 会将 JSON 通过 stdin 传入本脚本,
# 本脚本通过 nc 转发到 kode GUI 的 HookRelay UDS。
#
# 安全:永远返回 0,不 block 子进程;socket 不存在时静默退出。

set -euo pipefail

SOCK="$1"

# Socket 不存在(可能 kode 已退出) → 静默退出
if [ -z "${SOCK:-}" ] || [ ! -S "$SOCK" ]; then
    exit 0
fi

# 读取 stdin 的全部内容,作为一行 JSON 发送
INPUT=$(cat)

if [ -z "$INPUT" ]; then
    exit 0
fi

# 用 nc 发送到 UDS。超时 1s,失败静默退出。
printf '%s\n' "$INPUT" | nc -U -w 1 "$SOCK" 2>/dev/null || true

exit 0
