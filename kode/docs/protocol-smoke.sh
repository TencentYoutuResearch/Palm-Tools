#!/usr/bin/env bash
# kode 远程协议 v1 端到端 smoke 测试。
#
# 用法:
#
#   # 测 Rust bridge(GUI 启动后)— Rust 默认 backend 是 codebuddy
#   export KODE_BRIDGE_TOKEN=$(jq -r .bridge_token "$HOME/Library/Application Support/kode/state.json")
#   ./docs/protocol-smoke.sh
#
# 通用变量:
#   KODE_BRIDGE_HOST=127.0.0.1
#   KODE_BRIDGE_PORT=9870
#   KODE_BRIDGE_TOKEN=<bearer>     ← Rust bridge 必传
#   KODE_SMOKE_BACKEND=echo|codebuddy ← spawn 用哪个 backend(默认 codebuddy)
#
# Phase 11.1 协议补丁覆盖:
#   step 12 — connection.hello.protocol_features 必须含 resize/backends/fs.list/pty_bytes
#   step 13 — GET /backends 返回 backend 列表
#   step 14 — GET /fs/list 列举 $HOME 子目录
#   step 15 — GET /fs/list /etc 越权 400
#   step 16 — POST /sessions/:id/resize 三态(204/400/404)
#
# 依赖:curl(必须),jq + python3(可选)

set -euo pipefail

HOST="${KODE_BRIDGE_HOST:-127.0.0.1}"
PORT="${KODE_BRIDGE_PORT:-9870}"
TOKEN="${KODE_BRIDGE_TOKEN:-}"
BACKEND="${KODE_SMOKE_BACKEND:-codebuddy}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

BASE="http://$HOST:$PORT"

pretty() { if command -v jq >/dev/null 2>&1; then jq .; else cat; fi; }
step()   { printf "\n\033[36m== %s ==\033[0m\n" "$*"; }
fail()   { echo -e "\033[31mFAIL: $*\033[0m" >&2; exit 1; }

# ---------- 拿 token ----------

if [[ -z "$TOKEN" ]]; then
  for f in "$HOME/Library/Application Support/kode/state.json" \
           "$HOME/.config/kode/state.json"; do
    if [[ -f "$f" ]]; then
      TOKEN=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('bridge_token',''))" "$f" 2>/dev/null || true)
      [[ -n "$TOKEN" ]] && break
    fi
  done
fi

[[ -z "$TOKEN" ]] && fail "无 token,设 KODE_BRIDGE_TOKEN 环境变量"

H_AUTH=(-H "Authorization: Bearer $TOKEN")

# ---------- 测试 ----------

step "1) /healthz(无需鉴权)"
out=$(curl -fsS "$BASE/healthz")
[[ "$out" != "ok" ]] && fail "expected ok, got $out"
echo "  → $out"

step "2) 401 校验:无 token"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/v1/sessions" || true)
[[ "$HTTP" != "401" ]] && fail "expected 401, got $HTTP"
echo "  → 401 ✓"

step "3) 401 校验:错 token"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer wrong-token" "$BASE/api/v1/sessions" || true)
[[ "$HTTP" != "401" ]] && fail "expected 401, got $HTTP"
echo "  → 401 ✓"

step "4) GET /sessions(空 OK 也行)"
RESP=$(curl -fsS "${H_AUTH[@]}" "$BASE/api/v1/sessions")
echo "$RESP" | pretty
echo "$RESP" | grep -q '"sessions"' || fail "missing sessions key"

step "5) POST /sessions { backend_key=$BACKEND }"
RESP=$(curl -fsS "${H_AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"backend_key\":\"$BACKEND\"}" \
  "$BASE/api/v1/sessions") || fail "spawn failed (是否未配置 $BACKEND?)"
echo "$RESP" | pretty
SID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
[[ -z "$SID" || "$SID" == "0" ]] && fail "no SID"

step "6) GET /sessions/:id"
RESP=$(curl -fsS "${H_AUTH[@]}" "$BASE/api/v1/sessions/$SID")
echo "$RESP" | pretty
ID_BACK=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
[[ "$ID_BACK" != "$SID" ]] && fail "id mismatch"

step "7) POST /sessions/:id/input { text }"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${H_AUTH[@]}" -H "Content-Type: application/json" \
  -d '{"text":"hello\n"}' "$BASE/api/v1/sessions/$SID/input")
[[ "$HTTP" != "204" ]] && fail "input expected 204, got $HTTP"
echo "  → 204 ✓"

step "8) GET /sessions/:id/history"
sleep 0.3  # 让 session.created 落到 store / ring
RESP=$(curl -fsS "${H_AUTH[@]}" "$BASE/api/v1/sessions/$SID/history?limit=20")
echo "$RESP" | pretty | head -20
echo "$RESP" | grep -q "session.created" || fail "history missing session.created"

step "9) /answer 占位 500"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${H_AUTH[@]}" -H "Content-Type: application/json" \
  -d '{"question_id":"x","choice_index":0}' "$BASE/api/v1/sessions/$SID/answer")
