#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DSH_CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
ARTIFACT_DIR="$HOME/.dsh/artifacts"
ARTIFACT="$ARTIFACT_DIR/kode-dsh-0.1.0-local-$(date +%Y%m%d-%H%M%S).tgz"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 24 >/dev/null
fi

npm --prefix "$ROOT_DIR" test
npm --prefix "$ROOT_DIR" run build:bundle -- --target aarch64-apple-darwin
cp "$ROOT_DIR/dist/kode-dsh-0.1.0-darwin-arm64.tgz" "$ARTIFACT"
"$DSH_CLI" plugin --profile desktop add "$ARTIFACT"
cmp "$ROOT_DIR/src/agent-client.js" "$HOME/.dsh/profiles/desktop/node_modules/@kode/dsh/src/agent-client.js"

printf 'Installed %s\n' "$ARTIFACT"
osascript -e 'tell application "DeepSeek Harness" to quit' || true
osascript -e 'delay 2'
open -a "DeepSeek Harness"
