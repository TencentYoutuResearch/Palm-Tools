#!/usr/bin/env bash
set -euo pipefail

dev_url="${KODE_GUI_DEV_URL:-http://127.0.0.1:1437}"

if curl --silent --fail --max-time 1 "$dev_url" >/dev/null; then
  echo "kode-gui: reusing existing Vite dev server at $dev_url"
  exit 0
fi

exec pnpm dev