[[ "$HTTP" != "500" ]] && fail "answer expected 500, got $HTTP"
echo "  → 500 ✓"

step "10) DELETE /sessions/:id"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${H_AUTH[@]}" "$BASE/api/v1/sessions/$SID")
[[ "$HTTP" != "204" ]] && fail "delete expected 204, got $HTTP"
echo "  → 204 ✓"

step "11) DELETE 后 GET → 404"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${H_AUTH[@]}" "$BASE/api/v1/sessions/$SID")
[[ "$HTTP" != "404" ]] && fail "after delete expected 404, got $HTTP"
echo "  → 404 ✓"

step "12) WS hello(若有 node + ws)"
if command -v node >/dev/null 2>&1 && [[ -d /tmp/node_modules/ws || -d node_modules/ws ]]; then
  WS_DIR=/tmp/node_modules/ws
  [[ -d node_modules/ws ]] && WS_DIR=$(pwd)/node_modules/ws
  TOKEN=$TOKEN node -e "
    const WebSocket = require('$WS_DIR');
    const ws = new WebSocket('ws://$HOST:$PORT/ws?token=' + process.env.TOKEN);
    let n = 0;
    let t = setTimeout(()=>{ console.error('  WS timeout'); process.exit(2); }, 3000);
    ws.on('message', m => {
      const e = JSON.parse(m.toString());
      console.log('  WS #' + (++n) + ' type=' + e.type + ' sid=' + e.session_id);
      if (e.type === 'connection.hello') {
        const feats = (e.payload && e.payload.protocol_features) || [];
        console.log('  protocol_features=' + JSON.stringify(feats));
        const required = ['resize', 'backends', 'fs.list', 'pty_bytes'];
        const missing = required.filter(x => !feats.includes(x));
        if (missing.length) {
          console.error('  FAIL: hello missing features ' + JSON.stringify(missing));
          process.exit(3);
        }
        clearTimeout(t);
        ws.close();
        process.exit(0);
      }
    });
    ws.on('error', e => { console.error('  WS ERR ' + e.message); process.exit(1); });
  " || echo "  (ws check skipped)"
else
  echo "  (跳过:需要 node + npm i ws 到 /tmp 或 cwd)"
fi

# ---------- 11.1 协议补丁:resize / backends / fs.list ----------

step "13) GET /backends"
RESP=$(curl -fsS "${H_AUTH[@]}" "$BASE/api/v1/backends")
echo "$RESP" | pretty
echo "$RESP" | grep -q '"backends"' || fail "missing backends key"

step "14) GET /fs/list?path=\$HOME(无越权)"
RESP=$(curl -s -o /tmp/kode-smoke-fslist.json -w "%{http_code}" "${H_AUTH[@]}" \
  "$BASE/api/v1/fs/list?path=$HOME")
[[ "$RESP" != "200" ]] && fail "fs.list HOME expected 200, got $RESP"
cat /tmp/kode-smoke-fslist.json | pretty | head -10
grep -q '"entries"' /tmp/kode-smoke-fslist.json || fail "missing entries"
echo "  → 200 ✓"

step "15) GET /fs/list?path=/etc(越权)→ 400"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "${H_AUTH[@]}" \
  "$BASE/api/v1/fs/list?path=/etc")
[[ "$HTTP" != "400" ]] && fail "fs.list /etc expected 400, got $HTTP"
echo "  → 400 ✓"

step "16) POST /sessions/\$SID/resize 流程"
# 重新 spawn 一个 session(前面那个已 delete)
RESP=$(curl -fsS "${H_AUTH[@]}" -H "Content-Type: application/json" \
  -d "{\"backend_key\":\"$BACKEND\"}" \
  "$BASE/api/v1/sessions") || fail "respawn for resize failed"
SID2=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")

# 16a 正常 resize
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${H_AUTH[@]}" \
  -H "Content-Type: application/json" -d '{"cols":120,"rows":40}' \
  "$BASE/api/v1/sessions/$SID2/resize")
[[ "$HTTP" != "204" ]] && fail "resize normal expected 204, got $HTTP"

# 16b cols=0 → 400
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${H_AUTH[@]}" \
  -H "Content-Type: application/json" -d '{"cols":0,"rows":40}' \
  "$BASE/api/v1/sessions/$SID2/resize")
[[ "$HTTP" != "400" ]] && fail "resize cols=0 expected 400, got $HTTP"

# 16c 不存在的 session → 404
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${H_AUTH[@]}" \
  -H "Content-Type: application/json" -d '{"cols":80,"rows":24}' \
  "$BASE/api/v1/sessions/99999/resize")
[[ "$HTTP" != "404" ]] && fail "resize 9999 expected 404, got $HTTP"

# cleanup
curl -s -o /dev/null -X DELETE "${H_AUTH[@]}" "$BASE/api/v1/sessions/$SID2"
echo "  → resize 三态全过 ✓"

echo
echo -e "\033[32m✓ smoke 端到端通过\033[0m"
