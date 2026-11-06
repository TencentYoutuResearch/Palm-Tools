---
schema_version: 1
id: remote/protocol
kind: spec
title: kode remote protocol v1 — REST + WebSocket contract
status: active
verifies:
  - rust
  - specops
paths:
  - apps/gui/src-tauri/src/bridge
  - services/kode-server-go
---

# kode 远程协议(v1)

> **目标读者**:Rust 桥(`apps/gui/src-tauri/src/bridge/`)与 Go server(`kode-server-go`)的实现者,以及 Flutter App(`kode-mobile`)的调用方。
>
> **本文是契约**。两端独立实现、互为黑盒,但都按本文实现。**任何不一致都是 bug**。
>
> **移动端更新**:本协议的直连鉴权/配对仅保留给 Bridge/SSH transport。Kode Mobile
> 已改用中心化会话镜像与命令路由,以
> [cloud-sync-protocol.md](./cloud-sync-protocol.md) 为准,不再读取桌面 LAN 地址。

## 1. 设计目标

1. **传输无关层语义化** — 不暴露 jsonl 原始字段;手机端拿到的是 message / tool_use / ask_user_question / plan_proposed / task_create-update,而不是 codebuddy/claude 内部 schema。
2. **后端可替换** — Rust 桥(联调)和 Go server(生产)实现同一组 REST + WS 端点;手机 App 切 endpoint 即可换。
3. **手机端原生交互** — `ask_user_question` 用原生 picker;`plan_proposed` 用全屏 markdown viewer;不要把 PTY 文本搬到手机。
4. **安全默认** — bearer token 强制鉴权;HTTPS 由反代(Tailscale / caddy)提供,server 自己只跑 HTTP。

## 2. 版本与兼容

- 顶层版本号 `v1`,反映在 URL 前缀(`/api/v1/`)和事件 envelope 的 `protocol_version` 字段。
- **破坏性变更必须升 v2**;新增字段不算破坏(客户端按 best-effort 解析,未知字段忽略)。
- 事件载荷里 `schema_version: 1`(整数)单独跟踪 payload 演化,REST 层版本独立。

## 3. 鉴权

- HTTP `Authorization: Bearer <token>`;WebSocket 用 query string `?token=<token>` 或 `Authorization` header(看实现)。
- token 类型:**opaque string**(Rust 桥)或 **JWT**(Go server);客户端不解析,原样回传。
- Bridge/SSH 直连首次配对可继续使用持久 bearer;手机配对改为中心服务两分钟一次性 QR,见 `cloud-sync-protocol.md`。
- 错误:鉴权失败一律 `401 Unauthorized`,响应体 `{"error":"unauthorized","detail":"..."}`。

### 3.1 `POST /api/v1/auth/login`

**请求**(JSON):
```json
{ "username": "...", "password": "..." }
```

**响应** 200:
```json
{ "token": "<bearer>", "expires_at": null }
```

- Rust 桥**不实现** `/login`(token 由 GUI 生成,直接 bearer)。
- Go server 实现:配置文件 `username + password_hash` → 校验通过返回 JWT。`expires_at` 为 RFC3339 字符串或 `null`(永不过期)。

## 4. REST 端点

所有端点都需要 `Authorization: Bearer`(`/auth/login` 除外)。

### 4.1 `GET /api/v1/sessions`

列出当前所有 session(活跃 + 历史)。

**响应** 200:
```json
{
  "sessions": [
    {
      "id": 1,
      "backend_key": "codebuddy",
      "title": "fix nav bug",
      "model": "claude-opus-4.7-1m",
      "status": "busy",
      "cwd": "/Users/foo/proj",
      "created_at": "2026-05-30T10:11:12Z",
      "session_uuid": "abc-123",
      "tokens": { "input": 1024, "output": 256, "cached": 0, "total": 1280 },
      "context_pct": 12.5,
      "cost_usd": 0.0123
    }
  ]
}
```

`status` ∈ `"starting" | "idle" | "busy" | "exited"`。

### 4.2 `POST /api/v1/sessions`

创建 session。**幂等性**:同 cwd + backend_key + 手机端提供的 client_request_id 视为重复请求(可选实现)。

**请求**:
```json
{
  "backend_key": "codebuddy",
  "cwd": "/Users/foo/proj",
  "resume_session_uuid": null
}
```

- `cwd` 可选;省略时:Rust 桥用桌面 GUI 当前 default cwd;Go server 用容器内默认工作目录。
- `resume_session_uuid` 给定时,走 `--resume`,jsonl 复用,历史立刻可见。

**响应** 200:同 4.1 的单条 session 对象。

### 4.3 `GET /api/v1/sessions/:id`

单条 session 详情(同 4.1 单条对象)。

### 4.4 `GET /api/v1/sessions/:id/history?from=<unix_ms>&limit=<n>`

历史消息回放,用于:切到老 session、首次连接补全、断线重连增量拉取。

**Query**:
- `from`:可选,unix 毫秒时间戳;只返回 `ts >= from` 的事件
- `limit`:可选,默认 200,最大 1000

**响应** 200:
```json
{
  "events": [<EventEnvelope>, ...],
  "next_from": 1717000000000
}
```

- `events` 数组按 `ts` 升序;`next_from` 是最后一个事件的 `ts + 1`,客户端下次 `from=next_from` 拉增量。
- **顺序保证**:同一 session 的事件按 jsonl 物理顺序输出(包括 message / tool_use / ask_user_question / plan_proposed / task_create / task_update / meta)。
- `meta` 事件**只回放最新一条**(语义层去重,避免回放上千条 token 增量),其它事件类型全量回放。

### 4.5 `POST /api/v1/sessions/:id/input`

向 PTY 发字节。

**请求(二选一)**:
```json
{ "text": "hello\n" }
```
或
```json
{ "bytes_b64": "aGVsbG8K" }
```

`text` 形式 server 端按 UTF-8 编码后写 PTY;`bytes_b64` 标准 base64 解码后写 PTY。**同时给 → 优先 bytes_b64,text 忽略**。

**响应** 204(无 body)。

### 4.6 `POST /api/v1/sessions/:id/answer`

回答 `ask_user_question` 事件。

**请求**:
```json
{
  "question_id": "ask-uuid-123",
  "choice_index": 0,
  "free_text": null,
  "submit": false
}
```

- `choice_index`:选中的 option 下标(从 0 开始)。如果用户选 "Other" 或问题允许自由输入,改用 `free_text`,`choice_index` 设为 `-1`。
- 同一次 AskUserQuestion 含多题时,客户端应先本地收集并允许修改全部答案,再按问题顺序发送;仅最后一题传 `submit=true`,让交互式 backend 确认汇总页。
- 每题可同时携带 `free_text` 作为所选 option 的补充说明。无法在原生 AskPanel 内表达补充信息的 PTY backend,应在选项组提交后把整组补充说明作为同 session 的一条后续消息发送。
- 后端把对应回答转写成对应 PTY 字符序列(模拟用户在桌面端按下选项)。**具体 PTY 编码由 server 根据 backend 类型决定**,客户端不需要知道。

**响应** 204。

### 4.7 `POST /api/v1/sessions/:id/plan_response`

回答 `plan_proposed` 事件(ExitPlanMode)。

**请求**:
```json
{ "plan_id": "plan-uuid-456", "accept": true }
```

`accept=true` → server 模拟桌面用户点 "Accept" 的 PTY 序列;`false` → 模拟拒绝。

**响应** 204。

### 4.8 `DELETE /api/v1/sessions/:id`

杀 session(对应桌面 `Cmd+W`)。

**响应** 204。

### 4.9 `POST /api/v1/sessions/:id/resize`

调整 PTY 终端尺寸。GUI 客户端窗口拉伸 / 拆分面板时调用;手机客户端通常不需要。

**请求**:
```json
{ "cols": 120, "rows": 40 }
```

- `cols` / `rows`:正整数,1..=10000。超界返回 400。
- server 端:Rust 走 `Session::resize`,Go 走 `pty.Setsize`。**不持久化新尺寸到 store**(下次回放从 0 开始算,GUI 自己重新发 resize)。
- session 不存在 → 404。session 已退 → 仍返回 204(no-op,避免客户端竞态)。

**响应** 204。

### 4.10 `GET /api/v1/backends`

列出 server 端注册的所有 backend(`codebuddy` / `claude` / 自定义)。客户端用来渲染"新建 tab"选项。

**响应** 200:
```json
{
  "backends": [
    {
      "key": "codebuddy",
      "display_name": "codebuddy",
      "supports_cwd": true,
      "default_cwd": "/home/dev"
    }
  ]
}
```

- `key`:`POST /sessions` 用的 `backend_key`
- `display_name`:UI 展示文案;空时 fallback 到 `key`
- `supports_cwd`:server 是否能给该 backend 设 cwd(本地 PTY 都 true,容器化 backend 可能 false)
- `default_cwd`:server 端建议的默认 cwd(可选;客户端可以忽略走 fs.list 让用户选)

### 4.11 `GET /api/v1/fs/list?path=<abspath>&show_hidden=<bool>`

列举 server 端某目录的子条目。**只用于让客户端选 cwd**,不是通用文件浏览器。

**Query**:
- `path`:必填,绝对路径
- `show_hidden`:可选,默认 `false`,`true` 时返回 `.` 开头的项

**响应** 200:
```json
{
  "path": "/home/dev",
  "parent": "/home",
  "entries": [
    { "name": "code", "is_dir": true },
    { "name": "data", "is_dir": true }
  ]
}
```

- `entries` 只包含目录(文件不返回 — 客户端选的是 cwd,不是文件)
- `parent`:`path` 的父目录;若已是 `/` 则返回 `null`

**约束**(server 实现必须遵守):
- `path` 必须是绝对路径。
- server 必须 canonicalize 路径后再返回,从而把 `..` 和软链解析成真实路径。
- 只要 canonicalize 后是一个存在的目录即可访问;不要默认限制在 `$HOME` 子树。
- 路径不存在 → 404 `not_found`
- 不是目录 → 400 `bad_request`

### 4.12 `GET /api/v1/sessions/history?backend_key=<key>&cwd=<abspath>`

列出 server 端指定工程目录下可恢复的历史 jsonl sessions。用于桌面 GUI 在 Remote backend 的配置页展示 "Session history in this directory"。

**Query**:
- `backend_key`:必填,如 `codebuddy` / `claude` / `claude-internal`
- `cwd`:必填,server 端绝对路径

**响应** 200:
```json
{
  "sessions": [
    {
      "session_id": "9f1b...",
      "title": "Fix remote session restore",
      "model": "claude-opus-4.7",
      "total_tokens": 12345,
      "last_modified_secs": 1780000000
    }
  ]
}
```

- `sessions` 按 `last_modified_secs` 降序返回。
- 不支持 jsonl 历史的 backend 返回空列表。

### 4.13 `GET /api/v1/memory/pending`

列出远端 kode-memory 的待审提议列表。

- **Rust 桥**:直接调 `kode_memory::MemoryStore::list_pending()`
- **Go server**:通过 exec `kode-memory pending --json` 获取数据

**响应** 200:
```json
{
  "items": [{
    "id": "01HX...",
    "author": "codebuddy",
    "session": null,
    "scope": "project:kode",
    "created": "2026-06-13T00:00:00Z",
    "confidence": 0.8,
    "tags": ["pty"],
    "kind": "gotcha",
    "subsystem": null,
    "supersedes": null,
    "body": "fact body text",
    "rationale": "why this matters",
    "author_energy": 3.5
  }]
}
```

**503** `memory_unavailable` — vault 不可用(Rust 桥:vault 打不开；Go server:CLI 不存在)。

### 4.14 `POST /api/v1/memory/pending/{id}/review`

审核远端 kode-memory 的一条待审提议。

- **Rust 桥**:直接调 `kode_memory::MemoryStore::review()` + `BudgetStore` 联动
- **Go server**:通过 exec `kode-memory review <id> --json` 执行审核

**请求体**(JSON):
```json
{
  "verdict": {
    "kind": "approve"
  }
}
```

`verdict.kind` ∈ `approve` | `reject` | `blacklist` | `edit_then_approve`。

`edit_then_approve` 时可附加可选字段：
```json
{
  "verdict": {
    "kind": "edit_then_approve",
    "body": "revised body",
    "tags": ["new-tag"],
    "scope": "project:kode",
    "confidence": 0.9
  }
}
```

`reject` / `blacklist` 时附带 `reason` 字段：
```json
{
  "verdict": {
    "kind": "reject",
    "reason": "not accurate"
  }
}
```

**响应** 200:
```json
{
  "outcome": "approved",
  "author_energy": 4.5,
  "remaining_pending": 3
}
```

- `outcome` ∈ `approved` | `rejected` | `blacklisted`

**404** `not_found` — pending 不存在(已被审核或 id 错误)。
**503** `memory_unavailable` — vault 不可用。

### 4.15 `GET /api/v1/memory/search?q=<query>&scope=<s>&top_k=<n>`

检索远端 kode-memory 的已审核 fact 池。

- **Rust 桥**:直接调 `kode_memory::MemoryStore::search_with_opts()`
- **Go server**:通过 exec `kode-memory search <query> --json` 获取数据

**Query**:
- `q`:必填,搜索关键词
- `scope`:可选,限定 `project:<slug>` 或 `shared`
- `top_k`:可选,默认 20

**响应** 200:
```json
{
  "items": [{
    "id": "01HX...",
    "author": "codebuddy",
    "scope": "project:kode",
    "kind": "gotcha",
    "subsystem": null,
    "created": "2026-06-13T00:00:00Z",
    "confidence": 0.9,
    "tags": ["pty"],
    "snippet": "fact summary...",
    "score": 1.23
  }]
}
```

**503** `memory_unavailable` — vault 不可用。

## 5. WebSocket

`GET /ws?token=<bearer>` 升级到 WS 连接;鉴权失败直接 4401 关闭。

### 5.1 事件 envelope

```json
{
  "protocol_version": "v1",
  "schema_version": 1,
  "session_id": 1,
  "ts": 1717000000123,
  "type": "message",
  "payload": { ... }
}
```

- 所有事件都套这个外壳;客户端先看 `type` 再解 `payload`。
- `ts`:server 时间,unix 毫秒。
- `session_id`:为 0 表示全局事件(目前仅 `connection.hello`)。

### 5.2 客户端 → server

WS 是**只读的**(server → client)。客户端要写数据走 REST `POST /input`、`/answer`、`/plan_response`;不要复用 WS 通道。

例外:可选的心跳,客户端发 `{"type":"ping"}`,server 回 `{"type":"pong","ts":...}`;空闲 30s 后双向 ping 一次。

### 5.3 事件类型

#### `connection.hello`(session_id=0,连接建立时一次性发)
```json
{
  "server_kind": "rust-bridge" | "go-server",
  "server_version": "0.2.0",
  "active_sessions": [1, 2],
  "protocol_features": ["resize", "backends", "fs.list", "sessions.history", "pty_bytes", "memory"]
}
```

`protocol_features` 是新端点的能力探测数组。客户端用来决定是否启用对应 UI。空数组 / 字段缺失视为只支持 v1 基础端点。`"sessions.history"` 表示 server 支持 §4.12 的历史 session 列表端点;`"memory"` 表示 server 支持 §4.13-4.15 的 memory 审核端点。

#### `session.created` / `session.updated` / `session.exited`
payload 同 4.1 的 session 对象。`session.exited` 多带 `exit_code: number | null`。

#### `message`
```json
{
  "id": "msg-uuid",
  "role": "user" | "assistant" | "system",
  "text": "...",
  "tool_calls": [{ "tool_use_id": "..." }]
}
```
- `tool_calls` 列出本 message 触发的 tool_use 引用,详情走独立的 `tool_use` 事件。
- assistant 的纯文本回复按段落聚合:同一 turn 内连续的 text 块拼成一条 `message`,不要每 token 一条。

#### `tool_use`
```json
{
  "id": "tool-uuid",
  "tool": "Read",
  "input_summary": "Read /path/to/file.rs",
  "output_preview": "...",
  "status": "running" | "ok" | "error"
}
```
- `input_summary`:server 端把 tool input 摘要成一行(< 120 字符);手机端展开看详情走 `output_preview`。
- `output_preview`:截断到 4KB;完整内容不在协议里(手机端不需要)。
- 多次 `tool_use` 事件可对同一 id 推送(`status` 从 running 变 ok/error 时再推一次)。

#### `ask_user_question`
```json
{
  "question_id": "ask-uuid",
  "question": "Which approach?",
  "header": "Auth method",
  "multi_select": false,
  "options": [
    { "label": "OAuth", "description": "..." },
    { "label": "JWT",   "description": "..." }
  ]
}
```
对应桌面端 AskUserQuestion;手机端 `ListPicker` / `RadioGroup` 渲染,选定 → POST `/answer`。

#### `plan_proposed`(ExitPlanMode)
```json
{ "plan_id": "plan-uuid", "plan_md": "## Plan\n..." }
```

#### `task_create` / `task_update`
```json
{
  "id": "task-uuid",
  "subject": "Run tests",
  "description": "...",
  "status": "pending" | "in_progress" | "completed",
  "blocks": ["other-task-id"],
  "blocked_by": []
}
```

#### `meta`
增量元数据(模型、tokens、cost、context %)。语义对应 `CoreEvent::JsonlMeta`。
```json
{
  "model": "claude-opus-4.7-1m",
  "title": "fix nav bug",
  "tokens": { "input": 1024, "output": 256, "cached": 0, "total": 1280 },
  "context_pct": 12.5,
  "cost_usd": 0.0123
}
```
任意字段可能为 null(语义:无变化)。

#### `pty_bytes`(可选,`protocol_features` 含 `"pty_bytes"` 时启用)

PTY 原始字节流。**面向终端渲染客户端**(kode GUI、kode TUI),手机客户端可忽略。

```json
{
  "bytes_b64": "G1tIG1syShtbODg7MUg..."
}
```

- payload 只有 `bytes_b64` 一个字段,base64 标准编码
- server 端实现:每 session 8ms coalescing 把多个小 read 合并成一帧,单帧上限 256 KB(超限切多帧,顺序保证)
- **不持久化进 history**:`pty_bytes` 只走 WS 实时推送,`GET /history` 不回放(避免 sqlite 暴涨,且客户端重连后自己重画 cwd / 重发命令更可靠)
- `bus.HistoryFor` 类内存 ring 也跳过 pty_bytes(`store` 与 `bus` 双侧过滤)

## 6. 错误响应

REST 一律 JSON:
```json
{ "error": "<code>", "detail": "<human-readable>" }
```

错误码集合:
- `unauthorized`(401)
- `not_found`(404,session id 不存在)
- `bad_request`(400,参数缺失 / 格式错)
- `conflict`(409,例如 question_id 已被别的设备回答)
- `internal`(500)

## 7. 部署假设

- **Rust 桥**:监听 `127.0.0.1:9870`,只做联调用;**不**直接面向公网,公网走 Tailscale 反代到桌面。
- **Go server**:监听 `0.0.0.0:9870`,容器化;HTTPS 由前置 caddy 解决。
- 端口 9870 是默认值,两端都从环境变量 `KODE_BRIDGE_PORT` 覆盖。

## 8. 未决事项

1. **plan_proposed 信号源**:codebuddy / claude 的 jsonl 中 ExitPlanMode 是否有结构化字段?目前只见过 prompt 文本里出现 "plan mode";9.1.4 实现时需要实测决定。fallback:正则识别 assistant message 中的 `## Plan\n` 段。
2. **多设备并发回答**:同一 question_id 被两台手机抢答 → 谁先到谁赢,后到的 409。或乐观:都接受,各自把字符序列写 PTY(可能产生多余输入)。**v1 暂定 409**。
3. **远程 AI 箱**:Go server 自己跑 codebuddy/claude(不只是反代桌面)— 协议层等价,只是 server 端 spawn 自己的 PTY 而不是观察桌面 jsonl。

## 9. 实现路标

| 阶段 | 实现方 | 文件 |
|---|---|---|
| 9.0 | 协议本身 | 本文 |
| 9.1 | Rust 桥 | `apps/gui/src-tauri/src/bridge/` |
| 9.3 | Go server | 独立仓 `kode-server-go` |
| 9.2 | Flutter 客户端 | 独立仓 `kode-mobile` |

每方实现都需带:
1. 单元测试覆盖事件 schema 序列化往返
2. 一份 `wscat` + `curl` 端到端验收脚本(`docs/protocol-smoke.sh` 之类)


## Kode workbench Agent hub

The shared Kode backend owns these additive administration endpoints. They use
its existing administrator bearer; session-scoped agent credentials receive 403.

- `GET /api/v1/messaging/workbench/agent-hub`: extension sources, native target
  status, managed plugin paths, portable skill targets and backend power state.
- `POST /api/v1/messaging/workbench/agent-hub`: JSON action `save-source`
  (`source: {id, kind: git|local, location, subdir, targets}`), `sync-source`
  (`id`), `remove-source` (`id`), or `power` (`enabled`). These mutations are
  serialized by the backend and persist to its SQLite document. Sync conflicts
  preserve foreign files and restore prior managed links on a failed commit.
- `POST /api/v1/messaging/workbench/handoff`: JSON
  `{source_session_id, source_runtime, profile_id, target_runtime, request_id}`.
  Runtime values are `gui` or `dsh`; IDs belong to this backend/Host. The backend
  freezes a bounded readable transcript from its published history, dispatches
  `create_session` and `input` using separate durable runtime mailbox identities,
  and returns `{sessionId, runtime, id, sourceId}`. Repeat the identical request
  ID after a timeout. A conflicting reuse fails; an uncertain claimed runtime
  operation is never automatically re-executed with another identity. Source
  history is preserved. Tools, hidden reasoning and peer-originated input are
  excluded; attachments are not transferred.

Both GUI IPC and dsh owner HTTP routes are adapters to these same APIs. Native
CLI execution remains owned by its attached runtime. A disconnected target
runtime reports unavailable rather than spawning an unowned Agent process.
`workbench/agents` additionally publishes `extension_args` keyed by backend;
these arguments are applied at launch and do not rewrite editable Agent defaults.

`runtime/sessions` applies `workspaces.global.archivedSessionIds` to dsh runtime
identities, including offline records. Archiving changes directory visibility,
while runtime identity and history remain available for unarchive. Clients must
reconcile removals after a successful full directory refresh; a failed request
must preserve the last successful list. GUI adapters apply the same backend
archive index when connecting to an older standalone service during an upgrade.

Empty composer placeholders are excluded from shared runtime and federated saved
session catalogs. A cold summary without a projection cache is unknown: adapters
may hide it only after a successful read confirms zero inherited events and only
permission/sandbox/approval initialization events. Read failures, unknown events,
inbox work, inherited history and real messages remain visible. GUI snapshots
preserve `dsh_session_id` separately from the native CLI `session_id`, so later
archive and unarchive operations retain the original runtime identity.

### Dsh 工作台 CLI token 统计

`GET /api/v1/messaging/model-usage?period=today|month|all&timezone_offset_minutes=<minutes>&since_ms=<optional-ms>&until_ms=<optional-ms>` 供独立 session server 的管理端使用，要求 bridge 管理员 bearer，session-scoped token 返回 `403`。复用 `/api/v1/model-usage` 的 collector 和响应格式（`period`、`rows`、`totals`、`daily`、`timeline`、`warnings`）。时区为 UTC 以东分钟数，`since_ms` 可指定查看者日历的今日/月初边界；`all` 不传该边界。可选 `until_ms` 指定闭区间结束时间（含边界），与 `since_ms` 同时限制总量、timeline、daily 及明细；起点晚于终点或负时间返回 `400`。响应 `until_ms` 是实际使用的截止时间，默认服务端采样时刻。此接口只读，未知 period 或时区超出 ±1439 返回 `400`。Dsh 浏览器通过 owner-only `/api/kode/model-usage` 代理访问，凭据不进入前端；统计范围为当前执行主机的 CLI 历史，与当前对话上下文占用独立。


`timeline` 为按查看者时区聚合的 `{date, rows}` 数组，rows 保留 backend/model 及输入、输出、缓存、总量。today 按小时（YYYY-MM-DDTHH:00）、month 按日、all 按月，从相应范围起点截至现在；缺失桶由客户端补零。daily 同样仅包含所选范围，不固定截断为 84 天。Agent/model 多选在客户端按 rows 的对应维度聚合，同时过滤图、活跃度及明细；不把未知时间的记录猜配到某一天。

`GET/POST /api/v1/messaging/integrations` 新增持久化布尔项 `auto_resume_interrupted`，默认 true，旧配置缺失字段时采用默认值。修改仍要求 owner/admin 身份。DSH Host 独立保存上次运行中的会话 ID（非打开的 tab），启动时以冷查询核对最后一轮是否未闭合或因 disposed 中断，忽略已完成、用户停止、错误、归档及已有活动的会话，使用 SessionController 恢复原 Agent/模型/权限并排入一个续接输入。已有待处理输入直接恢复而不重复插入。主动停止用 ignorable plugin record 标识，关闭开关会清除此前候选；不自动接受权限请求。
### Session messaging operation lease relay (opt-in v2 feature)

The independent session messaging WebSocket negotiates `operation_leases_v1`
after v2 Hello/Capabilities. `operation_request` carries a request ID, operation
ID, assigned worker session, and an optional claim/renew/report command;
`operation_response` carries that request ID and either value or error. The
receiving home Hub checks the authenticated peer node and assigned worker session
against its durable operation. Cancellation, stop attestation and next-attempt
commands remain home-owner controls. No remote operation replica is created.

Local REST `POST /api/v1/messaging/operation-relay/:home_node` authenticates the
worker session (or Host administrator) before forwarding. Pending RPCs are
bounded and sent only once across connection changes. A missing response does not
prove non-execution: callers must inspect the home ledger and retain local lease
expiry fencing. No new frames are sent without the negotiated feature; legacy
session messaging remains unchanged. This lease feature alone grants no remote budget/collector authority.


The separately negotiated `operation_accounting_v1` permits an optional
`accounting` envelope in `operation_request`, mutually exclusive with execution
commands. It contains an attempt and context/receipt/usage action. Absent fields
are omitted on legacy lease requests. Frames with accounting are never emitted
or accepted without this additional capability. On the execution Host, only
administrator-authenticated `/operation-accounting-relay/:home_node` may send
accounting; the session-scoped relay explicitly rejects it. Home verifies the
peer/worker assignment and immutable attempt-reservation binding. Receipt lookup
returns `{receipt:null}` for a missing event and rejects a receipt from another
reservation. Usage remains deduplicated estimated accounting, restricted to
explicit requested-model attribution; remote budget/price mutation and final
settlement are not supported by this interface.

Resource-aware operation lease reads additionally expose `resource_required`, the
frozen per-attempt `resource` policy, and derived `resource_available`. Opted-in
claims/renewals enforce this policy on the home ledger and cap
`lease_duration_ms` at its evidence expiry. Updated native adapters validate the
actual Host/profile and reject false/unproven availability; older ordinary
operations default to no resource requirement. Admin-only `/resource-admission`
and `/operations/:id/resource` query/attach policies; worker credentials cannot
change them. This optional foundation does not yet establish universal executor
capability negotiation or mandatory team dispatch enforcement.

`operation_resources_v1` additionally gates remote `claim_resource` and
`renew_resource` actions. Each carries `lease_ms` and
`resource:{profile,account_epoch,binding_revision}`; home checks exact frozen
assignment before transactional resource admission. Plain claim/renew are rejected
when resource_required is true, so clients cannot silently ignore the new
operation fields. Unconstrained operations retain the original actions. Unknown
capability rejects before sending the frame; mismatched acknowledgement does not
advance operation revision. This acknowledgement describes adapter support and
binding identity, not cryptographic attestation of a provider or tool sandbox.

`operation_quota_v1` gates resource_context/quota/invalidate_quota actions inside
the Host-only accounting relay. Each action is scoped to operation+attempt and
its immutable resource policy; home also verifies the authenticated execution
peer and assigned worker. A sample cannot choose another profile/account epoch
or binding revision. Invalidation uses the frozen revision and cannot revoke a
newer owner binding. No new frames go to peers lacking this capability. Accounting
request envelopes are bounded to 64 KiB before transport queueing. This grants
neither general remote quota access nor permission to modify budgets/prices.

### Retained quota exhaustion evidence

The home Hub retains affirmative window observations separately from the latest quota snapshot, keyed by resource binding revision, limit and window. Missing/unknown windows and older bucket observations cannot erase known exhaustion. Equal-timestamp conflicting observations reject atomically. Newer affirmative evidence may replace prior evidence; a reset only removes the negative exhaustion gate and does not prove fresh capacity. Schema v12 backfills window evidence from quota audit and snapshots. Quota snapshot reads expose active retained exhaustion under `exhaustion_evidence`; ordinary freshness and complete-window requirements still apply.

The `operation_quota_v1` resource-context reply additionally carries a `quota` snapshot for the same authorized host/profile. Request identity and assignment checks are unchanged. Older replies without this field remain accepted by collectors; coverage clients display `snapshot_unsupported` and never invent availability. The current binding may supersede the frozen assignment, so coverage exposes assignment-binding validity separately.

### Official-call evidence storage and trusted local collector API

Messaging schema v13 adds `official_calls` and ordered `official_call_events`. A begin record freezes operation/attempt/epoch, worker session and requested provider/model; active lease and existing resource/budget admission are checked in the same transaction. Exact begin replay returns `duplicate: true`, which is a recovery receipt and must never authorize another provider call. Event sequences are contiguous, exact retries idempotent and conflicting retries rejected. Terminal evidence is immutable; late observations for an already-started call may be stored after operation expiry without restoring operation authority. These records do not yet settle reservations or prove actual provider billing. Trusted local collector endpoints are listed below; remote relay is not enabled yet.

Admin-only endpoints: `POST /api/v1/messaging/official-calls` starts a call record; `GET /official-calls/:id` reads its recovery receipt; `POST /official-calls/:id/events` appends typed evidence; `GET /official-calls/:id/events?after=N` returns up to 100 ordered events with a continuation cursor. Paths after the first use the same messaging prefix. Agent/session bearer credentials are rejected before access. Writes additionally require that the operation executes on the local Hub; a future authenticated remote collector relay must enforce the assigned peer. These APIs record evidence only and do not settle costs or authorize automatic replay.

Budget-required official calls now freeze the attempt reservation and an immutable `requested_model` price matching the requested model at begin. Same-attempt calls are serialized: unfinished, uncertain or unresolved prior calls reject further admission. Accepted known usage is aggregated across distinct calls and settled atomically with its evidence as an internal, nonfinal estimate. Exact replay cannot charge again. Missing usage, nonzero cache writes and regressing counters keep prior known charges and expose unresolved status. Official and native cumulative usage cannot both account against one reservation. Reported/manual settlement is never overwritten. This does not establish supplier billing, a per-call spending cap, or production middleware installation.

### Official call evidence relay

`operation_official_calls_v1` additionally gates `official_begin`, `official_read`
and `official_event` actions on the existing operation accounting relay. Both
peers must negotiate it; legacy peers receive an explicit unsupported error.
The execution Host's administrator collector invokes the relay; session tokens
cannot submit accounting actions through either relay endpoint. Home authenticates
the assigned execution peer and Worker, then restricts the call identity to the
requested operation and attempt. Begin also checks epoch, live lease and existing
resource/budget admission. Late evidence can reconcile a past attempt without
restoring execution permission. Local collector writes cannot impersonate a
remote execution Host.

The remote official outbox persists its home node with each immutable call request.
Recovery reads that home and replays evidence only, never begins or dispatches a
model again. Home remains the sole ledger authority; the remote durable queue is
not a replica of accounting state. This transport does not install metering into
unmanaged official agents or ACP child processes.

### Local execution-Host tool evidence

Administrator-only `POST /api/v1/messaging/tool-evidence` accepts immutable terminal
metadata (call ID, tool name, operation, Worker, attempt, epoch, returned/uncertain,
start/end timestamps). The operation must belong to the local execution Host and
have historical active-lease evidence for that exact attempt/epoch. This is an
audit receipt, never an execution grant or verification of side effects. Exact
retries return the original operation audit sequence; conflicting content rejects.
Records are visible in the existing paginated operation event stream. No schema
migration is needed; lookup is scoped by the indexed operation ID. Remote collectors use the separately negotiated relay described below; direct local
collector writes remain refused for remote assignments.

Remote tool evidence additionally negotiates `operation_tool_evidence_v1`. The
administrator-only operation accounting relay accepts `tool_evidence` with the
same terminal metadata. Home checks the authenticated assigned execution peer,
Worker, envelope operation/attempt and historical lease evidence before recording.
Peers without the capability receive an explicit unsupported error, without sending
an unknown action. Acknowledgement is the same immutable audit receipt used locally.

### Administrator adjudication of uncertain tool effects

`POST /api/v1/messaging/tool-resolutions` is home-administrator-only and is not
an execution-peer relay action. Input binds operation ID, original evidence audit
sequence, request ID, decision (`verified_applied`, `verified_not_applied`, or
`abandoned`) and an evidence reference. Only an original uncertain tool record
can be adjudicated. One immutable decision per evidence record is retained as a
separate operation audit event, with actor, recorded time and replay_authorized=false.
Exact retries return the previous decision; conflicting changes reject.

Replaying the original immutable tool evidence receipt may include its resolution;
this also allows the assigned remote collector to observe a home decision without
obtaining decision-writing authority. The original uncertain record is unchanged.
An administrator assertion is not independent automated verification. Decisions do
not renew a lease, bypass workflow requirements, or authorize repeating a call ID.

### TeamGrant authority registry

Home-administrator-only endpoints: `POST /api/v1/messaging/team-grants` writes an
expected_revision plus explicit policy; `GET /team-grants/:id?revision=N` reads
current or immutable history; `POST /team-grants/:id/check` evaluates a pinned
revision and requested scope. The server supplies grantor=home_administrator; a
caller cannot supply a human identity. This is single-user Host authority, not
multi-user identity isolation. Session credentials cannot read or mutate grants.

Policies name team, exact Host/workspace/root targets, capabilities, tools, network
permission, budget IDs and expiry. Updates retain immutable historical revisions;
team identity cannot change, stale writes reject, exact retries return the current
matching receipt. A new disabled revision revokes prior versions. Checks reject
missing, changed, revoked, expired or out-of-scope requests. Root strings must be
absolute without dot components; execution-Host realpath/symlink enforcement is
still required. Registry data uses a private namespace in the existing document
store, inaccessible through generic public document keys.

This registry/check API is not yet mandatory dispatch enforcement. Operation grant
binding, transactional claim/renew checks, remote scope projection, tool capability
intersection and user activation UI remain required before team execution acceptance.

### Grant-required operation attempts

Operation preparation accepts `grant_required` (default false for legacy callers).
A grant-required operation cannot claim a lease before an administrator binds it
through `POST /operations/:id/grant`, with expected operation revision, pinned
grant ID/version, exact attempt/epoch and requested scope. The operation must be
prepared and its execution Host must match the scope target. Scope is immutable
within an attempt; binding is appended to the operation audit atomically.

Claim/renew checks the current grant revision in the same SQLite transaction as
lease admission and caps the lease by grant expiry. Operation reads expose
`grant_available`; current dsh lease checks abort on false. Official call admission
also checks the bound grant. A revoked grant prevents an applied operation report,
but retains the audit and does not disable owner cancellation/stop controls.
Next attempt preserves grant_required and refuses the previous attempt binding.
Legacy unbound operations retain existing semantics; team creation must mandate
this flag. Executor workspace/tool/network enforcement and actual reservation
scope intersection remain required; a declared scope alone is not a sandbox.

Grant admission also reads the actual frozen reservation for the current attempt.
Every charged budget must be in the attempt's grant scope, and a team-scoped budget
must belong to that grant's team; an explicitly permitted shared budget may be used
alongside it. This check runs during claim/renew/official admission. Grant attachment
validates any already-bound reservation, and budget attachment validates any
already-bound grant in the same transaction, so either attachment order is safe.
Failed attachment rolls back the operation revision and binding. Declaring allowed
budget IDs does not substitute for a required real reservation. Historical usage
and evidence reconciliation remain possible after authority is revoked.

`GET /operations/:id/grant` is administrator-only and returns the operation identity,
assigned Worker, current attempt/epoch, frozen scope, grant_required and current
availability. It does not expose the global grant registry to a Worker. This is a
read-only projection, not a lease or a new authority grant. A scoped remote projection
requires separate relay capability negotiation; direct local reads cannot substitute
for a remote home authority.

### Scoped remote grant projection

`operation_grants_v1` gates the `grant_context` action on the existing trusted-Host
accounting relay. Home checks the assigned execution peer/Worker and exact requested
attempt before returning operation grant context. This action does not read the
full grant registry or permit grant writes. Ordinary session credentials cannot
use either relay endpoint for it. Legacy peers receive an explicit unsupported
result rather than an unknown action. Read projections confer no lease authority.

### Session durable diagnostics

`GET /api/v1/messaging/sessions/:id/diagnostics` permits the session owner or
administrator. It returns local incoming/outgoing status counts, at most ten
non-accepted message metadata samples per direction with truncation indicators,
current prepared/queued/consumed delivery-evidence counts and pending cancellation
count. Message content, credentials and detail strings are excluded.
`scope=local_durable_session_state`; runtime liveness and peer connectivity are
explicitly `not_probed`. Accepted messages are not necessarily consumed; absent
evidence is not proof of nonexecution; an empty queue is not proof of health.
This cold read does not wake a runtime or query remote authority. Message IDs can
be followed through existing authorized delivery/cancellation/lifecycle endpoints.

### Desktop Agent profile projection

Desktop Agent saves merge profile extensions by the stable profile ID. The desktop
projection owns `id`, `name`, `type`, `origin`, `executable`, `args`, `env`,
`defaultModel` and `protocol`; absent optional launch fields remain absent, so
clearing a default model does not resurrect the old value. Other persisted profile
fields, including default reasoning effort, model restrictions and role metadata,
survive a desktop save. This preservation does not validate or activate arbitrary
extensions, grant permissions, or change immutable session launch bindings.

### Configured reasoning-effort transport

`BackendConfig.effort` is optional; absence preserves existing launch behavior.
It contains `default` (nullable), `levels` (allowed identifiers), and a tagged
`adapter`. Adapter modes are `none`, `flag` (`flag`), `config_override` (`flag`,
`key`), `model_suffix` (`prefix`, `suffix`), `acp_option` (`option`, the advertised
configuration ID), and `turn_rpc` (`field`). No vendor defaults are inferred.
For example, a fixture backend can use:

```toml
[backends.fixture.effort]
default = "high"
levels = ["low", "high"]
[backends.fixture.effort.adapter]
mode = "flag"
flag = "--effort"
```

PTY launch supports flag, quoted config assignment and model suffix transports.
It rejects unsupported levels, malformed transport configuration, conflicting
manual settings and transports requiring protocol calls before starting a child.
Effort is never appended as a standalone positional prompt. ACP creation supports
argv transports and `acp_option`, requiring the exact advertised option ID to
acknowledge the selected value. Initial in-session model selection now propagates
errors instead of silently retaining a default. `turn_rpc` remains unsupported by
these Rust creation paths. Transport acknowledgement is not observed inference
configuration; actual model/effort verification and per-request field propagation
remain separate work. The legacy desktop form preserves configured effort when
saving fields it supports; TOML backend materialization retains the nested value.

### Runtime-reported selection observation

Session DTOs and `meta` events may include `selection` with source
`codex_turn_context`, nullable model/effort/turn_id/session_uuid, and `historical`.
The JSONL tail reports a new observation for each turn_context, even when the model
is unchanged. Missing or malformed effort remains null rather than inheriting an
old request's value. Model, effort and turn ID are bounded when parsed. `historical=true` identifies
lines already present when that transcript was opened; it does not confirm the
configuration of a newly started request. The record represents what the runtime
reported, not independent provider attestation or workflow completion.

In a partial `meta` event, `selection=null` means no new observation; clearing is
signaled by session identity change or `tokens_reset=true`. A non-null observation
whose effort is null replaces the previous effort with unknown. In a full session
DTO, `selection=null` means no retained observation.

The execution Host retains the latest observation in its in-memory session
projection; transcript replay can reconstruct it. Session retarget/reset clears
old observations. Remote metadata forwards the observation while mapping only the
outer session ID; native session and turn identity remain unchanged. Older peers
without this field provide no observation. Consumers must not treat this record as
a current operation's confirmed selection without matching its execution/turn
identity. Persistent per-operation selection audit and mismatch policy are separate
from this projection.

### Per-session effort requests

`POST /api/v1/sessions` accepts optional `reasoning_effort`; Rust `SpawnSpec`
provides the same optional field for local and remote transports. A supplied value
must be an allowed level of the selected backend's configured effort transport.
Validation operates on an isolated launch snapshot, including resumed-session
snapshots, and never changes the shared backend default. Omission inherits the
configured default. Missing/unsupported transport or invalid level rejects the
request. Session DTO `configured_effort` exposes that launch setting separately
from runtime-reported `selection` evidence; it is not proof of inference use.

Authenticated `GET /api/v1/capabilities` advertises
`session_reasoning_effort_v1=true`. RemoteTransport requires a positive fresh
capability response before submitting a request with explicit effort. Missing,
false, malformed or unreachable capability responses prevent the session POST;
old peers must not silently ignore a requested effort. Requests without explicit
effort keep their existing path. This capability means the request field is
validated and routed, not that every backend supports every level/transport.
Existing desktop/mobile callers that do not expose an effort control continue to
omit it; this change does not add an editor or migrate the mobile application.

### Home selection evidence (trusted Host collector)

Administrator-only `POST /api/v1/messaging/selection-evidence` appends immutable
observations to the operation audit. Session/Worker credentials cannot submit it;
the operation's assigned Worker must belong to this Hub for this direct endpoint.
Remote collectors use the admin-only operation-accounting-relay endpoint with
`accounting.action = {kind: "selection_evidence", evidence}` and the matching
attempt. Both peers must negotiate `operation_selection_evidence_v1` in addition
to operation/accounting support; unsupported peers reject before transmission.
The home Hub verifies the authenticated execution peer, assigned Worker and the
nested evidence's operation/attempt. Only the home ledger stores this event.
Receipt loss permits retrying the identical evidence, never replaying inference.
The native execution Host persists a bounded selection outbox before submission,
checks the full returned evidence and derived rejection, and retries pending rows
at startup and periodically. Recovery never starts inference. Unacknowledged
current-attempt evidence blocks continuation and successful completion. ACP emits
configuration evidence before session/prompt; Codex emits it after turn/start, so
this is not a guarantee of pre-inference verification for that executor.
An acknowledged request without observed values is recorded as pending, not
reported. Strict inference confirmation policies remain separate work.

The body contains `record_id`, `operation_id`, `worker_session`, `attempt`, `epoch`,
`profile_revision`, `thread_id`, `turn_id`, nonempty `input_ids` (at most 64),
`scope` (`executor_configuration` or `inference`), `observed_at`, `rejected`, and
`model`/`effort` observations. Each observation has nullable `requested`, `observed`,
`source`, and a status of `reported`, `mismatch`, `unverifiable`, or `pending`.
Reported values require a source; mismatch requires two different known values.
Configuration acknowledgement is not provider-attested inference. Values and IDs
are bounded and no free-form transcript or credentials belong in this endpoint.

The operation must have admitted the exact attempt/epoch. Foreign Workers and
future/never-admitted attempts are rejected. Late observations remain appendable.
An exact record-ID retry returns the original sequence with `duplicate: true`;
changed content for that ID is a conflict. The response's derived `rejected` is
true for an explicit rejection or different known requested/observed values,
regardless of a caller's positive status. Unknown alone does not imply mismatch.

Any rejected observation blocks further lease renewal, new official inference
calls and successful report application for that attempt/epoch. A current report
returns `applied: false, reason: selection_rejected`; later matching observations
do not clear the rejection. Cancellation/stop attestation remain available, and
a properly admitted new attempt has a separate gate. Historical report receipts
are immutable: late evidence does not retroactively rewrite them. Workflow
acceptance must inspect audit evidence, not treat a report receipt as completion.
The evidence append and command admission checks share SQLite transactions.

### Immutable operation selection policy

Operation preparation optionally accepts `selection_policy`:
`{profile_revision, model, effort: string|null, scope: executor_configuration|inference}`.
The bounded policy is frozen with the operation request key, survives restart,
and is returned in local/relayed operation projections. Reusing the key with a
changed or removed policy conflicts. Absence preserves legacy report semantics.

A strict report requires one nonrejected evidence record for the current
attempt/epoch with the exact profile revision and scope, reported model with both
requested/observed equal to policy.model, and (when specified) reported effort
with both values equal to policy.effort. Pending, unverifiable, wrong-scope or
wrong-profile records cannot satisfy it; complementary partial records are not
combined into proof. Missing proof yields applied=false, reason=selection_unverified.
Prior rejection remains the stronger gate. This is still report admission, not
workflow acceptance or provider attestation. Model upgrades requiring a different
frozen policy need a new authorized operation.

The current dsh lease client reads policy from the prepared home operation and
requires an executor beforeClaim check before sending claim. Missing/negative
checks refuse without claiming; the policy snapshot is checked on subsequent
lease reads and commands. The native runtime checks request/profile compatibility
and persists selectionAdmission (capable/rejected plus reason); this capability
check is not evidence of actual selected values. It requires matching reported configuration
before ACP session/prompt. Native inference-scope requirements and Codex strict
pre-inference verification are currently unsupported and rejected before runtime
creation. Legacy/foreign executors are not thereby proven to enforce a
pre-inference gate: the universal Hub guarantee is rejection of an unverified
report. Broader execution capability admission remains necessary.

Strict operation lease commands now carry optional `selection_ack`, with the
exact immutable selection_policy object. Home compares it transactionally for
claim/renew (including resource variants); missing, changed or unsolicited policy
acknowledgements reject without granting/renewing a lease. No-policy legacy
commands omit it and retain their wire shape. Cancellation and stop controls do
not require this acknowledgement. This prevents clients that silently ignore a
strict policy from claiming it, but is not proof of runtime enforcement or
reported model values. The separate report evidence gate remains mandatory.
Remote commands carrying selection_ack require negotiated
operation_selection_evidence_v1; old peers are not sent the new command shape.
The current dsh lease client sends the frozen policy after its beforeClaim check
and repeats it on renewals. Declaring support does not waive actual evidence.

Codex Host selection collection also accepts exact active-thread/active-turn
`model/rerouted` notifications. It emits executor_configuration evidence with
source model/rerouted and the reported toModel; missing/invalid targets remain
unverifiable and effort remains unknown. Known requested/target mismatch is a
rejection. This observes routing after turn/start, not provider-attested inference
or prevention of an already-started call. Foreign/historical/unscoped notifications
are excluded from current-turn selection and reroute accounting flags.

### Session-tool message projections

The dsh Host, standalone JavaScript MCP and GUI-bundled Rust MCP now expose
bounded read/wait event previews: at most 16 events and 8192 conservative estimated token
units for the entire serialized payload. One UTF-8 byte is one estimated unit
(the conservative fallback for byte-backed tokenizers), not a measured model
token count. `token_budget` includes limit, accounting=serialized_utf8_bytes and
exact_tokens=false; surrounding prompt and tool framing are outside this limit. Each message preview contains at most 1024
Unicode code points. The returned cursor advances only through events actually
included, never through an omitted backend batch. Continue until an empty page;
may_have_more is conservative and does not prove that another page is nonempty.

Truncated messages include continuation {tool: kode_sessions_message_read,
message_id, offset}. This tool reads the existing authenticated message endpoint
and returns at most 4096 code points with offset, next and content_length, under
the same serialized payload budget. Escaping and metadata count; the first event
preview can shrink with an adjusted continuation offset. Oversized metadata
fails without consuming or advancing the cursor. Follow
next until null to reconstruct the full content. Invalid offsets fail, and
backend participant ACL still controls access. These projections do not mutate
the persisted message or prove consumption/completion. Existing short-message
fields and session-bound credentials retain their semantics.

### Session MCP input control

Both standalone JavaScript and desktop Rust session MCP expose
`kode_sessions_delivery_status(message_id)` and, when the connected Hub advertises
`input_cancellation`, `kode_sessions_cancel_input(message_id)` and
`kode_sessions_cancellation_status(message_id)`. These use existing authenticated
message delivery/cancellation routes and never select a caller-supplied source.
Only the sender may request cancellation; participant checks protect status reads.
A requested cancellation is not confirmed termination, and consumed is not task
completion. Older Hubs without cancellation capability do not advertise its tools.

The dsh Host runs input cancellation polling independently from ordinary message
claim/delivery recovery and receipt posting. A stalled delivery request therefore
does not serialize cancellation behind it. Both loops use the same authenticated
session binding and lifetime signal; Host teardown aborts and drains both. Runtime
cancellation may still need its own persistence barrier, and transport failure or
an unconfirmed runtime result never implies successful stopping.

Native running/shared-input dispositions are recorded as
`plugin:kode/input-cancellation` session events containing exact `inputId` and
`result`. The native driver flushes the session before returning that result.
Repeated requests, including after session restoration, replay the original
`cancel_unconfirmed` reason rather than deriving a different reason from a later
turn. A replay of `stop_requested` may reassert abort only while that same input
is the sole active input; it never aborts a later or shared turn. Shared-turn
refusal remains a refusal on replay. Queue removal retains its existing durable
inbox evidence. Failed flush does not acknowledge a result; retry flushes existing
evidence without appending another disposition. These are durable cancellation
dispositions, not evidence of external process termination.

### Participant event cursor indexes (schema v14)

The message event log keeps separate source and target `(node, session, seq)`
expression indexes. Session-scoped reads merge the two indexed cursor ranges with
UNION, retaining terminal receipts and deduplicating events addressed to the same
session on both sides. Owner-wide reads continue using the sequence primary key.
Existing event bodies, sequence numbers and public cursor semantics do not change;
index construction runs inside the backed-up transactional schema upgrade.

### Session cold-resume probe

`GET /api/v1/messaging/sessions/:id/pending` remains owner/admin scoped and returns
`{"pending": N}`. N counts distinct locally targeted messages requiring attention:
unexpired received messages, prepared/queued runtime deliveries without a cancellation,
and requested input cancellations. Accepted runtime inputs are not discarded when
the original transport TTL expires. Consumed deliveries and terminal cancellation
records alone do not request a cold resume; `cancel_unconfirmed` is not permission
to restart execution. The probe does not claim, renew, enqueue, cancel, or execute work.
The Host resumes only its previously owned identities via the public session
controller, retaining archive, persistence ownership and native execution fences.

### Model-facing lifecycle audit pages

All three session-tool implementations (dsh Host, JavaScript MCP, Rust MCP) expose
`kode_sessions_lifecycle_read` when the Hub advertises `lifecycle_events`. It uses
the participant-scoped lifecycle-events endpoint and its separate audit cursor.
Pages contain at most 16 complete records and 8192 serialized-byte estimate units,
including the envelope. The same token_budget metadata marks this as an estimate,
not actual model usage. Oversized individual evidence errors without advancing the
cursor; terminal receipts are never truncated or silently skipped. The backend
DTO, ACL and historical flags are unchanged.

Lifecycle participant queries select indexed sender/recipient messages and seek
`lifecycle_message(message_id,seq)` for each, then UNION in cursor order. Self-addressed
records appear once and terminal evidence remains queryable. This reuses existing
indexes; no schema migration or change to audit cursor values is required.

A successful Host followup or flush without readable matching runtime events is
not queued/consumed evidence. When event history is unavailable, the prepared
binding remains prepared and the message receives an uncertain receipt whose
detail explicitly marks approximate submission and unverified persistence/consumption.
Readable history with no matching input is also uncertain. Later recovery may
publish matching flushed evidence, but never resubmits input. Transport/persistence
errors remain on the recovery path rather than overwriting an acknowledgement that
may already have committed.

Automatic dsh relay followups also fit the 8192 serialized-byte estimate, counting
the entire input object including attribution, reply routing and JSON escaping.
Content is at most 4096 Unicode code points; the message_read continuation offset
is the actual retained count. Original stored content is unchanged. Oversized
metadata fails before followup and cannot be reported as queued. This per-input
bound does not impose a cumulative conversation or model-turn token limit.

### Frozen v1 session-link serialization

Both link directions serialize v1 application envelopes through an explicit
whitelist in messaging/wire.rs. Directory SessionInfo, Message and nested Address
fields retain the released keys and null values, independently of future internal
DTO additions. Workspace command variants have explicit envelopes; workspace result
value remains the opaque JSON payload defined by v1. v2-only frames are refused by
the v1 encoder, while v2 retains feature negotiation and the current DTO encoding.

### Owner communication transport observations

`GET /api/v1/messaging/workbench/communication-health` requires Hub administrator
credentials; session credentials receive 403. This read-only endpoint returns
`hub: responding`, observation time and configured peer node IDs with active
connection counts, recent counts, negotiated protocol versions and the latest
received timestamp. It never exposes peer URLs, SSH configuration or link secrets.
`connected` means at least one authenticated handshaken connection observed within
15 seconds; `stale` means open observations without a recent valid frame;
`not_connected` means no observed connection, not a diagnosed failure cause.
Freshness uses monotonic elapsed time. A connection guard removes only its own
observation on closure/error/cancellation; observations reset on Hub restart.
Neither this endpoint nor session diagnostics launches a model, resumes a Worker,
sends a probe message or proves runtime/quota readiness. Session diagnostics remain
explicitly scoped to durable records, separately from these transport observations.

### Capability profile revisions (messaging schema 15)

Owner/admin-only `POST /api/v1/messaging/capability-profiles` stores a soft evaluation
snapshot with `id`, `expected_revision` (0 on creation), immutable resource identity
`host/profile/model`, and `assessments` keyed by caller-defined IDs. Each assessment
contains `evaluation`, `source` (`user|documented|measured`), confidence [0,1], evidence
references, millisecond `updated_at`/`valid_until`, and `pinned`. Evaluation variants are
`task_fit {tag,score:0..100}`, `cost_tier {tier:low|medium|high}`,
`latency {preference:low|medium|high}`, `strength {text}`, `weakness {text}`.
Documented/measured sources require nonempty evidence references; this records declared
provenance, not an independent verification of the evidence. Missing evaluations remain
missing; a cost tier is neither a price nor an account balance. No hard capabilities,
permissions or supported models can be established by this endpoint.

Writes append immutable revisions and an atomic resource audit event. Revision CAS
rejects concurrent stale edits. Removing or changing any pinned assessment requires
explicit admin `replace_pins:true`; automated suggestions must not set this flag.
`GET /api/v1/messaging/capability-profiles/:id/:revision` reads the exact snapshot and
adds current per-assessment `freshness` (`fresh|stale`) and `evaluated_at`. Old revisions
and stale evidence remain readable across restart. Session tokens cannot read or write
this owner knowledge store. Ranking and Builder activation are separate, pending consumers.

### Read-only resource recommendations

Owner/admin `POST /api/v1/messaging/resources/rank` accepts `task_tag`,
`minimum_quality` (0–100), `minimum_confidence` (0–1), nonnegative `weights`
(`quality/cost/latency`, each <=1000, nonzero sum), and at most 25 `candidates`.
Each candidate references `capability_id/capability_revision/model`, a resource-admission
`resource` policy, and optional `preferred`. Duplicate host/profile/model candidates
are rejected. Exact profile identity must match the resource. The existing home-Hub
account binding and quota evaluator runs before soft evaluation: known exhaustion
excludes a candidate, and unknown quota follows `require_fresh|team_budget` with the
budget requirement preserved in the response.

Only unexpired assessments meeting confidence qualify. Matching task fit must exist
and meet the quality floor; cheap cost or preferred status cannot compensate. Multiple
applicable assessments use the conservative minimum. Cost/latency preference components
map low/medium/high to 100/50/0; absent evidence remains null with zero ranking credit
(not zero financial cost). Weighted score uses the full configured denominator.
Preferred candidates sort first only after these filters; stable identity breaks ties.
Responses provide component scores, exact revision and assessment references, source,
confidence, pin and validity metadata, ignored evidence, and exclusion reasons. Full
references can be read from the immutable capability snapshot.

This is a recommendation API, not assignment admission. Every result explicitly has
`eligible_for_dispatch:false` and lists pending team policy, workspace/grant, executor
model/effort/tools, independence, atomic budget, locks and concurrency checks. No tool,
model call, reservation, lease or selection audit is produced by this read-only query;
actual committed dispatch must check those requirements and audit its selection. Resource
ranking integration with Builder and activated team policy remains pending.

### Provider monetary observations (messaging schema 16)

Admin-only `POST /api/v1/messaging/monetary-quota` accepts a pinned resource identity
(`host`, `profile`, `account_id`, `account_epoch`, `binding_revision`), source
(`deepseek_balance|openrouter_key|openrouter_credits`), observation time in ms, collection
status and nullable sample. Reported samples use the allowlisted provider-balances DTO:
source/version, observation/expiry, provider availability, completeness, typed limit
scope/unit and decimal-string amounts, account_identity marker and bounded limitations.
Free-model request counts are integer values and retain their separate scope. This is
not the Codex percentage snapshot API and does not change platform team budgets.

Non-reported statuses are authentication_unavailable, rate_limited,
provider_payment_required, unavailable, cancelled_or_timed_out. They cannot contain a
sample. Success and failure observations require the current account epoch and resource
revision; same timestamp/exact payload retries are idempotent, conflicting or older
observations rejected. Latest collection status, last successful observation and an
append-only resource audit entry are persisted transactionally. Separate source rows
avoid overwriting key observations with account-credit data.

Admin-only `GET /api/v1/messaging/monetary-quota?host=...&profile=...` returns source
statuses and last_reported plus its freshness. A collection failure is never represented
as a fresh successful collection. Binding rotation returns binding_changed and hides
old-account amounts; the first failed observation on a new binding cannot inherit the
old balance. These facts remain eligible_for_dispatch=false: scope-aware monetary
admission is still pending and no account/key/organization amounts are added together.
Host resource coverage projects these facts separately under provider_monetary; missing
support on an older Hub leaves independent percentage-window evidence intact.

`prepareMonetaryCollector` pins the binding before polling and retries a lost publication
response with the exact same sample before polling again. Its pending publication is
in-memory; restart needs a fresh collector/poll and does not claim durable provider-query
recovery. Polling/authorized transport activation and remote monetary forwarding are not
yet connected to the automatic execution path.

### Monetary resource admission (messaging schema 17)

Resource policies optionally add `monetary: [{source,currency,free_models?}]` (at most
three distinct sources). Existing policies omit this field unchanged. `limit_ids` may
be empty only if monetary requirements exist. Currency is usd/cny (OpenRouter requires
usd); `free_models` applies only to OpenRouter key facts. Source selection is explicit
owner policy, not inferred from a model name. No cross-currency addition/conversion.

The existing transactional resource evaluator now combines all required percentage and
monetary facts for recommendation, operation claim/renewal and official-call admission.
Paid-model policies ignore free-model request counters; free-model policies include
them. Account/key/applicable organization limits in the selected currency remain in
scope. A positive balance is capacity evidence, not a team reservation or permission.
Fresh complete endpoint evidence is required by require_fresh; unknown/partial/stale
facts may use the existing team_budget policy only with enforced budget admission.

`monetary_evidence` retains explicit limit exhaustion, provider unavailability and
collection authentication/payment/rate-limit failures across partial samples and process
restart. Unknown samples never erase known denial; explicit newer recovery clears only
the corresponding evidence. Monetary amounts determine exhaustion without trusting the
presentation `reached` flag. An explicit null key cap with unlimited=true is unbounded
only for that key cap, never the account or organization. Future/expired observations
cannot establish freshness. Passed reset times invalidate their window evidence and
require refresh or the configured unknown policy; they do not synthesize a full balance.
Schema 17 replays monetary audit observations to preserve v16 exhaustion history.

`provider_monetary_exhausted` and collection failure reasons deny admission even under
team_budget. Lease TTL is bounded by monetary freshness/reset deadlines. Old policies
without monetary requirements preserve their behavior; automatic collector activation,
remote monetary transport and Builder policy coverage remain separate pending work.

### Remote monetary collection

v2 peers now negotiate `operation_monetary_quota_v1` independently. Both inbound requests
and outbound operation queues enforce the flag (in addition to operation/accounting/quota
capabilities). Older peers receive no unknown action; the caller gets a missing-capability
error. Ordinary messaging and existing quota actions keep their prior gates.

The owner-only operation-accounting relay accepts `monetary_context` and
`monetary_quota {observation}`. Authenticated execution-node/worker identity must match
the assignment. Home validates the current attempt, frozen resource identity, account
epoch/binding revision and selected monetary source. Context contains home policy/binding
and monetary facts. The execution Host cannot use this path for unassigned resources,
unconfigured sources, a different attempt or account rebindings. Ordinary session tokens
remain forbidden from publishing trusted quota.

`prepareRemoteMonetaryCollector` acquires that scoped context before polling and shares
the local collector's same-payload publication recovery. Remote collection creates no
second authoritative balance ledger: facts, audit, evidence and admission remain on home.
Automatic trusted transport activation and idle collection outside a registered assignment
remain pending; this relay does not discover credentials or grant additional source access.

### Home-owned team drafts (schema v18)

Owner/admin HTTP only: `POST /api/v1/messaging/teams` accepts `{id, request_id,
expected_revision, spec}`. Unknown fields are rejected. The typed spec contains name,
purpose, kind, workspace references, execution targets, workers, coordinator targets,
workflow references, grant/budget/scheduling policy references, concurrency limits and
proactive mode. Empty resource/policy references may be saved for interview drafts;
internal references and bounds must still be valid. No plugin code or credential fields.

First save mints stable `superagent_id` and `conversation_id`; neither is a runtime
session. Home identity is derived from the server, and `local_owner` denotes this Hub's
single authenticated owner scope (not a cross-Hub or multiuser identity). Edits append
integer revisions with CAS. Exact request retries return the original saved revision,
even after later edits; conflicting reuse fails. Kind is immutable. Saving does not
activate, run workers, allocate budgets or create an IM contact: status stays draft,
active_revision is null and eligible_for_execution is false.

`GET /teams?after=<team-id>&limit=1..50` lists latest revisions with next_cursor;
`GET /teams/:id` reads latest and `GET /teams/:id/revisions/:revision` reads the immutable
snapshot. `GET /teams/:id/events?after=<seq>` returns up to 200 ordered audit events and
next_cursor. All paths use the `/api/v1/messaging` prefix. Session credentials are denied.
Revision, stable identity and audit insert commit together. Schema upgrades use existing
SQLite-consistent backup/transaction machinery. Workflow/resource validation and human
activation, role-limited draft tools, conversations/messages and remote team commands
remain separate endpoints/work; these draft APIs confer no execution authority.

### Workflow graph preflight (structural draft contract)

Owner-only `POST /api/v1/messaging/workflows/validate` accepts `{id,version,inputs,
stages,completion_stages}`. Each stage declares `{id,role,requires,produces,
independent_from,on_reject?}`; a rejection edge declares `{target,max_reworks}`.
Unknown fields are rejected. Input and stage identifiers are unique and disjoint;
dependencies reference inputs or stages. Ordinary dependencies must form a DAG.
Independence references and rejection targets must be ancestor stages; rejection
counts are bounded to 1..100. All declared stages must contribute to configured
completion stages. There are at most 64 stages and the serialized pack is at most
64 KiB. Output is a deterministic topological order with `structurally_valid:true`
and `eligible_for_execution:false`. This endpoint is read-only and does not save,
activate or execute a workflow. It does not validate evidence schemas or actual
assignment independence, project/delivery bindings, resources, budgets or grants.
Those remain explicit pending checks; no fixed stage names imply completion.

### Immutable workflow graph versions

Owner-only `POST /api/v1/messaging/workflows` validates and stores the graph pack.
`(id,version)` is immutable: equal canonical content returns the original record,
including its timestamp; different content is rejected. Save and its audit event
commit together. `GET /workflows/:id/versions/:version` reads an exact version;
`GET /workflows/:id/events?after=<seq>` returns at most 200 events with next_cursor.
These paths share the `/api/v1/messaging` prefix. Session tokens are denied.
Schema v19 adds workflow_versions and workflow_events using the existing consistent
backup/transaction upgrade path. No update/delete/latest-version alias is exposed.

The SHA-256 hash uses UTF-8 `kode.workflow.graph.v1\n` followed by compact typed JSON.
Pack field order is id,version,inputs,stages,completion_stages. Stage field order is
id,role,requires,produces,independent_from,on_reject; absent rejection is null, and
rejection fields are target,max_reworks. Inputs/completion stages and each stage's
requires/produces/independent_from sort lexicographically; stages sort by id.
These arrays denote sets. Hashes exclude home identity, actor and creation time.
The response retains the originally submitted pack and adds hash/hash_format,
home_hub, created_at, actor and topological_order. Saving remains non-executable;
full evidence schemas, project/delivery bindings, team activation and runtime
enforcement are still separate work. Future schema extensions must use a new
canonical domain rather than reinterpret these stored graph versions.

### Team workflow binding diagnostics

Owner-only `GET /api/v1/messaging/teams/:id/revisions/:revision/workflow-preflight`
checks an exact immutable team revision against saved workflow id/version/hash.
It returns structured issues (`workflow_required`, `workflow_version_missing`,
`workflow_hash_mismatch`, `stage_role_unassigned`) and each stage's configured
candidates. Worker role matches require nonempty allowed target IDs; the system
coordinator role also uses coordinator_targets. These are configuration matches,
not checked executor availability or scheduling decisions. Independent stages
carry `requires_distinct_assignment_context`; sharing a worker definition/model
is permitted, but runtime must use independent Assignment/context identities.
The result is read-only, with team_revision, checked_at, workflow_bindings_valid,
pending_checks and eligible_for_execution=false. It cannot activate a team,
reserve resources or satisfy the later evidence/grant/budget/admission checks.
Missing team revision returns 404; session credentials are denied. Workflow
diagnostics may improve when a missing immutable version is subsequently saved;
the team revision itself does not change.

### Structured artifact observations

Owner/Host-only `POST /api/v1/messaging/artifact-evidence` accepts
`{id,operation_id,attempt,epoch,payload}` for a local operation with historical
active admission at the exact attempt/epoch. Worker session tokens are denied;
remote evidence must use the negotiated accounting relay, not this direct endpoint. The producer
address/owner are derived from the operation, not caller-supplied identities.
Records append to operation_events and are available through its existing cursor
API. `(operation_id,id)` is immutable: exact replay returns the original sequence;
changed content fails. Late observations remain history, not current acceptance.

Payloads are strict tagged objects:
- `artifact`: snapshot with repository_id, base_revision, tree_hash, patch_hash
  and artifact_hashes (named SHA-256 values). No commit is required. Snapshot
  digest is SHA-256 of `kode.artifact.snapshot.v1\n` plus compact typed JSON in
  that field order, with artifact_hashes keys sorted. Base revisions and repository
  references still require trusted capture/resolution; the API does not inspect Git.
- `review`: artifact_sequence, snapshot_hash, verdict and findings. Findings have
  id, blocking and evidence_ref. Passed cannot contain blocking findings. Source
  must be an artifact observation under the same owner, with the exact snapshot
  digest, and different producer operation and node/session context.
- `verification`: artifact_sequence, snapshot_hash, verdict, environment_hash,
  command_id, command_revision, scenario_ids, exit_code and log_ref. Passed requires
  exit_code=0, nonempty unique scenarios and the same artifact reference checks.
  Command references are identifiers, never an executable command string.

Verdicts are passed/failed/inconclusive; waiver is not a passed observation or an
accepted payload variant. Hash fields use lowercase SHA-256 hex. Each observation
is at most 64 KiB, with bounded findings/scenarios/artifacts. Receipt includes
record, sequence, duplicate and completion_authorized=false. These are typed Host
observations, not proof the cited log exists or the command covered acceptance.
WorkRun must additionally bind frozen assignments/policy, current artifact,
evidence provenance and required scenarios, resolve findings/waivers and reject
superseded evidence before completion. This endpoint does not report operations,
authorize retries, change workflow state or provide that final gate.

Artifact forwarding uses the independently negotiated `operation_artifact_evidence_v1`
capability together with operation/accounting support. Accounting action
`{kind:"artifact_evidence",evidence}` carries the existing structured payload.
Both sending and receiving links enforce capability negotiation. The execution
Host's admin-only accounting relay verifies its local Worker and authenticated peer;
home verifies the assigned worker node/session and exact envelope operation/attempt,
then applies the same admitted-attempt, snapshot, independence and idempotency checks.
Only home stores the resulting operation audit record. Worker session-token routes
cannot submit collector evidence, and home direct collection rejects remote workers.
Receipt replay changes neither operation state nor execution authority.

### Workflow evidence declarations

Workflow packs may declare a nonempty `evidence_rules` object keyed by output name.
In this form each output has exactly one producer and one rule; missing/extra rules
and duplicate producers are rejected. Rules are strict tagged objects:

- `{kind:"artifact",repository_binding}` names a project repository binding.
- `{kind:"review",artifact_output}` references an ancestor's artifact output and
  requires that producer stage in the reviewing stage's independent_from list.
- `{kind:"verification",artifact_output,command_binding,environment_binding,
  required_scenarios}` references an ancestor artifact and pins named command and
  environment bindings with 1..128 distinct scenario IDs. Commands are identifiers,
  not shell snippets, and the referenced output must have an artifact rule.
- `{kind:"report",schema_id,schema_hash}` pins a named report schema and SHA-256.

The map is limited to 128 entries. Preflight returns evidence_rules_declared and
team workflow diagnostics expose these rules. These are declarations: project,
command/environment and report schema resolution, runtime evidence matching and
WorkRun completion gates remain required. Graph-only legacy drafts remain storable
with evidence_rules_declared=false and cannot be treated as evidence-complete.

Nonempty rules use hash_format `kode.workflow.evidence.v2`. Its canonical bytes use
that domain plus newline, followed by the existing typed graph JSON with evidence_rules
appended after completion_stages. Map keys sort lexicographically. Rule field order
follows the tagged forms above; required_scenarios sorts lexicographically as a set.
Empty/absent maps are omitted and preserve the exact graph.v1 canonical bytes.
Adding/changing rules requires a new immutable version. There is no database schema
change or reinterpretation of existing stored versions.

### Stored workflow evidence matching preflight

Owner-only `POST /api/v1/messaging/workflows/check-evidence` accepts an exact
`workflow:{id,version,hash}`, stage_id, assignments keyed by stage
(`{operation_id,attempt,epoch}`), output-name to audit-sequence mappings, repository
bindings to repository IDs, command bindings to `{id,revision}`, and environment
bindings to expected SHA-256. Each map is bounded to 128 entries. Only saved
workflows with evidence rules are accepted. Evidence is loaded from operation_events;
the caller cannot submit evidence bodies to this endpoint.

Matching requires the current operation attempt/epoch, active unexpired or reported
state, same owner, and the exact output producer assignment. Artifact repository
bindings, passed review/independent producer, exact selected artifact sequence/hash,
passed verification/zero exit, command revision, environment and required scenarios
must match. Changing the selected artifact invalidates old review/verification.
Missing/stale evidence and rule mismatches are structured issues. Report-schema
evidence remains unsupported and cannot pass. No stage names are special-cased.

Response includes evidence_matches, issues, completion_authorized=false and
binding_context=caller_supplied_preflight. This read-only diagnostic deliberately
does not accept its caller-supplied assignments/bindings as an activated WorkRun.
The eventual runtime must use frozen run context, check dependencies/current artifact
selection, trusted execution provenance, schemas and delivery policy before applying
any completion transition. No operation/team/workflow state changes here.


### Immutable project bindings and delivery policies

Owner-admin routes: POST `/api/v1/messaging/project-configs`, GET
`/api/v1/messaging/project-configs/:id/versions/:version`, and GET
`/api/v1/messaging/project-configs/:id/events?after=...` (up to 200 records).
Session credentials cannot read or mutate this configuration. Schema v20 adds
project_configs and project_config_events, with the existing pre-upgrade backup.

A configuration is `{id,version,spec}`. The strict tagged spec is either
`project_bindings` or `delivery_policy`. Project bindings contain named repositories
(repository_id and WorkspaceRef), environments (host_id, adapter_id,
configuration_hash), commands (id, revision, definition_hash, repository_binding,
environment_binding, runner_id, scenario_ids), and connections (adapter_id,
connection_id, capabilities). Commands reference trusted runner definitions; they
do not accept executable shell strings. Connections accept references, not secrets.
Command repository and environment Hosts must match.

Delivery policies pin project and workflow `{id,version,hash}` references and
required_outputs plus typed targets: local, change_request, merged, deployed,
or custom capability/target_ref. Repository, environment and connection references
must exist; change/merge requires a target branch; custom requires its declared
connection capability. Workflow artifact repositories and verification command,
environment, source repository and scenario references must resolve consistently.
This allows multiple repositories and an independent tracker, including purely
local projects. It does not call any external adapter or perform delivery.

Versions are immutable. Canonical typed JSON uses the `kode.project.config.v1`
domain and SHA-256; maps and set-valued lists are normalized. Exact retries return
the original record and do not add audit events. The response records home_hub,
actor, hash, config and pending_checks with eligible_for_execution=false.
Workspace registration, trusted runner/adapter capabilities, report schemas,
grants, frozen WorkRun bindings and team activation remain required before use.
These registration endpoints confer no execution or external-service authority.


### Team project/delivery binding references

TeamSpec accepts optional `delivery_bindings`: up to 64 named entries
`{id,workflow,project,delivery_policy}`, each reference `{id,version,hash}`.
Names are unique; workflow references must exactly match a team workflow_pack_refs
entry. Empty/absent bindings serialize identically to legacy drafts so idempotent
save requests and existing revisions remain compatible. Saving incomplete drafts
remains allowed; no configuration save activates a team.

The existing owner-only exact-revision workflow-preflight endpoint additionally
returns project_delivery_bindings_valid, binding_issues and resolved bindings.
Every configured workflow requires a delivery binding. The resolver verifies exact
stored hashes, ProjectBindings/DeliveryPolicy kinds, delivery's own project and
workflow references, and each named repository's full workspace identity against
the team's declared scope. It never selects a latest version or imports workspace
scope from another team. Successful binding rows contain the immutable stored
workflow/project/delivery records. These are resolved diagnostics, not an activated
WorkRun snapshot. Historical team revisions retain their original bindings.

workflow_bindings_valid still describes graph/role configuration only; it does not
imply project_delivery_bindings_valid. Neither boolean confers execution authority.
Actual runner/adapter discovery, worker scope/independence, resources, grants,
budget, activation and frozen run context still gate future execution.


### WorkRun intake and never-dispatched cancellation

Owner-admin endpoints: POST `/api/v1/messaging/work-runs`, GET/POST
`/api/v1/messaging/work-runs/:id`, GET `/api/v1/messaging/work-runs/:id/events?after=...`.
Session principals are denied. Schema v21 adds work_runs, work_run_commands,
work_run_events and team/event indexes using the consistent-backup migration path.

Create accepts `{id,request_id,team_id,team_revision,binding_id,inputs,prior_run_id}`.
IDs/revision and total request size (64 KiB) are bounded; inputs must be nonempty
text values with exactly the selected workflow's input names. The explicit team
revision must be a coordinator team with valid graph/role and project/delivery
bindings. The named binding must belong to that revision. No latest-version
fallback is used. A prior_run_id must reference a terminal run of the same team.

The stored context embeds the exact immutable team, workflow, project and delivery
records, hashed as SHA-256 of `kode.work.run.context.v1\n` plus recursively
key-sorted compact JSON. JSON array order remains significant. Later team edits
cannot replace this context. Intake initializes pending stage rows (attempt 0,
assignment_id null), state waiting_user, waiting_reason team_activation_required,
and dispatch_state not_dispatched. Team activation and runtime dispatch are not
implemented by this endpoint; it does not create sessions, reserve spend or call
models. A received request is not a completed stage or activated team.

The unique team/request_id command, run record and received audit event commit
atomically. Same command returns its original initial receipt even after later
cancellation; different content using the same identity rejects. GET returns current
state. The transaction checks team max_active_runs across all nonterminal runs,
including waiting requests. Duplicate retries do not consume additional capacity.

Owner-only POST `/:id` accepts two explicit cancellation commands:
- `{action:"cancel",request_id,expected_revision}` retains the intake-only contract:
  waiting, never-dispatched work with no stage Assignment and no non-abandoned
  historical Assignment. Its audit stop_basis is `never_dispatched`.
- `{action:"cancel_settled",request_id,expected_revision,reason}` closes a
  `waiting_user` Run whose completion is not authorized and whose prior Assignments
  are all completed, execution-drained and resource-released. Reason must contain
  non-whitespace text, have at most 2048 UTF-8 bytes and contain no NUL.

Settled cancellation validates authoritative operation attempt/epoch and terminal
reported/stopped state against each stop receipt, exact finalized reservation
accounting with zero held balance, no unfinished official calls and no held Run
resources. At least one prior Assignment is required. It neither stops active
execution nor manufactures stop/accounting receipts. Missing or unresolved evidence
rejects the command. Current team activation is not required to close already
settled work; deactivation does not prevent owner disposition.

Revision, state update, command result and audit commit in one transaction;
duplicate command returns its original result, conflicting identity or revision
rejects. Settled cancellation preserves stage states, attempts, rework history and
failure evidence, stores `resolution` with reason, prior state/waiting reason,
actor, timestamp and Assignment IDs, and emits `work_run_cancelled` with stop_basis
`settled_assignments`. It does not authorize delivery. Terminal Runs cannot be
revived; a new request may reference this cancelled Run using `prior_run_id` under
the existing same-team intake rules. Active cancellation/draining remains a
separate unfinished path. Events page by seq with a 200-row bound. Completion uses
the separately documented frozen-context and evidence gates.


### Team budget and scheduling policies

Owner-only POST `/api/v1/messaging/team-policies` accepts
`{id,team_id,expected_revision,policy}`. GET `/team-policies/:id?revision=N`
reads an immutable revision; omitting revision reads the current pointer. Strict
policy variants are budget (`budget_ids`, `unit`, `max_assignment_charge`) and
scheduling (`targets`, `weights`, `minimum_quality`, `minimum_confidence`). Targets
map the TeamSpec target ID to `{resource,capability_id,capability_revision,preferred}`;
resource uses the existing structured resource-admission policy, including explicit
unknown-quota handling and applicable limit buckets/monetary sources. Weights contain
quality/cost/latency, each 0..1000 with a nonzero total. Quality is 0..100 and
confidence 0..1. No executor/model name is hardcoded.

Budget IDs are unique (1..8), unit must match every configured budget, team-scoped
budgets must belong to the policy team, and the positive max_assignment_charge must
fit each configured budget limit. Shared budgets retain their shared scope. This is
configuration validation, not available balance or a reservation; policy writes
never spend funds. Current budget period/availability and actual charge enforcement
must be rechecked during admission/accounting.

Each revision is immutable, hashed with the kode.team.policy.v1 domain, and stores
actor/time/home_hub alongside its policy. Budget IDs and resource limit ID sets are
sorted. Team and policy kind cannot change. A retry for an existing matching
revision returns its original row even after later revisions; it does not move the
current pointer backwards. Conflicting same-revision writes reject. Historical
records and current pointer commit together in workbench_documents, reusing the
existing transaction and durable document schema.

Team preflight now resolves budget_policy_id/scheduling_policy_id and returns
execution_policy_bindings_valid, policy_issues and policies. It checks team/kind,
exact target coverage, host/profile/account identity and capability revision. These
are current policy diagnostics; activation must pin the reviewed policy revision
and hash instead of silently resolving newer versions. Declared capability/resource
references do not prove live executor support or quota availability. This endpoint
does not activate, reserve or dispatch; eligible_for_execution remains false.


### Explicit team activation consent

Owner-only GET/POST `/api/v1/messaging/teams/:id/activation`. POST supports:
- `{action:"activate",request_id,expected_revision,team_revision,grant_revision,
  budget_policy:{id,revision,hash},scheduling_policy:{id,revision,hash}}`;
- `{action:"deactivate",request_id,expected_revision}`.

Activation requires a complete coordinator graph/role/project/delivery/policy
configuration. Under the commit transaction it rechecks the latest draft revision,
exact reviewed policy revisions/hashes, current enabled/unexpired same-team grant,
read capability and delegation if workers are declared, exact declared workspace
host/id/root coverage, approved budget IDs and their actual ownership/unit. It
never chooses a newer policy silently. Root references currently must equal an
explicit grant root; opaque/unresolved roots cannot pass this authority check.
Actual workspace registration, trusted adapters and capability discovery still
belong to execution readiness; declaration alone is not proof of those facts.

The consent record stores its revision, actor/time/home, complete team/binding/
policy/grant snapshot and SHA-256 under kode.team.activation.v1. active means the
owner has authorized this snapshot, not that resources are currently executable.
eligible_for_execution remains false until execution integration is implemented.
GET additionally reports authority_valid by checking current grant revision,
enabled state and expiry. Revocation does not erase the original consent record.
Policy changes do not rewrite an existing consent snapshot.

Immutable activation revisions, current pointer, command receipt, team audit and
eligible undispatched WorkRun updates share one transaction in existing tables.
Retries return the original receipt even after deactivation/revocation; GET is the
current state. Conflicting command content or expected revision rejects. No new
schema migration is required.

For the matching team revision, first activation attaches a separate immutable
WorkRun authorization snapshot and advances waiting_user to waiting_resource with
execution_adapters_not_ready. It preserves context_hash and never starts a stage.
New intake checks live authority in its insertion transaction and attaches the
same snapshot when valid. Deactivation returns authorized, never-dispatched runs
to waiting_user/team_deactivated, retaining their original authorization evidence.
Identical-snapshot reactivation can resume them; a changed snapshot cannot silently
replace their authority. Terminal runs remain terminal. Undispatched cancellation
now also accepts waiting_resource; running executor cancellation is still outside
this endpoint. Stopping live assignments and lease revocation must be integrated
before any claim of end-to-end team deactivation is made.


### Atomic managed-operation preparation

Owner-admin POST `/api/v1/messaging/operation-bundles` accepts
`{owner_session,request_key,worker,selection_policy,funding,resource,grant_id,grant_scope}`.
Funding contains `{budget_ids,amount,unit}`; resource, selection_policy and grant_scope
reuse existing strict operation contracts. The execution node must be local or a
known peer. Session-token callers cannot use this trusted Host endpoint.

One transaction creates an operation requiring budget/resource/grant checks,
reserves all named budget constraints, attaches the reservation/grant/resource,
checks current grant/budget/resource admission and persists the initial receipt.
Any rejection rolls back the operation, attachments, all budget counters, reservation
and audit events. The transaction performs no network/CLI/model call. Existing
individual APIs use the same extracted transaction helpers and retain their behavior.
Internal callers must propagate helper errors and abort the enclosing transaction.

The owner/request_key identity returns the original bundle receipt on retry;
changed content rejects. An operation already created outside this atomic path
cannot be adopted. Duplicate retry after claim or restart never rewinds the current
operation. Read its ordinary operation endpoint for live state. Result contains
operation, reservation, explicit resource_decision and dispatch_state=not_dispatched.
Provider quota fallback still explicitly requires a team budget; the budget is not
represented as provider balance. Actual lease claim rechecks live authority and
requires exact selection/resource acknowledgements.

This is a trusted preparation primitive for upcoming WorkRun dispatch. It does not
select stages, validate a full workflow, acquire a workspace lock, create sessions
or run a model. Stage scheduling must derive this request from frozen activation
and runtime capability facts and commit its assignment/outbox in the same transaction,
using the internal helper rather than a sequence of HTTP attachment calls.


### Abandon an unclaimed operation bundle

Owner-admin POST `/api/v1/messaging/operation-bundles/:id/abandon` accepts
`{request_id,expected_revision}`. It is only valid for an unchanged operation
created through atomic bundle preparation: original operation ID, revision,
attempt and epoch must match, state must remain prepared and lease absent.
The bound reservation must be the original reservation, revision 1, unfinalized,
with zero charge and no charge-basis observation. Any accounting activity requires
normal reconciliation, even if the observed total is zero.

One transaction finalizes that reservation at zero (explicit manual basis),
releases all held budget constraints, marks operation stopped, advances its
revision and fencing epoch, and stores audit plus immutable command receipt.
stop_basis=never_claimed distinguishes this from confirming a running executor
stopped. Repeated identical requests return the original receipt without another
release; conflicting command content rejects. Ordinary lease claim and abandonment
serialize on the same operation transaction, so they cannot both succeed.

Prepared bundle retries remain historical receipts; they never revive the stopped
operation or restore released funds. A claimed/changed operation, legacy operation,
or reservation with observations cannot use this shortcut. This endpoint does not
replace cancellation/stop confirmation and usage reconciliation for live workers.


### Workflow stage execution scope

A workflow stage may declare strict `execution` with
`{repository_binding,capabilities,tools,network}`. Capabilities reuse the team grant
enum, are unique (up to 8), and require read; tools are unique explicit IDs (up to
256). No shell strings or arbitrary execution fields are accepted. A scoped stage
requires typed evidence rules. Each stage currently selects one named repository;
a workflow can use different repositories across its stages.

Execution repository must match its artifact output/source. Review and verification
evidence producers may request only read capability on that source workspace;
write/commit/push/deploy/delegation cannot be smuggled into those stages. Test cache
or temporary-output writes need a separate controlled runner scope, not permission
to mutate the source snapshot. Report-only scopes must still resolve a repository
when project/delivery bindings are saved.

Any declared execution scope selects hash domain kode.workflow.execution.v3, with
sorted tool/capability sets. Empty/absent execution fields are skipped; existing
workflow.graph.v1 and workflow.evidence.v2 canonical identities remain unchanged.
Changes require a new immutable version. Validation exposes execution_scopes_declared
only when all stages declare scopes; partial drafts remain storable but are not
execution-ready. Team preflight includes each stage's scope.

Activation verifies every declared stage capability/tool/network requirement is a
subset of the reviewed team grant, in addition to workspace and budget checks.
This does not yet connect scope to automatic assignments; trusted tool capability
registration, exact per-assignment grant derivation and actual dispatch remain
required. Missing legacy scopes are not permission to copy the entire team grant
to a Worker. No stage names are hardcoded to infer these restrictions.


### Frozen stage candidate envelopes

Team execution targets accept optional `executor_profile_revision`, a lowercase
64-character SHA-256 fingerprint distinct from capability_profile_revision. The
Host's existing profileRevision metadata supplies this value; it is not inferred
from a user assessment version. Missing fields preserve legacy team serialization
and drafts, but cannot form a stage candidate. This declaration still requires
live Host revision/model/effort discovery before dispatch.

Owner-only GET `/api/v1/messaging/work-runs/:id/stages/:stage/plan` derives candidate
envelopes from the run's immutable context and authorization. It rejects candidate
generation for unschedulable runs, absent/currently invalid or changed authority,
already-assigned stages, unmet inputs/stage dependencies or missing execution scope.
Matching Worker roles must explicitly include the exact workspace; targets must
belong to that role and execute on the repository Host. Missing executor fingerprint
or mismatched Host excludes the target. Coordinator role uses its configured target
list. Candidate data contains exact model/effort/configuration selection policy,
separate capability reference, frozen resource policy, preferred flag, budget unit
and per-assignment ceiling, and grant scope narrowed to stage tools/capabilities/
network and exact repository workspace. It never copies the full team grant.

The response includes run_revision/run_state/context_hash/authorization_hash for later atomic
revalidation, including the missing-scope response. Candidate scheduling contains the
frozen quality/confidence floors, scoring weights and team concurrency limits; these
are requirements for later admission, not observations that a candidate satisfies them.
The run and live authority are read from one database transaction. The candidate
derivation is reusable inside a future dispatch transaction without nested Store locks.
Current policy edits cannot replace frozen run policies. This is
read-only preflight, not a reservation, assignment or lease: eligible_for_dispatch
is always false. Quality floor, live executor/tool/model capability checks, resource
and budget admission, runtime assignment independence, and atomic assignment/outbox
remain required. The future mutation must revalidate under its own transaction;
a successful earlier read is not authority to dispatch after revocation.


Stage.execution optionally declares `task_tag`, an explicit capability-assessment
category using workflow identifier syntax. It is never inferred from role or stage
names. Any declaration uses canonical domain `kode.workflow.execution.v4`; packs
without it keep their existing v1/v2/v3 identity. Changing the tag requires a new
immutable workflow version. Missing tags remain storable drafts.

Stage plan candidate `recommendation` evaluates the exact frozen capability revision,
quality/confidence floors and score weights against this tag, plus current account
binding and quota evidence, inside the same read transaction as run/authority.
`recommended=false` includes an exclusion reason; a missing tag reports
`stage_task_tag_missing`. These diagnostics stay attached to the configured candidate
envelope, not silently dropped. Current capability revisions cannot replace the
frozen assessment. Unknown quota may still require an actual team-budget reservation;
a positive recommendation is not executor readiness, a reservation or dispatch
permission. All time-sensitive conditions must be rechecked in the assignment transaction.


### Prepared workflow assignments (schema v22)

Owner POST `/api/v1/messaging/work-runs/:id/stages/:stage/assignments` accepts
`{request_id, expected_revision, target_id, worker_id}` (worker_id null selects the
configured coordinator). The Hub re-derives the frozen stage plan in its transaction,
requires a positive quality/resource recommendation, known execution Host and free
team assignment capacity. It allocates a new assignment/session identity, atomically
prepares the granted/selected/resource-bound budget bundle, records the next stage
attempt and immutable receipt, and inserts a blocked dispatch outbox command.
No caller tool/grant/funding/model overrides are accepted. Duplicate commands return
the original receipt even after abandonment; changed contents conflict. Owner GET
`/api/v1/messaging/work-assignments/:id` returns current stored assignment state.

This state is explicitly **prepared**, not running or dispatch-authorized. Linked operation claims/renewals reject until the separate resource reservation
and trusted Host admission described below succeed.
The owner Host pump below can deliver creation; task mandate delivery remains pending.
Team capacity and budget holds are reserved, but
this does not claim account/global execution slots or workspace locks were reserved.

Owner POST `/api/v1/messaging/work-assignments/:id/abandon` takes
`{request_id, expected_revision}` where revision is the current WorkRun revision.
Only a blocked or ready prepared assignment with an unchanged never-claimed bundle and no
accounting activity can release its holds. One transaction stops/fences the operation,
finalizes zero settlement, abandons assignment, cancels its outbox, restores the stage
to pending (retaining its attempt count), updates the run and saves audit/receipt.
Direct bundle abandonment rejects linked assignments. Subsequent preparation uses a
new assignment/session/attempt; original receipts never revive old state. Intake
cancellation also permits runs whose assignments were all proven abandoned and whose
stages have no remaining assignment. Active/uncertain execution cancellation is not
implemented by this shortcut.


### Assignment resource holds (schema v23)

Owner POST `/api/v1/messaging/assignment-capacities` configures an existing resource
account with `{account_id, expected_revision, max_active_assignments}` (1..1024).
Missing configuration denies resource reservation. Reducing capacity below current
holds rejects. Owner GET `/assignment-capacities/:id` reports revision/capacity/held
count. Capacity applies across teams on this home Hub, not external consumers or
independently managed home Hubs.

Owner POST `/api/v1/messaging/work-assignments/:id/resources` accepts
`{request_id, expected_revision}` where revision belongs to the Assignment. It
rechecks frozen run/stage/authorization identity, current activation, exact capability
revision and live quality/quota, unchanged prepared operation, grant and budget.
Within that transaction it reserves an account slot plus exclusive declared workspace
root, writes receipt/assignment revision/audit. Same-Host equal/ancestor/descendant
roots conflict even across accounts or teams. The root is declared data: symlink
identity and actual kernel workspace locks still require trusted Host admission.

Receipt retries do not reacquire released resources. Holds have no automatic TTL
release; disabled accounts, revoked grants, lost Hosts and lease expiry do not prove
execution stopped. Existing never-claimed Assignment abandonment releases holds in
the same transaction as budget settlement and outbox cancellation. Live/uncertain
release still requires future stop/evidence reconciliation. Resource reservation
leaves dispatch blocked; raw operation claim/renew remains rejected. This endpoint
is not an executor readiness assertion or permission to perform model/tool effects.


### Trusted local Assignment Host admission

Owner POST `/api/v1/messaging/work-assignments/:id/admit` accepts
`{request_id, expected_revision, worker_session, profile_revision, provider, model,
effort, tools, root}`. Revision belongs to the Assignment. It requires the exact
prepared command and local worker identity, held account/workspace resources,
current frozen-run authority, capability/quality, grant, budget and resource
admission. Only stages requiring external workflow inputs and with no independence
requirement are currently admitted. Dependent stages require future evidence admission.
The trusted official Host resolves adapter configuration and registered tool policy,
checks canonical granted workspace and acquires its native kernel lock before this
request. This is owner-only infrastructure, never a Worker readiness assertion.

One transaction marks dispatch ready, records Host evidence and audit, and stores
an immutable retry receipt. Changed retry payload rejects; historical receipts do
not restore revoked authority. Claim/renew and operation availability recheck live
Assignment authority and holds. Previously blocked operations remain unclaimable.
The Host holds the workspace lock for the execution lifetime, including any in-flight
action during cancellation; scoped tools borrow that lock. Adapter configuration is
explicitly `inference_verified=false`. This does not implement remote Host admission,
automatic outbox delivery, stage completion or active resource settlement.


### Assignment creation delivery and receipts

Owner GET `/api/v1/messaging/assignment-dispatches?host=<id>&after=<id>` lists
prepared blocked/ready/uncertain outbox entries, ordered by Assignment ID, at most
64 per page. `next_cursor` continues the scan. Created and abandoned entries are
excluded; listing is not authorization. New IDs preceding a cursor appear on the
next scan from the beginning. No Worker access is allowed.

Owner POST `/api/v1/messaging/work-assignments/:id/creation` accepts
`{request_id, command, state}` (`created` or `uncertain`). The full command must
match the immutable Assignment command and execution Host must be this Hub.
Created requires Host admission and a persisted claim event for the exact operation
attempt/epoch. This is a trusted Host creation observation, not proof that an Agent
is currently alive. A transaction stores creation status, updates outbox state,
advances Assignment revision, audits and saves immutable command receipt.
Uncertain may advance to created through reconciliation; created cannot downgrade.
Retries preserve historical results and never revive an abandoned outbox.
Creation does not advance StageRun or declare work complete.

The dsh owner service `assignmentDispatches.drain({prepare})` scans this queue.
The trusted callback supplies scoped tool setup or declines unsupported assignments.
It freezes a new managed binding without replacing an existing identity, reserves
resources, invokes official dispatch and acknowledges its durable receipt. Per-ID
in-flight requests join; local created receipts are replayed, uncertain receipts use
read-only persisted-session reconciliation. A missing local ledger when the Hub
already recorded creation requires recovery, never blind creation. The service is
available to orchestration but does not start a background loop. Creation-only
dispatch/drain does not send task input; start below adds mandate delivery. Full
workflow lifecycle supervision remains pending.


### First-stage Assignment mandate inbox

Owner POST `/api/v1/messaging/work-assignments/:id/mandate` accepts
`{request_id, expected_revision}` (Assignment revision). It requires acknowledged
creation, local registered Worker, the exact active unexpired operation, live frozen
run authority, grant, resources, quality and budget. It currently accepts only
external-input stages without independent/upstream artifact context requirements.

The transaction constructs `kode.assignment.mandate.v1` from the frozen context:
stage/attempt, exact required inputs, repository binding, evidence rules, grant,
funding, operation fencing identity, home Hub and context/authorization hashes.
It inserts a normal durable `received` message and its event, then stores the
Assignment-to-message link, content SHA-256, immutable retry receipt and WorkRun
audit together. Source is the stable Superagent identity, not a fabricated runtime
session. This internal owner operation does not relax public send authentication.
The queued receipt is not runtime acceptance or consumption. Input is never
truncated: content exceeding the existing 64 KiB message limit rejects atomically;
large-input paging remains pending. The message has the standard 24-hour expiry,
while actual model/tool calls still require current execution authority.

The controlled Host `assignmentDispatches.start(id, {setup})` creates/reconciles
its Worker then queues the mandate only while the original owned handle exists.
A historical created receipt does not authorize automatic runtime recovery.
The existing Host inbox pump, deterministic input IDs, persistence flush and
DeliveryTracker record queued/consumed evidence. Managed Assignment input must
match the Hub message ID and full content hash plus operation/context identities;
copied content in another message is refused. Full mandate input bypasses ordinary
peer preview truncation and does not instruct the Worker to use unrestricted peer
communication tools. Read existing message/delivery endpoints for consumption.
Exact command retries remain historical after revocation/restart and never requeue.
Neither consumption nor a model response advances stage completion.


For managed Assignments the official model entry also revalidates the actual user
input projection against the Hub-bound mandate. It requires exactly one matching
deterministic input ID and complete content, and a successful session persistence
flush before call admission/selection evidence or inference. Missing mandate,
altered content, extra user input or direct followup injection fails before a new
metered call. Ordinary managed operations without an Assignment retain prior behavior.
This currently covers the original first-stage context; authorized follow-up,
compaction/context replacement and takeover require explicit future workflow support,
not silently accepting a different task under the existing Assignment.


### Frozen WorkRun stage output selection

Owner POST `/api/v1/messaging/work-runs/:id/stages/:stage/evidence` accepts
`{request_id, expected_revision, assignment_id, outputs}`. Revision belongs to the
WorkRun; outputs maps exactly this stage's declared output IDs to stored artifact
event sequences. Callers cannot override workflow, repository, command, environment
or producer bindings. The transaction derives those from the frozen WorkRun and
recorded Assignments/selected upstream outputs, rechecks current frozen authority,
retained resource ownership and completed dependencies, requires consumed mandate
evidence, and applies the
shared workflow evidence validator using one database/time snapshot.

Mismatched repository/type/producer/attempt/epoch or stale evidence rejects without
mutation. A successful selection freezes output references and context/authority
identity on the StageRun, advances WorkRun revision, records audit and stores an
immutable command receipt. Same-key replay remains historical; changed payload
conflicts. Another selection requires a new stage attempt rather than silently
replacing an already reviewed artifact reference. New observations for an assigned
operation also require a consumed mandate; prior observation retries stay historical.

Selection does not mark the stage passed, release resource/budget holds, advance
its dependents or complete the WorkRun. Reported execution, confirmed stop, usage
settlement, trusted verification/independent context and delivery-policy finalization
remain separate pending gates. The original caller-supplied evidence diagnostic
endpoint remains read-only and cannot authorize completion.

Stage output selection accepts valid already-produced evidence when execution
resources become unavailable (for example, a disabled account).
It still requires current authority/grants and the original operation attempt/epoch;
revocation rejects new selections. Claim, renewal and new execution continue to
require live budget/resource admission. This does not permit late expired-lease
results or prove that an executor has stopped.

Controlled official finish uses a report-only lease check: exact owner, attempt,
epoch, profile/selection identity and unexpired, non-aborted local lease remain
required; execution budget/resource availability does not block reporting. The
Hub report transaction rechecks the current Assignment authority and retained
holds as well as grant/selection evidence. It does not renew the lease, authorize
more tools/model calls, release holds or finalize the stage. Existing execution
admission and renewal remain strict. Once renewal/execution has already aborted
the local lease, this path cannot revive it; stopped/uncertain recovery requires
its own receipt protocol.


### Local Assignment execution drain receipt

Owner POST `/api/v1/messaging/work-assignments/:id/stop-receipt` accepts
`{request_id, command, kind:"official_local_drained", final_artifact?}`. Command must exactly match
this local Assignment's immutable creation command. Prior Host admission, created
receipt and a stored matching operation claim are required. Ordinary session
principals cannot submit these receipts. Remote Host forwarding is not supported
by this endpoint yet.

The trusted AssignmentDispatchHost.stop path persists stopping intent, disposes
its actual owned official Agent, waits for controlled actions and the whole-run
workspace lock to drain, then durably records `operationClosed` and a local drained
receipt before submitting it. Missing live ownership without a durable drained
record requires recovery, never a fabricated stop. Repeated or lost-response
submission reuses that record without another disposal. Local drain failures do
not produce a confirmed receipt.

The Hub atomically stores one immutable stop receipt/audit, stops the dispatch
outbox and fences an active/uncertain/cancelling operation into stopped with a new
epoch. Already reported operations remain reported to preserve their evidence
identity. Receipt storage is allowed after team revocation: this is a historical
observation, not execution admission. Different receipt contents conflict; exact
replay remains historical after restart.

The result is `execution_drained`, with `completion_authorized:false`,
`resources_released:false`, `accounting:"pending"` and
`external_effects:"not_attested"`. It proves only the controlled local lifecycle;
it does not attest detached subprocesses, reverse external writes, settle provider
charges, release durable holds, mark a StageRun passed/cancelled, or authorize a
replacement attempt. Those require their own evidence and finalization contracts.


### Explicit internal team-budget settlement

Budget team policies optionally accept `settlement:"internal_price"` or
`"reconciled"`. Omission retains reconciliation-required behavior and preserves
existing serialized policy hashes. Activation/WorkRun snapshots freeze this choice;
changing the current draft cannot authorize finalization for an older run.

Owner POST `/api/v1/messaging/work-assignments/:id/accounting` accepts
`{request_id, expected_revision}` with the Assignment revision. Currently automated
finalization requires the frozen internal_price choice, a durable execution_drained
receipt, the unchanged stopped/reported operation attempt/epoch, the original
reservation and its immutable price binding. All official calls must be finished,
fully metered and estimated under that exact binding. Mixed native accounting,
unknown/interrupted calls, counter/pricing anomalies, previously reconciled
reservations or a recomputed aggregate differing from the recorded charge reject.

One transaction finalizes the reservation under basis `internal_price`, releases
its remaining budget hold, records Assignment receipt/revision and audit. It does
not release account/workspace holds, pass stages or confirm provider billing.
Receipt labels this as `团队预算`, `basis:"configured_internal_price"` and
`provider_cost_status:"unconfirmed"`; original per-call observations remain intact.
Budget reads expose `internal_price_charged` separately from `estimated_charged`.
The generic settlement endpoint cannot submit this new basis. Same request replay
returns the historical receipt, including after authority loss/restart, without
another charge; changed request contents conflict. No inference or external effects
are admitted by reconciliation. Provider bill correction remains a separate
reconciliation concern, not an automatic reinterpretation of internal charges.


### Local artifact content archive

Controlled Host capture may retain `archive` metadata in its local evidence outbox:
`{snapshot_hash, archive_hash, bytes, format:"kode.artifact.bundle.v1"}`. This
metadata references a separately persisted private file, not inline profile content.
The bundle contains version, snapshot, base_tree, ordered manifest and a map of
SHA-256 content IDs to canonical base64 bytes. Validation checks safe relative
paths/order/types, all referenced content hashes, no unreferenced content, raw tree
and base-tree/delta hashes, file/byte bounds and the immutable snapshot identity.
Symlinks are stored as text; archive read never follows or materializes them.

The archive is persisted before the outbox observation. Existing capture retries
verify and reuse original bytes even if the source workspace no longer exists;
missing/corrupt archives fail without recapture or overwrite. Legacy observation
records without archive metadata are not upgraded implicitly. The existing artifact evidence receipt alone does not imply content transfer.
The separate archive completion receipt described below confirms Hub content
availability; downstream materialization and remote relay remain separate.


### Home-owned artifact archive transfer (schema v24)

All endpoints are owner-only; session principals cannot upload or read contents:
- GET `/api/v1/messaging/artifact-archives/:sequence` returns metadata.
- POST `.../:sequence/chunks/:index` accepts `{archive_hash,bytes,data}` with canonical
  base64 data. This route alone permits a bounded 384 KiB request body; ordinary
  messaging retains its 128 KiB limit. Chunks are exactly 256 KiB except the final chunk. Entire documents
  are capped at 192 MiB; expanded manifest content remains capped at 128 MiB.
- POST `.../:sequence/complete` accepts `{archive_hash,bytes}`.
- GET `.../:sequence/chunks/:index` reads content only after completion.

Sequence identifies an existing artifact observation, never a caller-supplied
replacement snapshot. First chunk pins immutable archive hash/size. Repeated
identical chunks are idempotent; changed identity/content rejects. A completion
transaction requires all ordered chunks, the full archive digest, strict bundle
shape, safe ordered manifest paths, all file/link content hashes and matching
recorded snapshot/tree/delta. Invalid or incomplete upload cannot be downloaded as
complete. Completion and one operation audit event commit together. Receipt replay
is historical across restart and does not authorize workflow completion.

SQLite artifact_archives and artifact_archive_chunks retain upload state and bytes.
Migration preserves existing evidence and creates a pre-v23 backup. No garbage
collection is currently performed. Corrupt/conflicting upload identity is retained
for diagnosis rather than overwritten.

Host ArtifactOutbox separately tracks home_reconciled (observation) and
home_archive_reconciled (content). New captured archives must have both before
controlled finish; retry reads the immutable local file, resends idempotent chunks,
and verifies completion receipt. Legacy hash-only records stay hash-only. The owner
fetch helper validates each response, reassembles/digests bytes and validates the
bundle against the expected snapshot before returning it; it does not write a
workspace. Local Host-to-home upload is wired; remote operation-accounting relay
has no archive forwarding yet and cannot silently claim content delivery.


### Host snapshot materialization boundary

After owner archive retrieval, ArtifactMaterializer may restore
`{request_id,sequence,snapshot_hash}` to a new directory under trusted Host cache
storage. This does not add a wire execution command. The Host records preparing
before file writes and ready only after file bytes, executable flags, directory
shape, deletions and symlink text match the validated manifest. Path hierarchy
conflicts and symlink targets lexically escaping the new source root are rejected
before destination writes. No project commands, Git checkout, filters or hooks run.

Files/directories become read-only after creation. This is protection against
accidental changes, not OS isolation from the owning user. Same-request reuse
checks exact metadata and contents, rejects altered execution_authorized/version
flags and never repairs a changed tree. A partial directory with no ready receipt
requires recovery; it is not inferred complete. Per-request in-process calls join,
and exclusive directory creation prevents a second process from overwriting the
same destination. Unrelated existing workspaces are never selected as destinations.

The receipt includes a canonical generated source path, archive hash and
execution_authorized=false. It is not an Assignment admission or independent-review
proof. Binding it to authorized downstream grants/identity and proving use of this
snapshot during review/verification remain required before stage advancement.


### Final selected-artifact observation before report

For a managed Assignment with selected artifact outputs, controlled official
finish recaptures the authorized repository while retaining its whole-run lock.
The current raw snapshot must match each selected artifact's locally recorded,
home-archived observation. It rechecks unchanged selection and report ownership
before reporting. A changed workspace rejects finish without reporting, closing
the operation or releasing the lock. No selected artifact means ordinary reporting
still works, but no final-artifact evidence is produced.

After an accepted report, the Host durably stores finalArtifact alongside
operationClosed. Assignment stop may carry it as final_artifact:
`{assignment_id,selection,snapshot_hash}`. Hub checks reported original epoch,
exact current stage/attempt/immutable selection, and every declared artifact output
against its source observation and completed archive. Other output types retain
their separate evidence gates. This optional observation is stored in the stop
receipt and survives historical replay; forged/mismatched data rejects before any
stop state mutation.

This is trusted Host evidence of the final controlled source observation, not a
stage-completion decision, independent review, provider reconciliation or protection
against later external non-cooperating edits. The archived selected bytes remain
the immutable handoff source. Stage finalization must still evaluate all required
evidence, current authority, stopping/accounting and delivery constraints.


### Atomic stage verdict and resource release

Owner POST `/api/v1/messaging/work-runs/:id/stages/:stage/complete` accepts
`{request_id,expected_revision,assignment_id}`; revision is the WorkRun revision.
Exact command replay returns its original receipt without touching current holds;
a changed payload under the same key conflicts. New commands require current
frozen Assignment authority, held resources, selected exact outputs and passed
dependencies. The current implementation supports local artifact-only stages with
Read/WorkspaceWrite capabilities and no network or independence requirement. Other
stages explicitly require additional execution proof; this is an implementation
limit, not a restriction on configurable workflow definitions.

Completion revalidates frozen evidence, reported original attempt/epoch, a drained
stop receipt with matching final-artifact selection/hash, complete Hub archives,
resolved tool outcomes, finalized Assignment accounting and no unfinished model
calls. One transaction marks the stage passed and Assignment completed, releases
its resource hold/team slot, advances Run revision and records one immutable
receipt/audit. It does not debit again or release any successor's hold on replay.

The Run remains incomplete: completion_authorized=false. Its waiting reason becomes
stage_dispatch_pending or delivery_finalization_pending according to the configured
completion stages. Preparing a successor is possible; automatic execution, derived
workspace authorization, independent review, trusted verification and delivery
finalization remain separate pending work.


### Frozen Assignment input manifest

Preparation now stores `assignment.inputs` with a SHA-256 hash of its serialized
binding and execution_authorized=false. The binding pins format
`kode.assignment.inputs.v1`, Run identity/revision, stage, context/authorization
hashes, declared external inputs and transitive prerequisite sources. Every
producer must be passed with a completed Assignment matching the Run, attempt and
frozen context. Selected outputs are revalidated against frozen evidence rules.
Artifact outputs additionally require completed Hub archives and pin evidence
sequence, repository binding, snapshot hash, archive hash and byte count.

The same preparation transaction stores this manifest with the Assignment and
outbox; exact retry returns the original manifest. Neither caller-selected paths
nor caller-supplied source hashes are accepted. The manifest identifies source
material only: it does not grant access to a derived directory or remove the
existing downstream admission gate. Host materialization and independent-context
proof must still be bound to this manifest before downstream execution.


### Assignment-bound Host materialization

OfficialExecution.prepareAssignmentInput accepts only assignment_id, source_stage
and output. It fetches the prepared Assignment from its Hub, requires this Host's
worker identity and matching manifest Run/stage/context/authority identities, then
resolves the exact artifact from the frozen sources. The caller cannot supply a
path, evidence sequence or hash. Complete archive metadata must match all pinned
identities before restoration; the restored receipt must retain that archive hash.

The private cache request identity derives from Assignment ID, input hash and
source/output. Repeated preparation revalidates immutable bytes using the existing
materializer. A second Hub read must equal the original Assignment before returning
a receipt; cancellation/abandonment or concurrent revision changes reject, leaving
only an unprivileged cache tree. The returned receipt carries Assignment revision,
input hash, producer/output identity and workspace, with execution_authorized=false.
This does not create a derived workspace grant, satisfy independent-context proof
or permit downstream model/tool execution. Historical receipts alone are not live
execution authority.


### Home receipt of Assignment input materialization

Owner POST `/api/v1/messaging/work-assignments/:id/workspace-receipt` accepts
request_id, expected_revision (Assignment), input_hash, source_stage, output,
sequence, snapshot_hash, archive_hash and absolute normalized root. New receipts
require current frozen authorization, this Hub's local Worker, blocked/prepared
Assignment and unstarted operation with no creation/admission. Input and completed
archive identities must match the stored manifest exactly. Root must be separate
from (neither ancestor nor descendant of) the original project root.

One transaction stores immutable input_workspace request/receipt, increments the
Assignment revision and appends assignment_input_materialized. Exact retries return
the original receipt even after abandonment/revocation/restart; changed requests
conflict. It does not change operation grant, dispatch command, Run revision or
resource holds. execution_authorized remains false: the owner Host attests actual
bytes, while the Hub validates recorded identity and current authority, not physical
filesystem isolation.

OfficialExecution.bindAssignmentInput performs Assignment-bound restore/revalidation
then submits the corresponding receipt. It checks Assignment revision before submit
and validates returned identity. Repeat calls use the original receipt revision;
actual execution still requires derived-scope admission and independent-context
evidence, neither implied by this historical receipt.


### Derived read-only Assignment scope

Owner POST `/api/v1/messaging/work-assignments/:id/workspace-scope` accepts
request_id and expected_revision (Assignment). Requires the recorded materialization
receipt, current original team/grant authority, local prepared/blocked operation
and no existing resources/creation/admission. Currently supports offline read-only
capabilities and one unambiguous repository snapshot; distinct required snapshots
need an explicit multi-source mapping and are rejected. Role names are not used.

The transaction stores execution_workspace request/receipt, increments Assignment
revision, changes dispatch/outbox cwd to the snapshot root and audits once. The
derived scope preserves original tools, capabilities, network and budget IDs; only
target root/workspace identity change. authority_scope records the unchanged
original project scope. Operation grant binding remains immutable and live grant
checks continue against that original authority. Exact command retry is historical.

Operation grant context includes execution_workspace (null for ordinary operations).
Resource reservation uses its snapshot target, while ordinary Assignments retain
the original target. scope_authorized=true is distinct from execution_authorized=false:
the existing downstream/independence admission gate is not removed by this endpoint.

Official grant guard requires a trusted derived-workspace validator, checks scope
is identical to original authority except target, and freezes both contexts. The
OfficialExecution validator binds the Assignment and revalidates its materialized
bytes/hash on checks. No normal registry row can substitute for this evidence.
Cwd must remain inside the snapshot; modified bytes or changed scope reject. This
is cooperative Host/tool enforcement, not an OS sandbox or independent-review
verdict. Revalidation currently downloads/verifies archives and needs later tuning.


### Fresh-context downstream admission and mandate

For a derived snapshot Assignment the trusted OfficialLoopHost passes whether it
actually used createAgent without seed, parentAgent or inheritedEventCount. Before
Hub admission, Host requires matching unseeded session identity, zero session events
and successful durable session flush, rechecking emptiness after flush, lock
acquisition and the admission reply. Resume and populated contexts cannot assert
this evidence. Ordinary first-stage admission retains its existing contract.

The owner admit request may carry context with kind official_fresh_empty, session_id,
event_count=0, input_hash and snapshot_hash. Downstream/independent stages require
it to match authorized derived scope and frozen inputs. Every independent_from
producer must appear in the frozen sources with a different Worker session and
operation identity. This replaces the previous blanket downstream rejection;
current authority, resource locks and tool/model checks still apply. The proof is
a trusted Host observation, not an Agent-provided judgment or an OS sandbox.

Mandates bind prerequisite sources, the full input manifest and derived workspace
receipt. Effective repository.workspace and grant_scope point to the snapshot;
source_repository and authority_scope preserve original provenance. Independent
mandates require the admitted context proof. Model input remains bound to the
exact durable mandate. An independent session consuming the snapshot is execution
evidence, not a passed review verdict: selected review/verification evidence and
stage completion still require their own checks.


### Final derived input and review-stage verdict

Controlled finish of a derived Assignment revalidates its input snapshot while
holding the assigned root lock, checks immutable source/hash and unchanged stage
selection, reports, then persists finalInput alongside operationClosed. Stop may
carry final_input `{assignment_id,input_hash,snapshot_hash,source_sequence,selection}`.
Hub requires reported original epoch, matching derived scope, admitted fresh
context, materialization receipt, complete source archive and exact current stage
selection. Mismatches reject before any stop mutation. A null selection can record
input preservation but cannot pass a stage requiring selected outputs.

Stage complete additionally supports offline read-only derived stages whose exact
declared outputs all use Review evidence rules. It revalidates final_input against
the frozen stage and admission, requires each review to reference that final source
sequence/hash, and runs existing frozen rules: passed verdict, no blocking findings,
matching producer/operation and source snapshot. Reported/drained/accounting/current
authority/tool-resolution checks remain mandatory. The same atomic verdict releases
Assignment resources and advances Run revision. Failed or inconclusive reviews do
not pass; rework routing remains separate pending implementation.

This is evidence-backed workflow acceptance, not a guarantee of model review quality.
Configured completion endpoints may now become delivery_finalization_pending, but
WorkRun completion_authorized remains false until delivery finalization is proven.
Verification commands and mixed/external proof kinds still need their own gates.


### Trusted local verification runner foundation

OfficialExecution owns VerificationRunners in its private verification-runs store.
Trusted registration pins runner/command/revision, canonical absolute executable
plus SHA-256, fixed argv, explicit environment, timeout, output bound and scenario
identities. It returns definition/environment hashes for project command bindings.
The same revision cannot change. No shell is invoked and Host environment variables
are not inherited. Executable contents are rehashed before spawn.

Execution pins request identity, operation attempt/epoch, command reference, canonical
cwd, source sequence and snapshot hash. Before launch it durably records intent and
requires a trusted authorize callback. An exclusive request directory prevents
concurrent replacement. Finished identical retries return the exact stored result;
unresolved intent never automatically relaunches. Bounded stdout/stderr bytes, real
exit code/signal, reason, signal failures and hashes are stored privately with the
result. Corrupt receipts and changed request identities reject.

The process adapter signals its owned process group on cancellation/timeout/output
limit and escalates; an unconfirmed drain is never a pass. It does not attest all
escaped descendants or provide filesystem/network sandboxing. Successful exit is
only a local command observation, not a stage verdict or scenario-coverage proof.
A historical receipt does not renew execution authority. Registering a definition
conveys no workflow permission.

Assignment-bound command/environment/scenario preflight, trusted tool installation,
Hub log archive/observation ingestion and verification-stage finalization are still
required. No Worker-facing arbitrary command tool is exposed by this foundation.


### Assignment-bound verification execution

Controlled OfficialExecution handles expose verify({request_id,output}) to trusted
Host orchestration. No executable, argv, environment or scenario override is accepted.
The requested output must be a frozen Verification rule on the current unselected
stage. It resolves the command/environment/repository and exact input snapshot from
the frozen Run and Assignment, requiring the held derived root and matching worker/
operation identity. The environment adapter is currently local_process_v1.

Trusted runner definitions now also pin tool_id, declared capabilities and network
use. The tool must be in the stage/derived grant, capabilities/network must fit it,
and definition/environment hashes plus full configured scenario IDs must match.
Required workflow scenarios must be included. These are configured command coverage
declarations, not inferred test coverage from arbitrary stdout.

The official tool journal records intent before execution. Runner launch rechecks
current ownership/grant and the immutable binary; execution completes under the
whole-Assignment lock, then rechecks ownership and snapshot integrity. Unconfirmed
stop or signal failure becomes uncertain tool evidence. Actual exit status produces
a verification observation with exact source, command revision, environment hash,
scenario IDs and local log reference. Same tool-call identity cannot rerun; normal
ledger/outbox reconciliation preserves observations without repeating commands.

The result reports log_archive_status=local_only and completion_authorized=false.
Hub log transport and binding real command records to selected evidence remain
required before verification-stage completion is enabled. This path does not install
a Worker-facing arbitrary command tool or change original team authority.


### Home verification record archive and stage finalization

Owner GET/POST `/api/v1/messaging/verification-records/:sequence` stores the exact
serialized runner result for an existing Verification observation. POST accepts
result_json (max 3 MiB); only this route has a 4 MiB request limit. Logs allow at
most 4096 stdout/stderr chunks and 1 MiB decoded bytes. Stream labels, canonical
base64, byte count and SHA-256 are validated against the result, then command,
environment, scenario, source, operation and worker identities are checked against
the original event and frozen Assignment/Run. Outcome flags must agree with actual
exit/signal/reason and observed process-group emptiness.

Exact bytes are immutable with a record hash, one archive audit and historical
idempotent retry. Conflicting content rejects. The private Host archive uses bounded
immutable files, while profile outbox retains only identity/hash/ack metadata.
Recovery resends the same record after evidence delivery, never runs the command.
Controlled finish requires home acknowledgement. Remote archive relay remains
unsupported and cannot falsely acknowledge delivery.

Verification stage completion now requires this home record in addition to frozen
passed evidence, final input snapshot, fresh context, reported/drained execution,
current authority and settled accounting. It also requires matching returned
trusted-tool evidence for the exact command call/attempt/epoch/tool. Read-only
derived Review/Verification outputs can release resources atomically; overall
WorkRun delivery finalization remains separate.

Process-group emptiness is a concrete local observation, not proof that no process
ever escaped the group, nor filesystem/network isolation. The runner records that
limit explicitly. Command definitions and Host observations remain trusted inputs;
this archive is not an independent attestation of program correctness.

### Frozen WorkRun delivery finalization

Owner-only `POST /api/v1/messaging/work-runs/:id/delivery` accepts only
`{request_id,expected_revision}`. It never accepts replacement targets, evidence
sequences or Agent-provided completion flags. Exact command retries return the
original receipt, including after revocation or restart; changed requests conflict.

The home Hub checks the current frozen activation/grant authority, configured
completion stages and their dependencies, exact selected evidence and completed
Assignments, archived verification records, finalized accounting, and absence of
active Assignments/resource holds. Required outputs must come from passed stages.
Each local repository target requires an archived artifact from a passed stage
for that repository; required outputs may name downstream verification instead. Its receipt denotes the immutable Hub archive, not a claim that a
mutable original checkout still contains those bytes. Review and verification are
required when the activated workflow requires them; no stage names are hardcoded.

Local targets currently finalize atomically with WorkRun state `completed`,
`completion_authorized=true`, incremented revision, durable receipt and one
`work_run_delivered` event. The receipt includes frozen policy/context, selected
output sequences and archived artifact hashes. Change-request, merged, deployed
and custom targets explicitly reject until adapter evidence support is implemented;
passing local stages cannot substitute for an external endpoint. This endpoint
records delivery eligibility and local archive availability; future IM notification
outbox is separate and not yet implemented.

### Home policy-selected Assignment preparation

Owner-only `POST /api/v1/messaging/work-runs/:id/schedule` accepts
`{request_id,expected_revision}`. The request cannot override stage, target, role,
model, tools or grant scope. The home Hub examines stages in frozen workflow order,
excludes unmet dependencies, assigned stages, unavailable authority and candidates
without current capability/quota recommendations or a known execution Host. Within
the first eligible stage it orders targets by configured preference, descending
weighted capability score, then stable target/worker identity.

Selection, budget reservation, Assignment creation and dispatch outbox insertion
share one transaction with the existing explicit preparation path. Trusted executor
admission, tool installation, workspace locks and account slots remain required
before execution. Preparation does not claim that a Worker has started. Final
admission failure rolls back the command; it does not silently choose a different
policy or remove a workflow stage. The endpoint currently returns an error when no
candidate can be scheduled; callers can inspect stage plans for detailed reasons.

The successful command and its original result are durable. Concurrent calls with
the same request key and body, lost replies, revocation and restart replay exactly
the original receipt. A changed body under that key conflicts; new commands require
the current Run revision. Assignments record `scheduling.source=home_policy`, the
strategy and recommendation; the audit actor is the scheduler on the home Hub.
Manual stage/target preparation remains available for diagnostics. This endpoint
is one policy-selected preparation step, not a background execution/verification
loop; automatic Host progression and rejection/rework are separate work.

### Host downstream workspace preparation

Before a fresh downstream Worker creation, AssignmentDispatchHost resolves artifact
inputs from the frozen WorkRun/Assignment. Review and verification artifact_output
bindings select the source; it does not choose an arbitrary caller cwd. The current
adapter supports a read-only, offline snapshot. Distinct required snapshots or
repositories, or multiple referenced artifact sequences that need separate inputs,
require explicit multi-source support and are rejected before Worker creation.

The Host restores and rechecks archive bytes through bindAssignmentInput, publishes
the existing workspace receipt, obtains the existing derived scope from the home
Hub, and rereads the resulting dispatch command before resource reservation and
creation. Already committed input/scope request identities are reused on retries.
A lost scope response leaves no newly created Worker or account-slot hold; the next
attempt verifies local bytes again and replays the same receipt. Modified snapshot
bytes are rejected even if a prior authorization receipt exists. Existing durable
Worker-creation reconciliation remains ahead of this preparation path; it does not
silently restart a historical Worker. Current grant/fresh-context/tool/lock checks
still apply at admission. Writable and multi-source downstream adapters remain
unsupported, and this preparation does not itself collect results or run a full
background workflow loop.

### Controlled Host WorkRun progression

`WorkRunController` is a Host API over the existing owner endpoints. Its trusted
`prepare` adapter supplies executor/tool setup; its `outputs` adapter reads durable
output-name-to-evidence-sequence mappings and must not launch tools or inference.
`advance(run_id)` coalesces concurrent calls for that Run. A bounded step schedules
an unassigned stage, starts an admitted local Assignment, waits for mandate
consumption/idle execution/exact outputs, or selects evidence and proceeds through
controlled finish, durable stop, accounting and stage completion. Once configured
completion stages pass, it requests frozen delivery finalization. Remote Assignments
are reported as waiting_remote_host rather than locally impersonated.

The controller derives progress from Hub state and Host ownership records. It skips
already selected outputs, reported/closed execution, acknowledged stops and settled
accounting. It does not resume an unknown Worker or rerun a verification command to
recover a lost response. A reconstructed controller can continue after committed
selection response loss using the existing owned Worker. This is not proof of
recovery after loss of the underlying Host process or execution handle.

`watch` adds bounded polling with one in-flight step per Run and a status callback.
Terminal/recovery states or errors stop the watch; uncertain failures require an
explicit retry. Closing aborts pending Hub calls and prevents new delegated work;
it does not impersonate a Worker cancellation. Known active branches rotate between
steps. Watches are currently explicit Host registrations, not persisted startup
subscriptions. Generic trusted output tools, automatic application-wide attachment,
remote progression and rejection/rework remain separate work.

### Durable Host named outputs

Controlled execution exposes `run.publishOutput({output,evidence_id})`. It requires
current ownership/grant, a matching frozen stage/Assignment/attempt and an observation
in that Worker's own durable artifact outbox. Callers cannot supply a Hub sequence,
producer, operation or completion flag. The observation must have a home receipt;
Artifact outputs additionally require their archive receipt, and Verification outputs
require the matching archived command record and sequence. Output kind must match
the frozen workflow rule. Full source/command/verdict validation remains the Hub's
stage-evidence/completion gate, not the publisher's assertion.

Host profiles persist a compact Assignment-bound ledger with frozen context and
authorization identities, produces list and output-to-evidence/sequence mappings.
Exact publication retries preserve the mapping; replacing a published output needs
a new stage attempt. The default WorkRunController output reader waits for all
produces entries, checks the live Assignment/attempt and rechecks archive acknowledgments,
then submits exact sequences to the Hub. It performs no tools or inference.

This is a local durable Host ledger until the Hub's existing evidence selection
records the mapping. It does not claim recovery after loss of that Host storage,
a public Agent tool installation or cross-Hub output relay. Trusted generic Worker
tool exposure and team lifecycle attachment remain to be integrated.

### Trusted Agent verification and publication tools

Controlled OfficialLoopHost installs scoped `kode_verify_output` and
`kode_publish_output` implementations when the frozen tool allow list includes
these names. The ordinary Agent registry and global tools are not replaced. Scoped
visibility, exact implementation policy, current grant, offline read capability
and held workspace checks still govern every call. There is no implicit expansion
of a team's tool list.

`kode_verify_output({output,request_id})` invokes the existing frozen verification
runner and returns only its evidence identity, observed verdict and archival
status, not arbitrary command execution or a large raw log. It retains both the
outer trusted-tool journal and the actual verification-command journal. Publication
uses `{output,evidence_id}` and the existing named-output constraints; neither tool
can pass a stage or complete a WorkRun.

The internal callbacks require the process-local exact Agent/tool/arguments permit
after admission succeeds and while the owning ToolRuntime call remains active.
Direct internal calls, changed arguments and asynchronous callbacks after return
are denied. AgentLoop calls continue through the full ToolRuntime pipeline; the
internal helper avoids opening a nested controlled action while retaining current
ownership checks. These are trusted implementation adapters, not serialized model
permissions. Generic artifact capture/review tools and full autonomous team-run
attachment remain unfinished.

### Frozen artifact and review tools

`kode_capture_output({output,request_id})` resolves the declared Artifact rule and
project repository from the current Assignment/WorkRun, requires the original
held repository root, and invokes existing immutable capture/archive delivery. It
does not accept caller paths/repository IDs or make commits. `kode_review_output`
accepts `{output,request_id,verdict,findings}` and binds the observation to the
referenced ancestor artifact and current held derived snapshot. Findings have exact
id/blocking/evidence_ref fields, unique IDs and bounded cardinality; a passed
verdict with blocking findings is rejected before dispatch. Both return evidence
identities, not stage completion. Review quality is still an Agent judgment; Hub
checks provenance/independence and frozen source identity, not semantic correctness.

Only tool definitions explicitly present in the stage's frozen allowed names are
installed into its scoped runtime. Scoped definitions are not assumed to be hidden
by upstream global-tool masks. Exact execution policy/entry guards remain additional
checks. A local scripted-model acceptance case exercises actual AgentLoop tool-call
responses through verification, reading the tool result, publishing that evidence,
and a final model response; all model steps are metered. This is real local
AgentLoop/Hub/ToolRuntime/process execution with fixture inference, not proof of
paid-model quality or autonomous real-feature implementation.

### Host active WorkRun discovery and durable recovery fences

Owner-only `GET /api/v1/messaging/work-runs/active?after=<run-id>` returns
`{items,next_cursor}`. Items contain only `id,team_id,revision,state,home_hub`;
inputs and frozen context are not included. IDs are ordered lexically with an
exclusive cursor and at most 64 rows per page. Only waiting_resource, queued and
running states are listed; draft/unactivated and terminal Runs are excluded.
Discovery is not execution authorization: every subsequent controller operation
still checks current Hub authority and frozen workflow evidence.

The dsh Host installs WorkRunService when Assignment dispatch and quota Host are
available (explicit `workRunService:false` disables it). It discovers pages on a
bounded timer and limits concurrent controller watches (default 32). Its private
versioned ledger stores Run revision, observed state and recovery fence. Missing
adapters, remote ownership, missing execution ownership and progression failures
unwatch the Run; unchanged revisions stay fenced across Host restarts. Explicit
trusted `retry(id)` or a changed Hub revision permits reconsideration, never
blind Worker recreation. Persistence failure closes watches rather than silently
restarting uncertain work. Host shutdown aborts discovery and waits for pending
controller steps and ledger writes.

The default trusted preparation adapter only accepts installed Assignment tools;
verification additionally requires an already-registered runner with the frozen
hash. It never registers arbitrary commands from model text. Trusted runtime
plugins may supply `prepareWorkRunAssignment`; ordinary sessions do not become
workflow Runs. This service currently progresses home-Host work; automatic remote
execution ownership transfer, generic coding adapters and rejection/rework remain
separate work.

### Assignment source inspection tools

`kode_list_source({path})` and `kode_read_source({path})` are scoped read/offline
workspace-lock tools, installed only when named in the frozen stage allow list.
The runtime resolves the managed Assignment and current attempt, checks worker,
operation, context/authorization hashes and exact held cwd. Callers supply only a
relative path (`.` lists the root), never a workspace root or source identity.
For derived review scopes the existing ownership guard validates the frozen
materialized snapshot before inspection.

Inspection rejects traversal, Git metadata, symlink paths and noncanonical roots.
Reads require regular single-link files, cap bytes at 256 KiB, reject binary or
invalid UTF-8, compare file/path identity and modification metadata before return,
and recheck current authorization. Results include text, byte count and SHA-256.
Directory listings expose bounded entries with kinds, without following symlinks.
Both run through existing actual ToolRuntime entry guards and journals. These are
cooperative workspace tools, not a new OS filesystem sandbox; concurrent hostile
filesystem mutation outside the managed Host is not claimed to be isolated.

### Assignment optimistic source writes

`kode_write_source({path,expected_sha256,content})` is an explicitly installed
read + workspace_write, offline, workspace-lock tool. Runtime requires the
current managed Assignment/attempt/operation and an original repository scope
whose frozen stage grants workspace_write. Derived review/verification scopes
remain read-only. Relative path and source safety checks match inspection;
content is valid UTF-8 without NUL, at most 256 KiB. Parent directories must exist.
No shell, commit, arbitrary root, delete or recursive directory operation is exposed.

An existing target must match expected_sha256; null means create-only. Desired
bytes already present yield state=already_present, an observation, not proof that
an earlier uncertain operation succeeded. Other mismatches leave the file intact.
Replacement writes and fsyncs a private same-directory temporary file, checks
current content again, then atomically renames (existing file) or links without
replacement (new file), and fsyncs the parent. Existing ordinary permission bits
are preserved; newly created files are private. Returned metadata identifies
previous/new hash and byte count. Tool-call journals remain the execution audit;
artifact capture archives final code bytes separately.

Post-write cancellation/authority loss reports failure without reverting bytes.
An uncertain tool journal still requires existing reconciliation and cannot be
cleared merely by a subsequent already_present result. Process death before
cleanup may leave a private .kode-write-* temporary file; it must be investigated
with the uncertain operation before resuming completion. This implementation
relies on the cooperative workspace lease, not an OS CAS primitive against
hostile external writers. Writable derived/multi-source scopes remain unsupported.

### Failed stage evidence and bounded rework

For a stage with a frozen on_reject rule, evidence selection may accept an exact
set of source-bound review/verification observations containing at least one
explicit failed verdict. Such selection carries outcome=rejected. Inconclusive
observations, stale/cross-attempt evidence, mismatched artifacts/commands and
non-independent reviews remain rejected. Public preflight and delivery checks
still require passed evidence; failure selection cannot authorize completion.

The existing stage complete command finalizes either outcome after the same
reported-operation, stopped-execution/final-input, trusted verification archive,
resolved tool journal and exact accounting checks. Rejected completion returns
stage_passed=false, stage_rejected=true and a rework receipt. In the same Hub
transaction it releases the Assignment's holds, records stage_rejected and saves
the exact command result for retries, including historical replay after restart.

Rework uses only the frozen target/max_reworks. It snapshots the target and all
transitive dependents into Run.reworks, retains their prior attempts/evidence,
and clears current assignment/evidence to pending while retaining attempt
counters. New preparation allocates a new Worker/Assignment and increments the
attempt. Other affected Assignments must already be drained/completed or
abandoned; no active branch is silently invalidated. The target's next immutable
input manifest includes the rework receipt and failed output payloads, covered by
its input hash and full mandate. Old evidence cannot be selected for a new attempt.

At the configured per-rejecting-stage limit, the rejected Assignment is finalized
but Run enters waiting_user/rework_limit_exhausted. The Host service fences this
state rather than restarting or declaring completion. Manual resolution and
coordinated draining of active parallel branches are not yet automated. Failed
verification requires a trusted archived command result with a nonzero exit;
uncertain execution must be reconciled separately.

A completed official model call rechecks reportable authority/identity after its
usage is recorded, rather than requiring a remaining execution hold. This lets a
final call that exactly consumes its reservation finish and report. Each later
model/tool entry still requires fresh execution admission; this does not renew
an exhausted budget or revive an aborted/expired lease. Existing current-grant,
ownership, snapshot and unresolved tool/usage checks remain on finalization.

### Frozen target internal pricing

Scheduling policy targets may include `internal_price_id`, identifying an existing
immutable price version. It is optional and omitted from legacy normalized
policies, preserving their wire/hash identity. Team preflight checks existence,
exact configured target model and budget unit, and requires the budget policy's
settlement=internal_price when a target price is configured. These remain team
internal charges; no supplier invoice or actual balance is inferred.

Stage planning rechecks the price against frozen activated policies and exposes
the resolved price in the candidate. Assignment preparation binds that price to
its new reservation in the same transaction as operation/Assignment/outbox
creation, recording the existing price_bound budget audit and Assignment.pricing
receipt. Scheduling and explicit preparation share this path. Missing/mismatched
price prevents the configured candidate from dispatch; later manual replacement
is rejected by existing immutable reservation pricing. Retries return original
Assignment/price receipts without another reservation or price event.

The optional field retains compatibility with existing trusted manual price
binding. Leaving it absent does not invent a zero price or establish automatic
priced execution; existing admission and settlement gates still apply.

Default Host preparation is shared through work-run-preparation.js. With only
built-in Assignment tools in a frozen stage allow list, it needs no per-Worker
custom setup. Verification may use kode_verify_output as its trusted tool ID;
the runner definition must already exist in the Host registry and match the
frozen hash. Missing runners return waiting_adapter before Worker creation.
Registering the trusted definition does not silently clear a durable fence;
Host service retry(run_id) explicitly reconsiders it. This API is separate from
future Builder configuration and user-facing recovery controls.

Host retry refuses waiting_user and terminal Runs before changing its ledger.
A missing-adapter recovery can retry an active Run; a rework-limit decision must
first change state at the authoritative Hub. Ordinary retry cannot erase the
human-decision fence or revive delivered/cancelled/failed work. Discovery also
continues to exclude these states after Hub/Host reconstruction.


### Native process-group stop observations

Native ACP/Codex process cleanup records `process_group_empty` alongside
`spawned`, `leader_exited`, exit status, signal scope/failures and
`descendants_confirmed`. On POSIX, cleanup signals the owned process group and
then probes that group for at most 250 ms. Only an ESRCH observation establishes
`process_group_empty:true`; a live group, unsupported platform, spawn failure or
permission/check error does not. This observation concerns the original process
group only; `descendants_confirmed` remains false because escaped descendants are
not attested.

For a spawned process with `signal_scope:process_group`, the native runtime keeps
its persisted admission fence unless both leader exit and explicit group-empty
observations exist, with no signal/check failures. Missing group evidence is
uncertain, including legacy evidence passed to the cleanup boundary. Owner manual
reconciliation remains an explicit attestation, not successful task completion or
automatic proof of descendant termination. This observation does not add a
confirmed-stop state to the session input-cancellation protocol; active cancellation
continues to report `cancel_unconfirmed` until an appropriate verifiable contract
is implemented.


### Remote Assignment context projection

Peers advertise `operation_assignment_context_v1` separately from operation
accounting and other evidence capabilities. The execution Host owner may POST to
`/api/v1/messaging/operation-accounting-relay/:home_node` using the existing
operation/worker envelope and
`accounting:{attempt,action:{kind:"assignment_context",assignment_id}}`.
Session credentials cannot use this owner collector route. Both outgoing and
incoming links require the new capability; older peers receive no unsupported
request frame.

The home Hub first authenticates the execution peer against the operation's
assigned Worker. It then requires the Assignment's operation ID, frozen dispatch
attempt and Worker identity to match that operation and the requested current
attempt. Cross-operation/Worker/attempt reads reject. The result is the current
home Assignment record, bounded to 64 KiB before relay; larger contexts fail
explicitly. There is no local replica, creation, lease claim, reservation change,
resource acquisition or workflow transition. Reads may be retried after reconnect.
This is a prerequisite for remote Assignment execution, not an implementation of
remote creation, admission, stop or full workflow progression.


### Remote Assignment creation receipts

`operation_assignment_creation_v1` is a separate write capability and also requires
`operation_assignment_context_v1` plus operation/accounting relay support. An
execution Host owner can submit the existing envelope with
`accounting:{attempt,action:{kind:"assignment_creation",assignment_id,receipt}}`.
Receipt has the existing `{request_id,command,state}` shape, where state is
`uncertain` or `created`. Incoming and outgoing links check the write capability;
context-read support alone does not authorize this mutation.

The same home Assignment/operation/current-attempt/Worker checks apply before the
creation transaction. The transaction rechecks the actual execution Host against
the Assignment before replaying historical results. Exact request identity and
frozen command are retained; repeated identical requests return the saved receipt,
and conflicting content rejects. The local owner route remains local-only, so it
cannot impersonate a remote execution Host. Audit actor identifies the authenticated
execution Host, not home. A created receipt still requires prepared Assignment,
Host admission and evidence that the frozen operation was claimed; uncertain is
not success, does not release budget and cannot authorize workflow completion.
Result, Assignment update, dispatch state and audit are atomic. Remote admission
and actual Worker lifecycle integration remain separate pending work.


### Remote Assignment Host admission

`operation_assignment_admission_v1` independently negotiates execution Host
admission, also requiring Assignment context and operation/accounting support.
The owner accounting relay accepts
`accounting:{attempt,action:{kind:"assignment_admission",assignment_id,admission}}`,
where admission retains the strict local Admit schema. Session credentials cannot
submit Host attestations. Home authenticates execution peer/Worker/operation/current
attempt, then the admission transaction checks executor and Worker before historical
replay. Local owner admission cannot impersonate a remote executor.

The shared transaction retains frozen executor configuration/tool/root checks,
current grant and budget/resource checks, held account/workspace resources,
prepared-operation identity and derived fresh-context/independence checks. Home
resource reservation remains a separate owner action; this remote action cannot
increase capacity, change configuration or manufacture holds. The resulting
admission kind is `official_remote_host` and audit actor is the execution node;
`inference_verified` remains false. Once admitted, the existing operation relay
can claim the frozen operation, allowing a matching remote created receipt to pass
its original admission/claim gates. Exact admission retries replay the durable
receipt; changed content rejects. These APIs do not themselves create a Worker or
attest an actual physical lock: production Host lifecycle integration must perform
its concrete checks before submitting them.


### Execution Host Assignment routing

The dsh trusted Host helper `assignmentHomeCall` derives the home from the managed
operation's home_node (or the known local Host for local bindings). It accepts only
context, admission and creation actions and validates explicit Host/Worker/operation/
attempt/Assignment identities. Local operations retain existing REST paths; remote
operations use only the owner operation-accounting relay. An unavailable home never
falls back to a local Assignment or silently creates a replica. Context responses
must match the exact Assignment, execution Host, Worker, operation and attempt.

Official execution admission now uses this helper before acquiring its existing
workspace lock and when submitting its admission. All original configuration,
canonical-grant/fresh-context and receipt checks remain. Success retains the lock
for execution; failed/mismatched remote replies release the newly acquired lock.
Assignment inbox mandate validation and projected model-input validation also read
Assignment context through this home route. These changes do not yet connect the
remote dispatcher, missing run/output/archive routes or complete remote execution.


### Frozen remote creation scope in dsh dispatch

New remote-target Assignment creation commands include `operation.home_node`,
frozen from the Run's home Hub. Local command shape remains unchanged. Official
creation normalization/fingerprints preserve this optional validated field, and
binding/admission comparisons include it; a changed home is a different command,
not a reconnect or retry. Existing remote commands without this field require
explicit reconciliation and are not silently rewritten.

Trusted `AssignmentDispatchHost.dispatch(id,{homeScope,setup})` accepts an explicit
remote scope `{worker_session,operation:{id,attempt,epoch,home_node}}`. It fetches
through the home relay, checks that the frozen operation equals this scope and the
Worker belongs to the execution Host, then uses the existing durable official
creation ledger. Concurrent same-ID calls with different scopes reject. Existing
ledger operation scope must also match before receipt replay. Result acknowledgments
route back to home through assignment_creation.

Remote root-stage creation requires existing home-owned resource holds and the
matching installed official profile; the dispatcher does not reserve home resources
through its local API. Derived remote workspaces remain unsupported pending their
materialization adapter. Remote `start` (creation plus mandate) rejects before
creating anything until mandate delivery is connected. This dispatch primitive
does not imply remote discovery, automatic workflow progression or resume of an
uncertain creation; durable reconciliation remains required.

### Home-owned remote mandate enqueue

The owner-only Assignment mandate endpoint can now target an already-created
remote Worker registered in the directory of a configured peer. The API derives
this directory scope; callers cannot supply authorized remote addresses. Local
Workers retain the transactional local registration check. Existing frozen-input,
active-lease, live authority/resource and creation gates remain mandatory. Remote
messages enter the existing durable outbox as queued; local messages remain received.
The mandate, Assignment revision and audit event commit together. Exact retries
return the original receipt without enqueueing another input; conflicting requests
reject. Execution validates the immutable mandate against home context, and
consumption receipts return through the existing message protocol.

This endpoint is called on home by its owner. It is not a new remote mutation
relay and does not enable remote dispatcher `start`, automatic home progression,
derived workspace transfer or stop/output settlement. The dual-Hub official-loop
fixture verifies actual persisted input consumption and internal-price accounting
with a controlled model adapter; it does not verify paid inference or SSH deployment.

### Authenticated remote Assignment drain receipts

`assignment_stop` accounting relay requires independent
`operation_assignment_stop_v1` negotiation as well as Assignment context and
operation/accounting support. Old peers receive no unsupported stop action.
The authenticated execution peer, exact Worker, operation and current attempt
are checked before home accepts the receipt. The stop transaction checks executor
identity before historical replay; the home local endpoint cannot impersonate
remote execution. Remote receipts use `official_remote_drained`; existing local
receipts retain `official_local_drained`. Frozen command, claimed attempt, final
input/artifact validation and atomic operation fencing, audit and retry rules remain.

Trusted `AssignmentDispatchHost.stop(id,{homeScope})` reads authoritative home
context, checks the exact frozen home operation and local managed binding, drains
actual owned execution, then persists closure before relaying the receipt. Same-ID
pending stops with different home scopes reject. Missing execution ownership cannot
be invented from a profile. A durably drained request can retry after lost response
without running or disposing another Worker. This proves only owned official-loop
drainage: external effects remain not_attested, resources are not released and
accounting remains pending. Stop is not workflow completion or successful output
publication. Remote creation/start discovery and output transfer remain separate work.

### Assignment-bound remote WorkRun context

`assignment_run_context` is an owner accounting action protected by independent
`operation_assignment_run_context_v1` negotiation and existing Assignment context
capability. Callers supply Assignment ID, not a free WorkRun ID. Home authenticates
the execution peer, exact Worker/operation/current attempt, derives the WorkRun
from that Assignment, checks frozen context/authorization hashes and returns a
bounded read-only WorkRun (64 KiB maximum). Oversized responses fail explicitly;
no truncation or execution-Hub fallback. The response is a current read, not a
write grant or durable replica. Stage state and evidence can advance between reads;
consumers retain their identity/version/selection checks.

Production dsh source read/write resolution, evidence capture/review, named output
publication, verification and final input/artifact checks use home-aware Assignment
and WorkRun readers. Remote WorkRun responses are checked against the bound run ID
and both hashes. Local readers preserve existing routes. This enables remote root
source inspection and artifact metadata observation. Remote artifact bytes use the
negotiated archive transfer below; derived-workspace transfer remains pending.

Artifact acceptance and stage evidence selection choose consumption evidence by the
Assignment execution Host: local runtime deliveries for local Workers, authenticated
persisted delivery mirrors for remote Workers. Both require consumed phase, an event
sequence and exact message/Worker binding with home as source. A local runtime row
cannot substitute for a remote receipt. An accepted remote receipt is still only
input-consumption evidence, not a passed stage or an archived artifact.

### Remote artifact archive segments

`operation_artifact_archive_v1` independently negotiates `artifact_archive_segment`
and `artifact_archive_complete`, in addition to operation/accounting/artifact
capabilities. Session credentials cannot use the owner relay. Execution peer and
Worker authentication applies before dispatch; the archive source must be that
operation's current attempt and exact producer. Uploads can finish after execution
stops, but cannot move another operation's evidence or authorize execution.

Segments carry sequence, storage-chunk index, aligned byte offset and
`{archive_hash,bytes,data}`. Wire payloads are at most 32 KiB decoded, canonical
base64, with exact expected segment length. Storage chunks remain 256 KiB and
archive bounds remain 192 MiB for compatibility. Segments must append contiguously
within a chunk; exact duplicate bytes replay, conflicts/gaps reject. Archive identity
is fixed on first upload. Partial chunks persist transactionally in the existing
chunk table; partial archives remain unreadable and cannot pass completion.
Segment receipts describe immutable segment identity, not a mutable progress offset.

Completion validates all storage chunks, full archive hash and snapshot/content
manifest using the existing archive validator. Only then is complete persisted with
one completion audit. Exact completion replay does not create another audit. Local
upload/download formats remain unchanged. Remote dsh outbox sends bounded segments,
validates each acknowledgement and the final receipt, and records home_archived
only after completion acknowledgement; interrupted transfers resend the same
immutable local archive. No failure falls back to the execution Hub.

Actual paired-Hub tests cover multi-storage-chunk transfer, committed-response loss,
partial-read refusal, gap/content/bounds/identity rejection, session credential denial,
foreign Worker/attempt/operation, home SIGKILL/restart and byte-for-byte download.
The real official-loop fixture also captures actual files and resumes model execution
after home archival with controlled model responses. These are loopback tests, not
SSH/provider acceptance. Remote derived download/materialization and verification-log
archive relay remain separate work.

### Home progression after remote execution drains

The home WorkRun controller continues to wait for a remote execution Host while
its Assignment lacks a home stop receipt. Once that authenticated receipt exists,
the controller uses the same frozen internal-price accounting and stage-completion
endpoints as local execution. It does not create a local substitute Worker or
infer remote execution from Agent text. Lost accounting acknowledgements recover
from the home Assignment ledger on retry.

Successful artifact-stage completion still requires the home-selected archived
output, execution's final matching source snapshot, reported operation, durable
stop receipt and settled accounting. A changed source after publication prevents
final reporting. Passing this stage releases its resource hold; other configured
completion stages remain required. Remote discovery/start and remote report orchestration remain separate integration
work. Output declaration and home selection are described below.

### Remote output declaration and home evidence selection

`assignment_outputs` requires independent `operation_assignment_outputs_v1` plus
Assignment context/operation/accounting negotiation. The authenticated execution
Host declares an exact complete map of frozen output names to home evidence
sequences, bound to the exact dispatch command. Home validates Worker/operation/
current attempt, creation, current authority/resource holds, consumed mandate,
frozen evidence rules and complete artifact archives. Configured rejection evidence
is allowed only under the same workflow rejection policy used by selection.

The declaration and executor-attributed audit persist atomically on the Assignment.
It does not select evidence, change the WorkRun or pass a stage. Exact retries return
the original receipt, including after stop/completion; different request/content
cannot overwrite it. Executor identity and command are checked before replay.
`AssignmentDispatchHost.declareOutputs(id,{homeScope})` reads durable local published
output identities, validates frozen scope and submits through home. An incomplete
local output set returns null; no fabricated or partial declaration is sent.

Home controller watches select a received declaration through the normal owner
stage-evidence endpoint and then wait in `waiting_remote_report`. Selection still
runs all home gates. Remote waiting is an ordinary watched state, not a manual
recovery fence: old service ledgers fenced solely as waiting_remote_host are
eligible for watching again at the same Run revision. Recovery_required,
progression_failed, waiting_adapter and waiting_user retain their existing fences.
Declaration and report progression use the remote lifecycle service below; this
API does not itself start or resume a Worker.

### Execution-Host remote Assignment lifecycle service

The default managed Host starts RemoteAssignmentService alongside home WorkRun
service (the existing workRunService switch applies). It scans existing managed
remote bindings in bounded round-robin batches, coalesces each session's in-flight
step, and never creates/resumes a Worker. It reads home Assignment/Run context,
requires exact frozen operation and current binding, durable local mandate
consumption and an idle actually owned official Worker. It declares complete local
published outputs while waiting for home selection; after selection it runs the
existing final input/artifact/report checks and submits the durable stop receipt.
Home alone selects evidence, settles budgets and completes stages.

Before report execution, the service persists remoteLifecycle identity and
phase=reporting. A crash or report failure with operationClosed still false yields
recovery_required rather than retrying report or recreating execution. After a
persisted successful report, stop acknowledgement may safely retry. A locally
drained record remains eligible for scanning until home confirms its stop receipt;
only then is phase=acknowledged persisted and automatic scanning ends for that
binding. Existing home stop receipt also permits acknowledgement without a live
handle. Missing ownership otherwise requires recovery. Local session bindings and
unmanaged remote sessions are not candidates.

Service shutdown aborts pending reads and awaits in-flight progression before Host
execution disposal. Remote creation/discovery/mandate initiation, derived workspace
transport and verification-log archive remain separate incomplete work. Actual
fixture model/tool execution tests automatic final-report/drain with a lost stop
reply, and real profile reopen tests ambiguous report fencing; they do not prove
provider execution or SSH deployment.

### Execution-Host remote pending Assignment catalog

Owner GET `/api/v1/messaging/assignment-dispatches/remote/:node?after=...` reads a
paired home Hub through the existing authenticated Host catalog request channel.
It requires distinct `assignment_catalog_v1` negotiation. The catalog command is
read-only and v2-only: outgoing requests are rejected before sending to an older
peer, incoming requests without negotiation reject, and v1 encoding explicitly
refuses this command. Other workspace/catalog commands keep their wire shape.

The home derives execution_host from the authenticated peer, never a caller-supplied
host selector. It lists only that Host's prepared, resource-held Assignments whose
creation outbox is blocked/ready/uncertain. Responses contain home_hub,
execution_host, at most 64 sorted identity hints (`assignment_id`, `worker_session`,
frozen `operation`), and a bounded cursor; no full Assignment or workspace content.
Response size is capped at 64 KiB. Unknown query fields, local-node requests and
session credentials reject. Local execution of the remote catalog command rejects
before reading or mutating workspace configuration.

`AssignmentDispatchHost.discoverRemote(home,{after})` validates response home/Host,
ordered unique IDs, cursor, Worker and frozen operation home/attempt/epoch before
returning hints. Callers then use the existing scoped home Assignment read and
creation/admission gates. A hint is not authorization to bypass live admission,
resume uncertain execution or reserve resources locally. Unheld tasks are absent;
acknowledged created tasks leave this creation catalog and remain covered by their
existing managed lifecycle bindings. Legacy frozen remote commands lacking home
identity require reconciliation, never silent rewriting.

Actual two-Hub official-loop tests discover the held task through this API and use
its scope for real creation, then verify it disappears after acknowledgement.
This discovery primitive is not yet an automatic remote creation scanner or home
resource/mandate controller; those remain to be wired.

### Home controller remote initiation

The trusted home WorkRun controller acquires an absent remote Assignment resource hold through the existing owner resources API. It waits for the authenticated creation receipt and propagation of the exact remote Worker address into the configured peer directory before submitting the immutable mandate through the existing owner API. Uncertain creation or non-held resources requires recovery. A committed mandate survives lost responses: subsequent progression reads the durable mandate and does not enqueue another input. Remote preparation and execution remain owned by the execution Host; the home controller never invokes its local execution adapter for this path. Authorization, revision, capacity, grant and consumption checks remain enforced by the existing Hub endpoints.

### Execution-Host automatic Assignment discovery

The managed dsh Host starts RemoteAssignmentDiscovery alongside its existing lifecycle service. It reads the owner-only paired-host directory, validates the local identity and distinct remote IDs, and rotates one home per scan. Each scan processes at most the configured batch (default four) from a bounded catalog page; cursors advance only over processed items and reset at the end so adapter failures do not starve later tasks. Removing a peer removes its cursor. Neither directory entries nor hints authorize creation: the Host rereads authenticated Assignment context, verifies the frozen operation, runs trusted preparation against the home WorkRun, then uses the existing dispatcher/admission/creation ledger. Replays never bypass that ledger. Discovery only creates; home controls mandate delivery, and the existing remote lifecycle service controls reporting/drain. Closing waits for in-flight discovery and prevents dispatch after pending preparation completes. Service state notifications omit raw exception text.

### Remote verification record archive

Remote accounting adds `verification_segment {sequence, segment:{record_hash,bytes,offset,data}}` and `verification_complete {sequence,record_hash}`, gated separately by `operation_verification_archive_v1` in both receive and pre-send paths, plus existing operation/accounting/artifact negotiation. The authenticated operation/Worker envelope remains authoritative. The referenced sequence must be that operation attempt's verification observation, produced by the Assignment Worker.

Segments are canonical base64, at most 32 KiB decoded, aligned to 32 KiB except the final length; total bytes are bounded to 3 MiB. Home durably stages one immutable hash/length identity per sequence. Gaps and conflicting replays reject. Exact segment retries return an immutable bounded acknowledgement. Completion verifies full length, SHA-256 and UTF-8, then invokes the unchanged verification record validator (frozen command/environment/input snapshot, observed output and outcome). Only that validation can produce the authoritative archive and audit. The final relay receipt contains sequence/hash/archived with completion_authorized=false, never the multi-megabyte record. Local owner upload/download remain unchanged. Staging is retained for exact replay; it is not accepted as an archived record by stage evidence checks.

The dsh durable VerificationArchive uploads remote records through this segmented relay after metadata reconciliation; failures remain pending and replay does not rerun the command. Full remote verification acceptance still depends on derived workspace materialization and is not established by transport contract tests alone.

### Consumer-scoped remote artifact download

`assignment_archive_read {assignment_id,sequence,offset}` is gated by `operation_assignment_archive_v1` plus existing authenticated Assignment/operation capability checks. Home resolves the consumer Assignment and checks its Worker/current operation attempt, prepared state, and exact frozen input reference. Arbitrary archive sequence access is rejected. Metadata (`offset:null`) and 32 KiB aligned byte segments are read only from complete archives whose snapshot/hash/size match the frozen input. Segment responses include sequence, offset and archive hash; no execution permission is granted.

The dsh archive reader optionally routes through this consumer scope and validates each segment, full transport hash, bundle manifest and snapshot. ArtifactMaterializer persists the remote scope in its immutable request and separates its cache key by scope; it restores and verifies read-only files under owned storage. Local 256 KiB owner reads and existing local cache identity remain unchanged. Download/materialization alone does not bind an execution workspace; home workspace receipt and scope authorization are separate gates, with remote integration still pending.

### Remote derived workspace preparation and home authorization order

`assignment_workspace_receipt {assignment_id,receipt}` uses independently negotiated `operation_assignment_workspace_v1`, the authenticated execution peer and current Assignment operation/Worker scope. The store checks executor identity before historical replay, retains live frozen authority/input/archive validation, and records `official_remote_materialized` plus executor-attributed audit. Existing local owner receipt calls remain local; they cannot impersonate a remote materializer or replay its receipt. A materialization receipt grants no execution authority.

Scope authorization stays an owner operation on home. It validates the materialization Host against the Assignment Worker, restricts the derived scope to the frozen read-only/offline project authority and exact source snapshot, and requires no prior holds/admission/creation. It does not add network/tools/capabilities.

To avoid deadlock, the remote catalog additionally exposes prepared derived Assignments without resources or creation. The home controller waits for their materialization receipt, authorizes the derived scope, then reserves resources. The execution dispatcher downloads/materializes, submits the receipt and returns waiting_home_resources until home holds exist; only then does it use the existing admission/creation path. Root Assignments retain their held-only discovery gate. No remote endpoint allows the Worker to authorize scope or reserve resources. Exact retries use frozen materialization and scope identities.

### Revalidating derived inputs without repeated archive transfer

Artifact materialization keeps a private content-addressed archive cache under its owned storage. Every preparation still reads authoritative home metadata and checks the frozen snapshot/archive hash/size, validates cached bundle contents against those identities, and verifies the actual read-only source tree. Only a missing cache entry is downloaded; corrupt existing cache fails instead of being silently replaced. The storage root is checked before cache writes. This removes repeated remote byte transfer from grant and final-input checks without relaxing those checks.

### WorkRun cancellation intent (increment 219)

Owner-only `POST /api/v1/messaging/work-runs/:id` additionally accepts
`{action:"request_cancel",request_id,expected_revision,reason}`. CAS and immutable
request replay share the existing command ledger. One transaction records the
Run as `cancelling` and fences every non-abandoned/non-completed Assignment's
current operation: prepared becomes stopped; active/uncertain becomes cancelling;
changed operations increment revision/epoch and clear leases. Reported/stopped/
already-cancelling operations retain their identity. Any inconsistent operation
attempt or Worker aborts the entire transaction. The cancellation audit records
the owner, reason and Assignment IDs. Scheduling, resource admission and managed
execution remain subject to existing Run/operation gates.

The receipt explicitly has `stop_confirmed:false`, `resources_released:false` and
`accounting:"pending"`. No budget or resource hold is released by the request, and
no delivery is authorized. Existing `cancel` (never dispatched) and
`cancel_settled` retain their contracts. Host normal progression returns
`waiting_cancellation` for cancelling/cancel_unconfirmed rather than selecting
evidence or delivering. Automatic execution drain, cancellation settlement and
restart discovery of cancelling Runs are still pending implementation; this
entry is not a complete running-WorkRun cancellation acceptance claim.

Cancellation drain routing (increment 220): the owner active-Run catalog also
includes cancelling/cancel_unconfirmed. Home progression may drain only owned
local official execution; remote execution Host reads authenticated Run context
before waiting for idle and routes its existing durable stop receipt to home.
Unknown ownership stays cancel_unconfirmed. A received drain receipt still does
not finalize the Run, settle unknown costs or release resource holds. Automatic
never-created disposition and final cancellation settlement remain pending.

### Final cancellation receipt (increment 221)

Owner command `{action:"finalize_cancel",request_id,expected_revision}` accepts
only cancelling/cancel_unconfirmed Runs with durable cancellation intent. It
validates every Assignment before committing a single transaction. Admitted
execution requires exact current-attempt/epoch stop receipt, stopped/reported
operation, exact finalized budget reservation/accounting and no unfinished
official calls. Never-admitted work must have no creation/admission/claim/model
call/metered activity and zero cost; untouched reservations can be finalized with
the existing manual-basis ledger and explicit never_admitted stop basis. Any
unresolved branch returns `cancellation pending:` and rolls back ALL changes.

Successful finalization releases resource holds, preserves already-incurred
charges and historical passed stages, cancels unfinished Assignments/stages, and
saves an immutable cancellation receipt. It does not create delivery evidence or
attest rollback of external effects. Run completion_authorized remains false.
Repeated command identity returns the same receipt after restart. Host control
loops may retry pending cancellation and reconcile existing usage but cannot
start execution to obtain cancellation evidence. Optional pre-report proofs are
omitted on new cancellation stop requests; previously persisted stop requests
retain exact identity on replay. Busy-execution/fault acceptance remains pending.

Stop uncertainty guard (increment 222): a verification command's returned result
does not itself prove drain. The execution Host checks outstanding verification
process observations before resolving stopped or releasing the workspace.
Unknown/nonempty process groups and unresolved launch receipts retain a stop
fence scoped by operation/home; only known-empty groups clear it. Such a fence
prevents the trusted Assignment stop acknowledgement. A final cancelled Run
read through the controller returns its persisted cancellation receipt.

Cancellation control status (increment 224): specific home accounting responses
for unresolved official usage, mixed usage or charge reconciliation map to
waiting_cancellation_accounting with reason usage_reconciliation_required. They
retain holds and do not imply stop failure or successful finalization. Transport
and authorization errors remain failures. Fresh Host control reconstruction may
replay a persisted drained stop request, but a stopping intent with no live
owned execution remains cancel_unconfirmed and cannot generate a stop receipt.

### dsh Builder selected-workspace inspection (Host-local)

`POST /api/kode/builder/inspect-workspace` is an authenticated **Host owner-only** dsh endpoint, not a messaging Worker capability. JSON contains only `workspace_id` and a nonempty unique `paths` array. The workspace must already exist in that Host registry; callers cannot supply a filesystem root. The initial allowlist is root-level README.md, AGENTS.md, CODEBUDDY.md, CLAUDE.md, package.json, Cargo.toml, Makefile and pyproject.toml. No globbing, recursive discovery, command execution, model calls, Worker creation or activation occurs.

Response facts include relative path, status, and for observed UTF-8 files SHA-256, byte count, observation time and content explicitly marked `untrusted_project_data`. Symlinks (including legitimate AGENTS aliases), multiply-linked files, nonregular files, binary/non-UTF-8 data, changing files and files above 64 KiB are not returned as observed facts. Selection body is limited to 4 KiB and at most eight files. Errors do not expose filesystem paths. Facts are observations, not executable instructions, permission grants or evidence of available adapters. Nested CI/skills, trusted resources, workflow preflight and human activation remain explicit pending checks.

This is a local project reader, not an OS sandbox against a malicious concurrent process replacing ancestor directories. It must not be exposed as a general Worker filesystem reader. Remote Builder routing, durable interview state and final activation remain separate work.

### Home-owned Builder interview snapshots

`GET/POST /api/v1/messaging/superagents/drafts` and `GET /api/v1/messaging/superagents/drafts/:id` require Hub admin authentication. Ordinary session/Worker credentials have no access; a scoped Builder capability is not yet implemented. POST is a full snapshot command `{id, request_id, expected_revision, revoked, interview}`. The interview contains `purpose`, `workspace_refs`, `answers` (stable question IDs to answers), up to three current `questions` (`id`, `prompt`), and nullable `proposed_team`. An answered question cannot remain in the current question list. Proposed configuration is untrusted and does not bypass existing TeamSpec save/preflight/activation.

Hub schema v25 stores append-only revisions with unique `(id, request_id)` and `(id, revision)`. Exact retries return the original response even after later edits/revocation; changed request reuse and stale revisions fail. Revocation is terminal for that draft identity. No Team, session, grant, budget or execution is created by these endpoints. List uses `after`/`limit` (default 25, maximum 50), returns latest-revision metadata and `next_cursor`; full answers require reading the selected draft. Historical snapshots remain stored for audit; a history paging endpoint and scoped Builder identity remain pending.

This snapshot API is the recovery substrate, not the complete Builder dialogue. Persisted inspection evidence, resource recommendations, workflow draft generation, validation-to-TeamSpec handoff and explicit activation are subsequent integrations.

### Builder inspection-to-draft binding

Owner-only dsh `POST /api/kode/builder/prepare-inspection` accepts `{draft_id, request_id, expected_revision, workspace_id, paths}` and returns an exact draft `command` plus pending checks. It requires the current non-revoked draft revision and an exact local Host/workspace/root binding in both the draft and workspace registry before reading project files. It only prepares: it does not save, run commands, create a Worker or activate a team. The caller submits the returned command to the existing home draft POST and retains the exact command for retries; retrying preparation is a new observation, not an idempotent replay of a saved snapshot.

Interview `inspections` are optional for backward compatibility. Each entry contains `workspace` and bounded `facts`. An observed fact includes relative path, SHA-256, UTF-8 byte count, observation time, content and the only allowed trust value `untrusted_project_data`. Hub validates the content/hash/size binding and exact selected-workspace membership, rejects duplicates and traversal paths, and rejects content attached to missing/skipped observations. These are owner-submitted observations, not an attestation that Hub itself read the files or that the files remain unchanged. Partial refresh replaces only explicitly inspected paths and retains each other observation's original timestamp.

The draft POST transport limit is 1 MiB and normalized command limit is 768 KiB (each file at most 64 KiB). `GET /api/v1/messaging/superagents/drafts/:id/commands/:request` is owner-only and returns `{receipt: snapshot|null}` for historical immutable command recovery; no latest-state substitution occurs. Persisted facts do not confer execution/permission authority. Remote inspection, delegated Builder grants and automated interview use of these facts remain pending.

### Configurable Builder interview preparation

Owner-only dsh `POST /api/kode/builder/prepare-interview` accepts `{draft_id, request_id, expected_revision, answers?, clear_answers?, questionnaire?}`. It returns a prepared exact snapshot command, at most three outstanding questions, remaining question count, invalidated branch answers, and explicit pending configuration/preflight/activation checks. It does not save or invoke inference. Submit/retry the returned command using the existing home draft API. The Host validates current draft revision and status before preparing it.

The optional questionnaire is a declarative `{id, version, questions}` plan with up to 128 uniquely identified questions. Each has `id`, `prompt`, and optional `when_answer:{question_id, equals}` referencing only a prior question. The selected full plan is stored in the interview, so subsequent preparation/restart uses the same questions. Forward dependencies/cycles are rejected by both Host and Hub. Replacing an existing plan requires an explicit draft edit; it is not silently overwritten by a supplied default. Free-text answers are preserved; branching only uses an exact explicit answer, not inferred project preferences.

The bundled software-team v1 plan covers task scope, configurable delivery endpoint, an actual example, optional defect-reproduction policy, workflow, resources, team budget, permissions, verification responsibility, failure handling and concurrency. It recommends implementation/review/verification without granting permissions or fixing an endpoint/model/platform. Existing answers are reused. Changing a branch removes its now-inapplicable answers from the new snapshot (historical revisions retain them). Answer changes clear the proposed TeamSpec. Completed interview answers still leave `eligible_for_execution:false`; semantic interpretation, resource recommendation, concrete normal/failure walkthrough, config generation and activation remain separate work.

### Builder candidate preflight

`POST /api/v1/messaging/superagents/drafts/:id/preflight` is owner-only and read-only. Input `{expected_revision, team_id}` identifies an exact current interview snapshot and the intended candidate team identity for policy binding checks. Revoked/stale drafts fail. The response reports pending interview questions (including unresolved persisted questionnaire items), absent project observations, missing/invalid proposed TeamSpec and proposed workspaces outside interview selection.

A structurally valid proposal uses the same workflow-role, exact project/delivery reference and budget/scheduling policy validators as saved-team preflight. Candidate diagnostics have `team_revision:null` and no invented Superagent identity. No team/session/activation is materialized, no policies are written, and no budget is reserved. Live dependencies are diagnostic reads, not an atomic admission snapshot; a concurrent draft revision change invalidates the result. `eligible_for_execution` remains false and resource coverage, observation freshness, semantic review, normal/failure walkthrough and human activation remain pending.

Builder preflight now includes `resources` for a structurally valid proposed TeamSpec. Every configured execution target has a row, including missing/mismatched policy bindings. Matched candidates reuse the authoritative home resource admission evaluator for account epoch, binding revision, quota freshness/exhaustion and configured monetary requirements. An allowed unknown-quota/team-budget fallback remains `unknown_requires_team_budget`, never a provider balance. Capability profile identity is checked against the pinned revision/model/host/profile; this does not establish runtime capabilities or role fitness.

`quota_and_identity_checks_complete` requires a nonempty target list and fresh quota plus matching capability identity for every target. It is not dispatch eligibility. `team_budgets` separately contains existing labeled team-budget snapshots, scope/period checks and whether available internal units cover the configured maximum assignment charge. Preflight does not reserve/spend or query provider credentials. Runtime capability, role-fit, workspace/grant and atomic budget admission remain pending. Live diagnostic reads are not a guarantee against subsequent account/budget changes.

### Controlled official Builder tool projection

Trusted Host setup can mount `mountOfficialBuilderTools` on an existing local managed official operation with fixed `{draft_id, team_id}`. Installation verifies operation/attempt/epoch/Worker identity and requires both `budget_required` and `grant_required`; the ordinary official lease enforces actual grant and budget admission before execution. This does not create a Builder session or allocate its budget. Remote Builder execution is not yet supported.

The projection exposes `kode_builder_read_draft` (no arguments), `kode_builder_preflight` (`expected_revision`), `kode_builder_inspect_workspace` (`expected_revision`, `request_id`, `workspace_id`, `paths`) `kode_builder_prepare_questions` (`expected_revision`, `request_id`) and `kode_builder_save_draft` (`expected_revision`, `request_id`, `questions`, `proposed_team`). No model-supplied draft/team ID, shell, plugin installation, team activation or credential access is exposed. Policies bind to the exact per-Agent implementation; direct tool-body invocation requires the existing official execution-entry context. The ordinary official tool journal, model-call accounting, allow mask and grant checks remain in use. Draft revocation, home change, selected-workspace change or operation binding change rejects subsequent reads. Answers/observations remain untrusted data. Host configuration is cloned, so later mutation cannot widen the mounted scope.

This is a scoped runtime projection. Automatic Builder creation, resource admission/setup, user-question delivery and final activation handoff are not yet wired into a complete creation experience.

Builder official inspection uses the same bounded document allowlist and prepares an exact snapshot command without saving. The workspace must be both in the fixed draft scope and the active operation grant target; being selected in a draft alone is insufficient. Existing workspace locks protect the controlled read. Question preparation uses only persisted owner answers/questionnaire and exposes no `answers`, `clear_answers` or template replacement arguments to the model. Both operations recheck draft scope/revision after preparing results. Prepared inspection commands remain proposals; the save tool below only accepts questions and proposed team configuration, not arbitrary snapshots or observation edits. No activation tool is exposed. Builder preparation IDs now match the Hub ASCII identifier grammar, including periods, colons and hyphens.

### Builder draft write authority

Owner-only `POST /api/v1/messaging/operations/:id/builder-scope` binds one prepared local operation attempt to an existing draft: `{expected_revision, attempt, epoch, draft_id, draft_revision}`. The operation must require budget and grant enforcement. The binding snapshots selected workspaces and is immutable; exact attachment retries return the original binding. It neither starts execution nor allocates budget.

Owner-only `GET` on the same path returns `{scope}` for the operation's current attempt, or `{scope:null}` when unbound. It is a read-only binding lookup, not execution admission. Official Builder tool mounting requires this authoritative scope to match the local Host, Worker, operation attempt/epoch, selected draft and frozen workspaces before any tools are registered or model calls begin. Worker credentials cannot read this owner endpoint. Lease, budget and grant enforcement still occurs through normal official execution and transactional draft writes.

Owner/Host draft POST may include `builder_operation:{id,attempt,epoch}`. For a new write, the same SQLite transaction verifies the bound draft/workspaces, active unexpired operation lease, existing budget admission, live operation grant, explicit `builder_draft_write` capability and `kode_builder_save_draft` tool permission. This is a new dedicated grant capability, not implied by `read` or `workspace_write`. Ordinary Worker HTTP credentials still cannot call owner draft APIs. The trusted Host tool will supply the operation identity; no new credentials are introduced.

Builder-attributed writes can update current questions and proposed TeamSpec only. Purpose, workspace selection, user answers, questionnaire and inspection observations must match the current draft; revocation is owner-only. Proposed TeamSpec shape and selected-workspace containment are validated, but it remains non-executable until separate preflight/activation. Stored actor is derived from the operation's actual Worker/Host/attempt/epoch, never labeled as a human. Exact saved command replay returns the historical receipt even after later revocation, without another mutation. The scoped runtime save tool below supplies this identity and uses the same transactional authority.

`kode_builder_save_draft` requires explicit `read` + `builder_draft_write` capabilities and the owner-bound operation scope. The trusted Host fixes draft/operation identity and copies protected fields from the current authoritative draft, accepting only questions and proposed TeamSpec from model arguments. The model cannot pass user answers, observations, actor, revocation or a different draft. Hub still validates every new write. A committed response loss is recovered via owner command-receipt readback, verifying draft/request/revision, exact Builder actor and proposed contents (with known TeamSpec optional-field normalization). No POST retry is performed on ambiguity. A missing/mismatched receipt remains an error and existing tool-journal uncertainty rules apply. Repeated matching calls read the same receipt without another write.

### Owner answer delivery

`POST /api/v1/messaging/superagents/drafts/:id/answers` accepts `{request_id, expected_revision, answers?, clear_answers?}` from the authenticated owner only. The dsh owner route `/api/kode/builder/answer` accepts the same fields plus `draft_id` and forwards without exposing backend credentials; it rejects Agent principals and extra authority fields. It is not installed in the Builder tool projection.

Answer IDs must belong to the persisted questionnaire, current questions or existing answers. Unknown/inactive branch answers, overlapping answer/clear IDs, stale/revoked drafts and malformed inputs fail. One transaction applies answers, removes inactive branch answers, recomputes up to three unanswered questions, clears proposed TeamSpec when answers change, saves the human-attributed draft revision and stores the immutable answer-command receipt. Existing observation/workspace data is preserved. With no questionnaire, answered current questions are removed. No inference turns free text into a grant or activation.

Exact retries return the original receipt even after later revisions/restart; changed request reuse fails. Failed/concurrent writes leave no partial answers. Protected Builder write checks continue to apply to model-originated proposal edits; this endpoint is a separate human entry, not a way for the Builder to mark its own decisions confirmed.

### Atomic Builder operation preparation

Owner-only `POST /api/v1/messaging/superagents/builder-starts` accepts `{draft_id,draft_revision,price_id,operation}`. `operation` uses the existing operation-bundle request (owner/request identity, local Worker, exact selection, funding, resource policy and explicit grant scope). Budget/grant/account/price policies must already exist; this endpoint cannot infer or increase them.

One transaction creates the resource-required operation, reserves and binds team funding, binds the existing grant and resource policy, attaches matching requested-model pricing and freezes the draft scope. It requires the draft's selected workspace and full Builder read/write tool grant. Any failure, including late draft revision rejection, rolls back operation, reservation, bindings and receipts. No session, model call, team activation or operation claim occurs. Unknown vendor quota remains explicit through the operation-bundle resource decision; team-budget fallback is not a vendor balance.

The result is `{bundle,pricing,scope,dispatch_state:"not_dispatched"}`. Exact owner/request replay returns the immutable historical result across response loss, concurrent retries and restart. Changed request content conflicts, and this path cannot adopt a pre-existing operation prepared elsewhere. A historical receipt does not rewind a subsequently active operation; Host preparation must still read current state before dispatch.

The authenticated dsh owner bridge `POST /api/kode/builder/start` accepts `{command_id,team_id,provider,start}`, where `start` is the atomic Hub request above. It invokes the registered official runtime, prepares the bound execution profile and dispatches with the fixed Builder tool set. Agent principals receive 403; absent runtime receives 503; input is limited to 128 KiB. Successful response is the durable creation receipt, not an interview response or completed team. An unconfirmed start returns 409 with `retry:"same_request"`; callers must not invent a replacement identity to recover. Internal runtime diagnostics are not returned. This endpoint never submits model input, activates a team or automatically releases an uncertain budget hold.

### Builder owner input

Owner-only `POST /api/v1/messaging/operations/:id/builder-inputs` accepts `{request_id,draft_id,attempt,epoch,content}` (nonempty text up to 16 KiB). It checks the active local operation lease, current funding/grant/resource admission, immutable Builder scope, nonrevoked selected draft and registered Worker. One transaction persists a human-attributed input receipt and a message in the existing durable inbox. Exact replay returns the original record even after later state changes; changed request reuse conflicts. Owner-only `GET .../builder-inputs/:request_id` returns `{input}` or null. Text does not mutate interview answers, grants or activation state.

The inbox payload is a reference envelope, not trusted text. Production Host bindings carry managedBuilder.draft_id. Before followup, the Host reads the owner-only record and checks message ID, operation/attempt/epoch, Worker/home, draft, request and human actor. Ordinary peer messages or forged envelopes cannot be promoted to human input. The actual persisted text is submitted as user input through the existing delivery tracker, which flushes session evidence before queue/consumption receipts. It never resubmits an ambiguous delivery. User-facing chat routing and response presentation remain separate work.

Authenticated dsh owners use `POST /api/kode/builder/input` with `{operation_id,request_id,draft_id,attempt,epoch,content}`. It forwards only the permitted command fields to the Hub and exposes no backend credentials. Agent principals and extra authority fields reject before forwarding. JSON transport is bounded to 128 KiB and text to 16 KiB. An ambiguous backend failure returns generic 409 with same-request recovery guidance and no automatic resend.

`GET /api/kode/builder/input?operation_id=...&request_id=...` returns `{input,delivery}`, where delivery is the existing execution-host delivery record, or null if not yet observed. Both calls in receipt lookup are read-only; lookup does not resume/claim/create any runtime. Delivery state is not a Builder answer or completed configuration. Assistant response presentation remains separate.

`GET /api/kode/builder/conversation?operation_id=...&seq=0&offset=0` is owner-only and resolves Worker identity from Hub operation/Builder scope plus matching local managed binding. It returns `{operation_id,draft_id,source,messages,cursor,has_more}`. Source is `live` or `stored`; neither implies workflow completion. Stored reads open a read-only persistence handle and never resume/create an Agent. Header ID and selected workspace root must match.

The cursor is an inclusive raw event sequence and Unicode code-point offset within that event's text. Pages inspect at most 64 raw events, return at most eight text segments, and split long text at 4096 code points. Continue with the returned cursor; at the end, the cursor can be polled for later events. Only user/message and assistant/message text blocks are exposed. Tool payloads, reasoning, metadata and non-text blocks are excluded; excluded events still advance the cursor. This is not an artifact download or a complete session-debug view. Malformed/unavailable cursors fail without executing anything.

Before the dsh start bridge calls atomic Hub preparation, it freezes the interview in a draft revision using a deterministic command ID derived from owner/start request/draft/original revision. A blank draft gets the existing software-team default questionnaire and first three questions. An existing questionnaire and its answers remain unchanged. Populated drafts without a questionnaire require explicit plan selection instead of guessing. A committed-save response loss is resolved through the original draft command receipt; exact retries use that historical revision and cannot rewind subsequent answers. The new revision is supplied to Hub scope binding and Host preparation. Initialization may remain as a draft if later resource preparation fails; it does not reserve budget, start a model or authorize a team.

### Builder confirmed-answer continuation

Owner-only `POST /api/v1/messaging/operations/:id/builder-continue` accepts `{draft_id,attempt,epoch,answer}` where `answer` is the existing answer command (`request_id`, `expected_revision`, `answers`, optional `clear_answers`). The existing answer save and durable inbox enqueue run in one transaction. Invalid operation identity, expired lease, denied grant/resource/budget or wrong draft scope rolls back newly saved answers and their receipt. The continuation message request ID is deterministically derived from draft and answer request IDs. Concurrent exact retries return the same historical draft/input receipts; changed identity conflicts. Existing standalone answer behavior remains save-only. A pre-existing standalone answer cannot be undone by a later failed continuation.

Authenticated dsh owners use `POST /api/kode/builder/continue` with the same fields plus `operation_id`. The bridge bounds JSON to 128 KiB, rejects Agent principals and unexpected authority fields, and never silently retries an ambiguous backend response. Exact request replay is the recovery operation. The returned `input.receipt.message_id` connects to existing delivery evidence; enqueue success does not mean the model consumed input or completed a reply. Host inbox delivery continues the existing scoped Builder session. Confirmation neither activates a team nor changes grants or the actual team budget: a budget answer is a draft preference only.

### Host-persisted Builder observations

The scoped `kode_builder_inspect_workspace` tool now persists Host-captured observations rather than only returning a prepared command. Model arguments remain exact draft revision, request ID, selected workspace and allowlisted paths; they never include observation bytes. The Host uses the existing bounded no-follow reader and draft CAS/command receipts. A committed-response loss is recovered by receipt lookup, not a second capture/save. Exact retries return the original observation even when files later change; selection, revision or actor mismatch rejects.

The owner-authenticated draft save transport accepts optional `host_inspection:{operation:{id,attempt,epoch},workspace_id,paths}`, mutually exclusive with `builder_operation`. In the draft transaction, Hub checks the active operation/scope, current budget/grant/resource admission, `builder_draft_write` and the inspection tool in the grant, and exact granted local workspace. Only selected file observations may change; answers, questions, proposal, questionnaire, scope and other observations remain protected. The snapshot actor is `host_inspection`, with operation identity and exact selection. Content remains `untrusted_project_data`, not permission or proof of semantic correctness. Session principals cannot call this owner transport. This is trust in the local Host reader, not independent remote attestation.

The existing owner prepare-inspection route remains prepare-only. The question preparation tool remains prepare-only. After an official inspection succeeds, subsequent saves must use its returned draft revision. No team activation or runtime permission is implied.

### Builder configured workflow/project/delivery catalog

Owner-only `POST /api/v1/messaging/superagents/drafts/:id/catalog` accepts `{expected_revision,kind,after_id,after_version,limit}`, with `kind` workflow/project/delivery, empty initial cursors and limit 1–10. It reads only existing immutable versions under the exact current nonrevoked draft revision. Workflow versions are shared configuration; projects require every repository workspace to match a selected draft workspace exactly. Delivery policies require their exact pinned project/hash to pass the same selection check. This catalog contains configuration references, never connection credentials, and confers no activation/admission.

Items include their existing version/hash and stored configuration. An entry exceeding 64 KiB is explicitly reduced to reference metadata with `details_omitted:configuration_too_large`; callers must not treat it as complete. Pagination scans stored rows in id/version order. Filtering may yield an empty page with `has_more:true`: continue with its cursor. Version order is lexical, not semantic latest-version selection. Each request is read-only; no team, Worker, hold or grant is created.

The official Builder projection adds `kode_builder_catalog` as its sixth tool. Host fixes the draft identity and checks live binding/selected scope; existing tool admission handles lease, budget and grant. New Builder starts require this tool in their explicit grant. Model arguments can select only category, current draft revision, cursor and bounded limit. Resource/model catalogs and policy configuration remain separate work; absence from these three catalog categories is not evidence of zero resources or balance.

### Builder candidate-team policy discovery and live facts

Builder catalog additionally accepts `kind:budget_policy|scheduling_policy` with an explicit valid `team_id`. It returns only that candidate team's current policy rows, not duplicated historical ledger rows. Policy cursors use the stringified revision in `after_version`; responses retain original numeric `revision` and hash. The official catalog tool supplies its fixed candidate team, not a model-selected team. Policy contents are configured preferences/references, not live balances or permission.

Owner-only `POST /api/v1/messaging/superagents/drafts/:id/policy-details` accepts `{expected_revision,team_id,policy_id,policy_revision,target_id}`. Draft and current policy revision/team must match. Budget policy uses empty target_id and returns labeled team-budget snapshots, period/scope validity and coverage of max assignment charge; provider quota is explicitly not queried. Scheduling requires one configured target and returns existing resource admission diagnostics (including unknown/quota exhaustion/account-binding states), its exact capability profile, resource identity match, optional internal price, and explicit runtime/role-fit checks not performed. No reservation or execution is performed. Draft/policy revisions are rechecked after reads; facts may change afterward and are not an atomic admission snapshot.

The seventh official tool `kode_builder_policy_details` fixes draft and candidate team, and accepts only the exact policy revision and target selection. Existing runtime tool accounting, lease and grant enforcement apply. New Builder starts require the tool in their explicit grants. Capability profiles are soft, sourced evaluations; they are not proof of executor features, current role fit or future output quality. An empty catalog identifies missing configuration, not zero balance or lack of available models globally.

### Explicit owner acceptance of a Builder proposal

`POST /api/v1/messaging/superagents/drafts/:id/accept-proposal` is owner-only and accepts `{request_id,expected_revision,team_id,team_revision}`. Under one transaction it checks the current nonrevoked Builder draft, requires a structurally valid proposed TeamSpec confined to selected workspaces, saves that exact spec through the existing team CAS/identity mechanism, records a source-linked acceptance receipt and appends `builder_proposal_accepted` to the team audit. Team/version conflicts create no partial acceptance. The source interview stays unchanged. Exact replay returns the original receipt/team snapshot even after subsequent team edits or source revocation; changed request reuse conflicts. `GET .../acceptances/:request_id` returns `{acceptance}` or null for read-only recovery.

The result explicitly reports `activation_performed:false` and a non-executable team draft. Acceptance can preserve incomplete configuration for later editing; it does not assert interview completion, semantic validity, normal/failure walkthrough completion or readiness. Activation remains a separate explicit owner command through existing team activation, including its exact grant/policy/version checks. No Worker, lease, budget hold or model call is created by acceptance.

The dsh owner bridge is `POST /api/kode/builder/accept-proposal`, adding `draft_id`, with a 4 KiB command bound and no caller-supplied spec/actor/activation fields. `GET` with draft_id/request_id reads the receipt. Model/Agent principals cannot use either path. Ambiguous forwarding returns generic same-request recovery; there is no hidden resend. This endpoint is not in Builder's model tool projection.

### Owner activation review and confirmation bridge

Owner-only `POST /api/v1/messaging/teams/:id/activation-review` accepts `{team_revision,request_id}`. It reads the exact current team, existing workflow/project/policy preflight, current resource diagnostics, grant and activation state. The response presents these separately plus issues, pending checks, and a `prepared_command` for existing team activation, or null when basic configuration/grant checks are incomplete. It never activates/reserves/creates runtime work. The command pins team, activation, grant and both policy revisions/hashes. Reads recheck current team/activation/grant/policy versions; live resource facts remain diagnostic and may change after review.

A prepared command is not a successful dry-run admission. Normal/failure examples, owner confirmation, full activation scope validation and live execution admission remain explicit pending checks. The existing activation transaction remains authoritative and repeats workspace/tool/budget/grant checks; stale reviewed versions reject. No review result may silently refresh authority during confirmation.

The dsh owner routes are `POST /api/kode/teams/activation-review` with `{team_id,team_revision,request_id}` and `POST /api/kode/teams/activation` with `{team_id,command}`. The latter forwards the exact reviewed activate command or an explicit existing deactivate command, never auto-reviews/retries. `GET /api/kode/teams/activation?team_id=...` reads existing state. All are owner-only, bounded to 8 KiB commands, with redacted generic errors and same-command recovery on unconfirmed action. These are advanced API entry points, not completed UI/creation-flow acceptance.

### Stable Superagent conversation intake (schema v26)

Owner-only `POST /api/v1/messaging/conversations/:id/messages` accepts only `{request_id,content}`. Conversation identity resolves to the stable team, not an execution session. New messages require an active, currently valid team grant; the intake transaction pins the activated team/activation revision, persists a human-attributed message and appends a team audit event. It does not use an unactivated newer team draft. Text is nonempty UTF-8, at most 64 KiB, without NUL. Unique `(conversation,actor,request_id)` ensures exact replay; changed content conflicts. Replaying an existing receipt remains possible after deactivation/restart without creating or dispatching work.

The immutable intake receipt reports `state:accepted` (persisted) and `coordinator_delivery:pending`. This does not prove model consumption, a WorkRun, reply or execution. Coordinator lease/consumption and automatic request interpretation are subsequent implementation work; there is no hidden session fallback. Worker/session principals cannot submit or read these owner routes, and callers cannot choose an actor, session, model or team revision.

`GET .../messages?after=<sequence>&limit=<1..50>` pages durable full messages; default limit 20, a page is also bounded to 256 KiB after at least one message. `has_more`/`next_cursor` advance without text truncation. `GET .../requests/:request_id` returns `{message}` or null. History remains readable after deactivation. Schema v26 adds `conversation_messages` with a conversation/sequence index, retaining all prior session/Builder/team data; SQLite snapshot backup precedes upgrade.

The dsh owner bridge `/api/kode/conversation/messages` accepts POST `{conversation_id,request_id,content}` and GET with conversation_id plus either request_id or after/limit. It performs bounded exact forwarding and read-only receipt/history lookup, never creates/resumes a session, invokes a model or refreshes authorization. This is a backend/Host entry point, not a completed IM interface.

### Exclusive Coordinator control binding

Owner-only `POST /api/v1/messaging/teams/:id/coordinator-control` accepts `{request_id,expected_revision,team_revision,activation_revision,operation_id,operation_revision,attempt,epoch,target_id}`. The existing prepared operation must be local, budget/grant/resource-required, and match an activated Coordinator target, exact executor profile revision/model/effort, frozen resource candidate/capability identity, activated grant workspace, budget policy limits/IDs/unit and matching requested-model internal price. Worker Assignment or Builder operations cannot be adopted; a Coordinator operation cannot subsequently be bound as Builder.

One transaction CAS-binds the team's stable Superagent/conversation identity to that operation and stores command/operation receipts plus audit. Concurrent contenders cannot both obtain the control slot. Binding itself does not create a runtime or reserve more money: callers prepare funding via existing APIs. If binding loses a race, its pre-existing prepared bundle remains subject to existing explicit safe abandon/recovery; this endpoint does not silently release uncertain funds.

Existing operation lease, grant and official-call/tool admission now additionally check the current Coordinator slot and exact activation revision for bound operations. No second heartbeat/lease clock is introduced. Deactivation, replacement or activation revision change fences further managed lease/tool admission. Old command replay returns historical receipt and cannot reacquire control. GET returns `{control}` for the latest binding snapshot; its `dispatch_state:not_dispatched` describes binding-time behavior, not live runtime state. Query the referenced operation for current state.

A replacement requires the prior operation to be reported/stopped, reservation finalized with zero held balance, all existing official model calls finished/accounted, and all recorded uncertain tool outcomes explicitly adjudicated. Lease expiry, cancellation intent or mere budget finalization is insufficient. Tool adjudication retains its existing `replay_authorized:false` meaning. Runtime stop/termination proof and delivery reconciliation still use existing adapters; this binding API alone is not a running Coordinator or consumed conversation message.

### Coordinator conversation-to-inbox delivery

Owner-only `POST /api/v1/messaging/conversations/:conversation/messages/:message/coordinator-input` accepts `{operation_id,control_revision,attempt,epoch}`. It checks the source human conversation message, exact current Coordinator binding and matching activated team/activation revisions, active unexpired local operation, grant/budget/resource admission and registered runtime session. One transaction creates the existing durable inbox reference plus an immutable input receipt and team audit; caller supplies no text or actor. The source uses a bounded stable hash-derived virtual owner identity, not an Agent identity.

The source conversation message can bind to only one such delivery. Concurrent exact retries return that receipt; a different control/operation/epoch conflicts, including after control replacement. Historical replay never silently queues again or refreshes the inbox TTL. GET at the same path returns `{input}`, including the original source message fetched from its immutable conversation record. Existing inbox delivery evidence supplies accepted/consumed state; an input receipt's queued state alone does not prove model consumption.

Host recognizes only a local `managedCoordinator` binding with fixed team/conversation/control revision and matching managed operation. It verifies original source envelope, exact delivery receipt, Worker identity and human source record before converting it to a user input through the existing delivery tracker. Ordinary peer envelopes, wrong inbox IDs, closed/mixed-role bindings and mismatched control revisions cannot fall back to general Agent input. This is delivery plumbing; automatic Coordinator runtime setup/dispatch and model consumption acceptance remain separate work.

### Coordinator durable reply publication

Owner-only `POST /api/v1/messaging/conversations/:id/coordinator-replies` accepts `{request_id,source_message_id,operation_id,control_revision,attempt,epoch,content}`. No caller actor is accepted. The source must be a human input bound to this operation/control and confirmed consumed by the existing runtime delivery tracker. Publication checks current control, active unexpired local lease and live grant/budget/resource admission. It atomically inserts a stable conversation message with `actor.kind:superagent`, `in_reply_to`, operation/control provenance, `state:published` and a team audit event. UTF-8 content is bounded to 64 KiB. Publication is not workflow completion evidence.

Exact retries return the original immutable message even after stop, deactivation or restart; changed arguments conflict. Owner-only GET at `/coordinator-replies/:request` returns `{message}` for recovery. Existing conversation history includes both human and Superagent rows in sequence order. Worker credentials cannot invoke publication or receipt lookup.

The controlled official Coordinator has a fixed `kode_coordinator_publish_reply` tool, requiring explicit tool-name grant and read capability (in-product owner conversation only, not an external messaging permission). Team/conversation/control/operation are injected by the Host. Input includes its Hub source-message reference. Before publication the tool flushes actual session input evidence through the existing delivery tracker; it cannot fabricate a consumed input. A committed lost response is recovered by receipt read with exact argument checks, not another write. Runtime transcript output alone remains unpublished. Native two-turn consumption and publication are covered with a controlled model adapter; automatic workflow dispatch and real-provider semantic acceptance remain separate work.

### Coordinator WorkRun intake

Owner-only `POST /api/v1/messaging/conversations/:id/work-runs` accepts `{request_id,source_message_id,operation_id,control_revision,attempt,epoch,binding_id,inputs}`. Run identity derives deterministically from conversation and request identity; team and team revision come from the persisted source input. The caller cannot select a different team/revision, actor, arbitrary workflow version or prior run. Existing WorkRun creation retains immutable workflow/project preflight, exact input-name matching, capacity enforcement and activation binding.

Inside the existing insertion transaction, current Coordinator control, active local lease, grant/budget/resource and consumed source delivery are rechecked. Operation scope must grant `delegate` and `kode_coordinator_workflow_start`. New runs carry a Superagent owner and `coordinator` source/conversation/delivery/operation provenance. Activation must remain valid; existing WorkRun services own subsequent dispatch. A returned `waiting_resource` receipt does not prove assignment, execution or delivery.

Exact retries return the original initial run receipt after stop/deactivation/restart; changed arguments conflict. GET `/conversations/:id/work-runs/requests/:request` returns `{run}` for immutable receipt recovery. Existing `/work-runs/:id` remains the authoritative current-state read. The scoped official tool fixes authority, flushes existing consumption evidence and recovers committed reply loss by receipt lookup without repeating the write. Controlled native acceptance currently demonstrates start plus published pending-status reply; complete Coordinator-driven workflow progression remains separate acceptance work.

### Scoped Coordinator configuration and status reads

The official tool projection includes `kode_coordinator_configuration({binding_id})` and `kode_coordinator_workflow_status({run_id})`, each requiring explicit named-tool grant and read capability. Configuration reads the exact activated snapshot, not the latest unactivated team draft. Empty binding ID returns configured workflow choices, required input names and completion stages; an existing ID returns its frozen workflow/project/delivery binding. Status returns the current home WorkRun revision/state/stages/delivery/cancellation evidence, restricted to the fixed team. It never advances or retries work.

Both tools verify fixed local binding, operation/control identity and current authorized activation before and after asynchronous reads. A changed control or activation fails the read. Results exceeding 64 KiB fail explicitly without returning a silently truncated configuration or success claim. These tools do not establish live resource availability, execution or completion merely by returning configuration. Existing runtime lease/tool guards remain authoritative admission checks.

### Durable Coordinator terminal and blocked-run feedback

Owner-only GET `/api/v1/messaging/coordinator-updates/pending?after=...` lists at most 32 eligible Coordinator-origin runs whose current revision has no queued notice receipt: terminal `completed`/`failed`/`cancelled`, `waiting_user`, `cancel_unconfirmed`, or `waiting_resource` unchanged for at least 30 seconds by the Hub updated_at timestamp. Discovery derives from durable Hub state rather than an in-memory WorkRun callback. Cursor pages wrap on the next scan. Brief resource waits are not notified. Coordinator control replacement/context rotation still require separate recovery handling.

Owner-only POST `/work-runs/:id/coordinator-updates` accepts `{expected_revision}`. In one transaction it verifies the exact eligible run revision, original current Coordinator control and active local lease with live grant/budget/resource admission, creates one existing inbox message, and stores the notice receipt/audit. Worker principals cannot submit notices. GET `/work-runs/:id/coordinator-updates/:revision` returns `{update}` with authoritative summary and delivery identity. Exact retries after stop/restart return the same receipt without requeue; changed revisions must independently qualify. Queued does not mean consumed; expiry/ambiguity does not authorize rebind or replay.

WorkRunService owns a separate bounded notice discovery pump. Blocked entries do not prevent subsequent page entries. Lost POST responses do not cause immediate write retry; persisted notices leave pending discovery and existing inbox tracking owns delivery. Host validates fixed scope, source hash, actual message ID and authoritative receipt before presenting an explicitly labeled internal workflow event. No new human conversation row is inserted. Coordinator reads workflow status and publishes its result for the original human source.

Controlled native acceptance covers automatic implementation, independent review, real subprocess verification, terminal notice consumption and final reply after one human request. A second variant pauses/recreates the notice pump after completion and discovers the pending durable record. This proves notification-service reconstruction, not whole-runtime/context recovery or paid-provider quality.

### Automatic intake for owned Coordinator runtimes

Owner-only GET `/api/v1/messaging/conversations/:id/pending-inputs?after=0&limit=20` returns bounded `{message_id,sequence}` references for human messages without any Coordinator input receipt. Limit is 1–32; `next_cursor` is the last returned sequence when another page exists, otherwise null. Already-bound historical/uncertain/expired deliveries never return to this discovery list. Source content is not copied into the page.

OfficialLoopHost owns a bounded CoordinatorInbox pump. It scans only already-owned, live managed Coordinator handles, rotating through at most 32 handles per scan and at most 20 input references per conversation page. Before each dispatch it rechecks the exact local operation/control binding; existing Hub dispatch remains the final authority for activation, lease, grants, budget and resources. A blocked input does not prevent later page entries. Lost committed responses are discovered as no longer pending; there is no immediate write retry, implicit rebind or recreation. The pump closes with the Host and does not start new runtimes. Runtime bootstrap/control recovery remains separate work.

### Atomic Coordinator start preparation and owner runtime entry

Owner-only POST `/api/v1/messaging/teams/:id/coordinator-starts` accepts `{request_id,expected_control_revision,team_revision,activation_revision,target_id,price_id,operation}`. `operation` is the existing managed operation-bundle request. One transaction prepares funding/resource/grant bindings, requested-model pricing and exact Coordinator control binding. Existing control CAS, activated target/scope/policy checks and replacement reconciliation fences are reused. All four implemented Coordinator tools plus read/delegate capabilities must be explicitly granted. Remote bootstrap and adoption of an existing operation are rejected. Failure rolls back the new operation, reservation, pricing and control receipt together.

Exact start retries return their original bundle/control receipt, including after activation changes or stop. Changed requests conflict. `dispatch_state:not_dispatched` is preparation-time evidence, not a live runtime status. The owner dsh POST `/api/kode/coordinator/start` accepts `{command_id,team_id,provider,start}` and executes this preparation followed by existing exact local profile/model/workspace checks and durable official dispatch. Concurrent identical commands share one pending start. A historical creation receipt bypasses preparation/claim/resume and is fingerprint-checked by the existing ledger. Ambiguous errors return generic `same_request` recovery guidance, never an assertion that no effect occurred or an automatic budget release.

This low-level entry requires an already-configured, activated team and explicit trusted start parameters. The higher-level planner below selects configured resources; neither entry constructs missing configuration or implements automatic dormant-team discovery/control rotation. If runtime admission fails after atomic Hub preparation, the prepared hold remains subject to existing explicit bundle recovery/abandonment rules; it is not silently retried under changed authority.


### Durable planned Coordinator startup

Owner-only dsh POST `/api/kode/coordinator/bootstrap` accepts `{team_id,command_id,request_id,owner_session,session_id,workspace_id,task_tag}`. Host planning reads the authorized activation snapshot and ranks configured priced local Coordinator targets through the existing home resource ranking API, using the requested task tag and activated scheduling weights/floors. It constructs exact profile/model/effort/resource/price, workspace, budget ceiling and activation/control references. The Coordinator receives only read/delegate and its four scoped tools, not Worker write/network privileges. Planning does not reserve funds or authorize dispatch; the existing atomic start remains authoritative.

Before any funded operation, the Host saves the selected command and original request in its existing fsync-backed private profile store under a home/team/request identity. Exact retries reuse that command without reranking, including after the profile store is reopened. Different original parameters conflict. Concurrent same-request calls coalesce. A failed/ambiguous plan save never proceeds to start; a lost Hub response is recovered by submitting the saved command through the existing atomic start and official creation ledgers. Existing profile files without this additive collection remain readable. Historical creation receipts never imply runtime resume or renewed authority. This local intent journal is not another team-state authority; home Hub controls all funding, grants and Coordinator control.

The endpoint does not yet discover dormant teams automatically or resume model contexts. Startup configuration must exist, and callers currently supply stable command/session identities plus workspace/task selection. Missing eligible evidence/pricing, ambiguous candidates, changed authority, or missing permission fail explicitly. Prepared holds after later runtime admission failure remain subject to existing explicit recovery/abandonment.

### Demand-driven Coordinator discovery

TeamSpec optionally contains `coordinator_startup:{workspace_id,task_tag}`. The workspace must be a declared team workspace; task tag is bounded nonempty configured capability-ranking input. The field is omitted when absent, preserving existing draft request identities. Builder guidance includes it; absence does not silently choose a workspace/tag.

The official Host runs bounded home-team discovery independently of mounting an Agent loop. It reads authorized activated snapshots, not latest unactivated draft settings. A configured team without Coordinator control is started only when its stable conversation has a pending human input. Startup identities derive deterministically from home/team/activation revision; the existing durable planned-start journal precedes funding. No request means no startup or reservation. Explicit demand remains effective with proactive_mode=off.

Already owned Coordinator handles continue via existing inbox discovery. A control without an owned runtime is not silently replaced. Only an exact saved automatic startup intent may retry preparation/creation; historical creation without a live handle reports recovery_required, never inferred resume. Other control identities also report recovery_required. Per-team failures remain pending and do not prevent following teams from being inspected. Discovery results are currently Host-internal diagnostic state, not yet an IM status UI. Context recovery/control replacement remain separate pending work.


Blocked-run summaries include event_kind=blocked and the Hub waiting_reason; terminal summaries use event_kind=terminal. Delivery remains a trusted internal event for the original human request, not another user request. The Coordinator is instructed to read current status before describing the wait or a required decision, and cannot infer completion or bypass workflow/permission constraints. A later terminal revision receives its own notice. A run changing before queuing fails the revision check; stale delivered events require a fresh status read. Existing control/grant checks still apply, including after team deactivation; this mechanism does not authorize a revoked Coordinator to speak.

Resource-wait timing is a notification debounce, not proof of a specific resource cause. The reply must use observed Hub facts; detailed admission failures that exist only in Host diagnostics are not invented as durable Hub reasons. User decision application and resumed progression remain governed by their existing owner-authorized APIs.

### Coordinator recovery prerequisites

Owner-only GET `/api/v1/messaging/teams/:id/coordinator-recovery` returns the current control and a read-only recovery assessment, or null control/recovery when no control exists. It lists execution_stop_unconfirmed, budget_not_finalized, call_accounting_unresolved and tool_outcome_unresolved separately. Lease expiry alone never proves execution stopped. Tool evidence references are bounded to 32 with an explicit truncated flag and total unresolved count. No tool bodies, account credentials or model configuration are returned.

The same assessment is used inside the control-replacement transaction, retaining all prior replacement fences. replacement_prerequisites_satisfied means only that the prior execution is stopped/reported and satisfies existing accounting/tool reconciliation prerequisites. Calls with the established estimated_pending_reconciliation status satisfy that existing accounting gate; this is not a claim of provider billing finality. resume_authorized is always false: activation, new operation funding and exact execution admission still apply, and this read never changes state or replays work. Host automatic discovery attaches this assessment to recovery_required diagnostics. Coordinator history restore/control migration is not implemented by this endpoint.

### Coordinator history restoration under replacement control

A newly bound replacement control records predecessor `{control_revision,operation_id,attempt,epoch,worker}` after the shared stop/accounting/tool prerequisites pass. Initial controls retain their prior shape. This immutable provenance permits trusted Host preparation to recognize the exact previous same-session Coordinator binding; it does not grant permission to adopt another role, team, conversation, profile or live local runtime. Local tool evidence must also be settled. Preparation retains prior journals and input IDs while rebinding only the exact new operation/control and clearing its closed flag.

For a start whose authoritative predecessor worker equals the new worker, the existing owner start entry restores the persisted session through the official resume path instead of creating it again. It verifies persisted session identity/workspace, remounts current Coordinator context and scoped tools, and uses normal new-operation grant/selection/lease admission. A private durable resume intent is written before runtime restore, followed by a flushed plugin:kode/coordinator-resume marker and resumed receipt. Exact retries return the receipt; a resuming/uncertain intent never automatically repeats restoration. Changed command fingerprints conflict. Historical replay after the new operation closes does not resume it again.

Actual native acceptance covers two human turns separated by confirmed stop, owner-confirmed budget finalization and replacement operation/control, preserving prior zstd history without repeating old tools, publications or workflow starts. A deliberately lost successful resume response recovers its receipt. This is not yet unattended crash reconciliation or migration of old WorkRun/source-input authority: those remain pinned to their original control until a separate audited transfer is implemented. Model adapters in acceptance remain controlled and unpaid.

### Audited in-flight Coordinator work transfer

Owner-only POST `/api/v1/messaging/work-runs/:id/coordinator-transfer` accepts `{request_id,expected_revision,control_revision}`. It requires the current active local Coordinator to be the exact direct successor of the run's current Coordinator, with identical team/activation versions and the original human input already consumed by its immutable intake recipient. Normal live grant/budget/resource gates apply. A different-session successor may adopt the existing run without replaying the original input. Skipped predecessor, changed activation, stale run revision and Worker principals are rejected.

One transaction updates only the run's current Coordinator provenance/revision/timestamp, stores a transfer receipt plus separate reply-authority record, and appends run/team audit events containing prior/current provenance. Workflow state/stages, assignments, artifacts and completion authority remain unchanged. Original human input binding, inbox delivery and immutable WorkRun creation receipt are never rewritten or replayed. Same request retries return the original transfer receipt after stop/restart; changed request contents conflict.

Owner-only GET `/api/v1/messaging/conversations/:conversation/messages/:message/reply-authorities/:revision` returns `{authority}`: a separately identified authorized request scope, original source receipt and optional transfer provenance. Publication uses this authority while retaining the original consumed-delivery proof. Transferred visible replies include authority_transfer. This grants reply continuity only: it does not permit creating the original workflow again under a new control. Current run updates route through transferred Coordinator provenance; historical queued notices remain immutable and must not be replayed under new authority.

Native acceptance restores a Coordinator while its WorkRun is pending, explicitly transfers custody, then executes actual implementation/review/verification Workers and publishes the final reply through the restored model tool. The test preserves source receipts, verifies Worker denial and stale/changed commands, and replays the transfer receipt after Hub restart. Automatic transfer orchestration and cross-session context migration remain pending.

### Automatic predecessor-work discovery

Owner-only GET `/api/v1/messaging/teams/:id/coordinator-transfers/pending?after=...` returns at most 32 run references with current run revisions, home/team identity and current control revision. It selects only direct-predecessor work under the same activated versions, including a fresh successor session. Nonterminal work remains discoverable. Terminal work whose current notice was already consumed is excluded from automatic replay; explicit audited owner transfer remains available for investigating incomplete final publication.

The official Host starts a bounded CoordinatorTransfers pump alongside inbox discovery. It operates only on its live owned Coordinator handles, validates returned page/control identity, rechecks local operation/control ownership before every mutation, and uses stable per-control/run-revision transfer request IDs. A blocked row does not starve later rows. A committed lost response is resolved by subsequent durable discovery removing the transferred row, not an immediate blind repeat. Cursor pages wrap; Host close aborts and drains the pump. Discovery never creates/resumes a runtime, expands authority or repeats original input/workflow execution.

Actual native acceptance uses this pump, including injected lost committed transfer response, then completes real Worker execution and final original-request publication. A later successor's discovery excludes the already-consumed terminal notice. Automatic old-runtime stop/accounting reconciliation and selecting/preparing the replacement Coordinator remain separate recovery-orchestration work.

### Automatic recovery after confirmed reconciliation

The recovery assessment includes pending_work_count for work still owned by the current control: nonterminal runs or terminal runs without consumed current notice. Automatic startup discovery may prepare a same-session replacement only when replacement_prerequisites_satisfied, exact prior local operation/control identity and unchanged activation/team versions all match, and there is pending work or a new unbound human input. No demand means no new operation or budget reservation.

Recovery identities derive from home/team/activation/prior-control revision. Trusted planner input optionally pins target_id and expected_control_revision; recovery uses both to preserve the activated executor/profile/model and reject a competing control change. The selected command is saved by the existing durable planned-start mechanism before funding. If Hub replacement commits but its response is lost, later discovery retries the exact saved intent associated with the current control request instead of planning another replacement. Normal resume receipts, lease/grant checks, history restoration and automatic work transfer still apply.

This automates continuation after confirmed stop and accounting/tool reconciliation, not the act of asserting those facts. It does not finalize an unknown bill, attest a crashed process stopped merely from lease expiry, resolve uncertain tools, rebind already-delivered ambiguous inputs, or bypass missing local history. Such cases remain recovery_required diagnostics. Actual native acceptance explicitly finalizes the old operation first, then exercises automatic replacement through lost commit response, automatic transfer and final delivery.

### Coordinator startup configuration diagnostics

Builder preflight and owner activation review expose `resources.coordinator_startup`. This read-only diagnostic checks explicit startup workspace/task tag, local Coordinator target identity and profile revision, requested-model internal pricing, grant tools/read/delegate/workspace coverage, budget-policy grant coverage, and configured capability/resource ranking. `issues` identifies blocking configuration gaps; `target_issues` preserves rejected local candidate details. `configuration_checks_complete` means these configuration checks passed, not permission to execute. `eligible_for_execution` and `reserved_by_preflight` remain false. Runtime profile/model support, current budget availability, atomic start admission and owner activation remain pending checks. No reservation, runtime creation, or activation occurs. Legacy manual activation semantics remain unchanged; the Builder must explain and resolve automatic startup gaps before describing a team as ready for automatic operation.

### dsh owner WorkRun controls

Authenticated Host owners can use `GET /api/kode/work-run?run_id=...` for current status and `view=events&after=...` for bounded Hub audit history. `POST /api/kode/work-run` accepts only `run_id`, `request_id`, `expected_revision`, `action`, and (where required) `reason`. Actions are `cancel` (never dispatched, no reason field), `request_cancel` (request executor stop, reason required), and `cancel_settled` (end waiting-user work with settled Assignment evidence, reason required). Commands route through the configured home backend and retain Hub revision, permission, stop and accounting gates. Worker principals cannot access this entry. It neither finalizes cancellation locally nor resumes/completes work or extends rework permission. A transport failure returns an unconfirmed response with `retry:same_request`; exact retries recover Hub command receipts, including after restart. Status reads alone do not substitute for an individual command receipt.

### Coordinator follow-up WorkRuns

Coordinator workflow start accepts optional `prior_run_id`, propagated unchanged to the existing transactional WorkRun intake. The referenced run must be terminal and belong to the same team. A follow-up gets its own request, frozen context, stage attempts and resource admission; it does not reset the old run or erase its evidence. Scoped tool receipt recovery also compares prior-run identity, rejecting changed or omitted lineage on an existing linked request. Omitted/null Rust fields serialize as absent in Coordinator request scope, preserving existing no-prior request receipts. Tool arguments accept omission or a valid string. Coordinator guidance requires a user-requested follow-up after explicit disposition, not replacement to evade rework limits; this guidance does not itself provide new execution authority or structured human decision approval.

### Coordinator resource visibility

`kode_coordinator_configuration` with empty `binding_id` now includes `resources`: current home observations for the activated team's configured targets and budget policy. Optional `resource_after` is accepted only with empty binding ID; follow `resources.next_cursor` to cover all configured targets (eight per page, IDs sorted). Reads use activated policy identities, not latest draft policies or arbitrary model-supplied host/profile/account IDs. Remote facts are read from the home Hub as well.

Team budgets retain the explicit `团队预算` label, limits/spent/reserved/available and estimated/internal-price accounting fields. Provider windows and monetary observations remain separate, including source units, freshness and collection errors. Missing facts stay unavailable/not_connected; failed reads expose no internal error details. Binding identity is checked against the activated scheduling policy and reread after facts; changed or disabled bindings hide account facts. Each fact payload has a 2 KiB bound; oversized details return `detail_limit_exceeded`, never a fabricated balance or silent complete-data claim. The final tool response retains its 64 KiB bound. This is observation, not admission: no provider call, reservation, execution or accounting mutation; atomic runtime admission remains mandatory.

### Owner registration of Builder workflow configuration

`POST /api/kode/builder/configure-workflow` accepts an exact reviewed `{draft_id,expected_revision,request_id,workflow,project,delivery}` package. `workflow` is a WorkflowPack, `project` is an immutable ProjectBindings config; `delivery` contains id/version/targets/required_outputs. The Host derives delivery workflow/project references from actual registered version hashes. Repository workspaces must exactly match the selected draft workspaces; environment hosts must be selected. This is owner-only, never a Builder/Worker write tool.

The exact request is durably saved under a narrowly allowed `builder-workflow-<64 lowercase hex>` owner workbench document before immutable registration. Workflow, project and delivery registry operations retain their own schema validation, immutability and audit. A failure can leave non-executable registered versions; exact retries recover by replaying immutable registration and publishing a CAS receipt. A new intent requires the exact draft revision and draft status. Recovery of an already durable owner intent may use a later draft revision, but only while the draft is still open and the original package repository/environment scope remains selected. Interview or proposal edits do not replace the frozen intent. Scope/status are rechecked before receipt publication; the receipt retains the originally confirmed draft revision. These separate registry writes are not a transaction with draft edits: failures can leave partial non-executable versions, never authority or activation. Completed receipts remain readable by exact retry after subsequent draft changes/revocation without effects. A request-identity conflict never overwrites the existing intent.

The resulting exact references become discoverable through existing scoped Builder catalogs. No interview answers/proposal are changed, no team is created or activated, and no resource, budget, grant, verification command or external connection authority is provisioned by this operation. Those remain separate reviewed setup/activation requirements. Error responses explicitly state that immutable versions may already exist and direct callers to retry the same request.

### Saved Builder workflow proposals

Builder Interview optionally carries `proposed_workflow:{workflow,project,delivery}`, using the reviewed setup package shapes above. `kode_builder_save_draft` accepts it as an optional proposal field; omission/null clears it. Hub validates typed package structure, workflow graph and selected repository/environment scope. It stores the original JSON for exact tool receipt recovery; registry/project-delivery compatibility remains checked at owner registration, so saving is not readiness proof. Host inspection cannot change this proposal. Confirmed owner answer changes invalidate both proposed_team and proposed_workflow. Legacy absent fields serialize unchanged.

The owner configure-workflow entry also accepts only `{draft_id,expected_revision,request_id}` to confirm that draft's saved proposal. The Host obtains its exact contents, then uses the same durable setup path. Existing exact request receipts are recovered before reading a changed/revoked draft. The Builder can save proposed configurations but cannot confirm/register them through its model tool set. Human consent is not inferred from assistant text, stored proposals, or a passing structural check.

### Host adapter readiness in creation review

The dsh activation-review response and scoped Builder preflight add `runtime_readiness`. This is local Host inspection of default Assignment tools and registered verification metadata, separate from Hub configuration validation. Per binding/stage it reports missing execution scope/default tools, missing verification command, definition/environment/scenario mismatch, insufficient stage scope, unsupported environment adapter or remote verification not checked. `default_adapter_checks_complete` covers only these inspections; `eligible_for_execution` remains false and remote/executor/executable/live admission/artifact/delivery checks stay explicit. It neither executes a probe nor attests remote readiness. The lower-level activation contract remains compatible; complete activation gating on trusted remote adapter evidence remains outstanding.

Default Assignment preparation now shares verification metadata inspection, checking command hash, environment hash, exact registered scenarios, required scenarios and stage tool/capability/network scope before starting a verification Worker. Runtime execution still checks its derived grant and actual executable identity at launch.

### Builder internal budget finalization

Owner-only `POST /api/v1/messaging/operations/:id/builder-accounting` accepts `{request_id,attempt,epoch,expected_revision,price_id,settlement:"internal_price"}`. dsh exposes `/api/kode/builder/accounting` with `{operation_id,command}`. This is explicit confirmation of internal team pricing, not model authority or provider billing. It requires an exact local Builder scope and reported operation; active, uncertain and stopped operations are not silently finalized.

The Hub checks the frozen reservation/price, rejects mixed native usage and unresolved/nonterminal official calls, sums persisted counters and requires the resulting charge to equal the observed debit. Reservation finalization, exact command receipt and owner audit commit atomically. Concurrent identical retries and retries after restart recover the historical receipt; altered commands for that attempt conflict. Output retains `provider_cost_status:"unconfirmed"`, `completion_authorized:false`, and the 团队预算 label. This does not activate a team or declare a workflow complete. Draft acceptance alone does not finish a Builder conversation or release funding. Automatic conversation closure and uncertain-execution reconciliation remain separate lifecycle work.

### Graceful Builder close

Owner `POST /api/v1/messaging/operations/:id/builder-close` persists `{request_id,attempt,epoch,price_id,settlement:"internal_price"}` as an immutable close intent. `GET` returns the intent, current operation and count of accepted inputs without consumed delivery evidence. The intent and new-input admission share the Hub transaction: new free-text inputs and answer-continuation messages are rejected after the fence; identical historical input receipts remain recoverable. The fence survives restart and does not cancel previously accepted input or grant new execution authority.

Owner dsh `POST /api/kode/builder/close` takes `{operation_id,command}`. It returns 202/closing for pending input or execution still running after a bounded wait. Retrying the exact command advances closure. For the exact live binding it waits for idle, reports through the existing guarded runtime, disposes the owned handle and finalizes internal accounting. A historical reported operation permits report-response recovery without repeating inference; a missing active runtime is never silently resumed. A foreign local binding is never disposed. 200/closed includes the accounting receipt; it does not mean team activation or workflow completion. There is no background close retry scheduler in this increment, and crashed/uncertain execution still requires separate recovery.

### Definite Assignment resource waits

The owner Assignment resource reservation endpoint preserves successful receipt behavior. When its transaction definitely rejects admission because account capacity is full or a workspace is held, it now returns HTTP 409 with `code:assignment_account_capacity_exhausted` or `code:assignment_workspace_busy` and the existing human-readable `error`. These responses commit no new resource hold. Missing configuration, revision conflicts, permission errors and other failures retain their existing error handling.

Host WorkRun monitoring recognizes only these codes from HTTP 409 on the exact Assignment resources endpoint as `waiting_resource`. It keeps the Run eligible for bounded monitoring, so another team's release can permit progress without changing the waiting Run's revision or requiring human retry. Arbitrary error text, transport failure, other endpoints and execution uncertainty still become explicit recovery fences. This does not clear historical blocked records with no trustworthy refusal evidence, promise queue starvation-freedom, or automatically increase budgets/capacity.

### dsh collaboration team directory

Owner-only `GET /api/kode/collab/teams` proxies the local home Hub's team configuration directory. List queries accept `after` (team ID, default empty) and `limit` (1–50, default 25); detail queries accept only `team_id`. Duplicate/unknown query keys, mixed detail/pagination and mutation methods are rejected. List responses preserve `items`, `next_cursor` and `home_hub`; detail responses return `team`. Both carry `projection: "configuration_revision"`.

These documents describe saved team revisions, not live execution status: their draft status must not be interpreted as current activation, readiness or running work. Read activation separately through the existing owner activation endpoint and use its explicit revision/authority facts. Reading the directory creates no sessions or work, refreshes no grant and triggers no model. There is no arbitrary backend URL or remote authority parameter. Responses use `no-store`; missing backend/entry and transport failures return sanitized errors without backend credentials/details. A missing entry or unavailable endpoint is HTTP 404; other backend failures are HTTP 503. The bridge does not automatically retry or switch authority to another Hub.

### Team work history

Owner/admin `GET /api/v1/messaging/teams/:id/work-runs` returns `{team_id,home_hub,items,next_cursor}`. Unlike scheduler discovery, this includes terminal runs. Pagination accepts `after` (exclusive run ID, default empty) and `limit` (1–50, default 25), ordered by run ID, not creation time. The cursor is null when no further row was observed. Pages are current reads, not a frozen cross-page snapshot; refresh from the beginning to discover newly inserted IDs before an existing cursor.

Each summary contains run/team/home identity, revision, state, waiting reason, explicit `completion_authorized`, creation/update timestamps, prior-run and Coordinator provenance. Optional request preview is limited to 240 Unicode scalar values; the list excludes full inputs, frozen context and stage payloads. A terminal state alone is not proof of authorized delivery. Unknown teams return 404; non-admin principals cannot read this directory.

Owner-only dsh `GET /api/kode/collab/runs` requires `team_id` and accepts the same `after`/`limit`. It forwards only to the configured home Hub. Duplicate or unknown keys and invalid cursors are rejected, mutation methods return 405, responses use `no-store`, and unavailable backend details are redacted (404 for missing team, otherwise 503). Reading history starts no execution and grants no additional authority.

### Selected stage output read

Admin-only `GET /api/v1/messaging/work-runs/:id/stages/:stage/outputs/:output` reads the current stage's selected immutable artifact/review/verification observation. It accepts an output name, never an arbitrary observation sequence. Missing run, stage or selected output returns 404. The reader checks assignment, stage attempt and frozen context against the selection, then matches observation operation ID, attempt and epoch to the assignment's frozen operation. Mismatches fail closed.

Response includes home/team/run identity, run revision, stage/attempt, assignment ID, output name, sequence and typed `evidence`. `completion_authorized:false` is explicit: retrieving a selected observation is not a stage or delivery verdict. Payload contains stored snapshot hashes or structured review/verification facts; this endpoint neither reads arbitrary files nor follows log/artifact references. Historical attempts remain audit-history work and are not silently returned as the current selection.

The dsh owner bridge `GET /api/kode/collab/evidence` requires exactly `run_id`, `stage_id` and `output`, each once. It forwards to the selected-output endpoint, rejects arbitrary sequence/host parameters and mutations, uses no-store and sanitizes unavailable responses (404/503). The IM reader additionally matches home/team/run, stage attempt, assignment, output and selected sequence before displaying a typed payload. Text references are displayed as text, not followed as URLs or filesystem paths.

### dsh Builder draft recovery

Owner-only `GET /api/kode/builder/drafts` lists the home Hub's saved interviews with `after` and `limit` (default 25, maximum 50), or reads one draft with `draft_id` alone. Duplicate/unknown keys and mixed detail/pagination are rejected. It forwards only fixed Builder draft read paths, returns no-store and sanitized missing/unavailable errors (404/503), and never starts a Builder, accepts a proposal or activates a team.

### dsh Builder answer submission

Owner-only `POST /api/kode/builder/answers` accepts JSON `{draft_id,request_id,expected_revision,answers}` with 1–3 answers, up to 8192 UTF-8 bytes each and 32768 bytes total. Unknown fields, invalid identities and non-owner requests are rejected. It forwards only the existing draft answer command, which commits the answer patch and revision atomically and replays the original receipt for an identical request. Responses use no-store. Ambiguous backend failure returns a sanitized 409 directing exact-request retry; no new request or model continuation is inferred.

The IM form reserves the original command in IndexedDB under home/draft identity before sending. An unresolved command cannot be replaced by edited answers; explicit retry replays that command. Saving answers does not start inference, accept a proposal, activate a team or increase its authority. The client checks returned draft/home/revision and answer values before marking the local record accepted.

### dsh initial Builder interview

Owner `POST /api/kode/builder/create-draft` accepts `{draft_id,request_id,purpose}` (purpose up to 8192 UTF-8 bytes; total body up to 16384). It saves revision 1 with no workspaces, proposal or execution authority and the existing versioned software-team interview, displaying at most three active questions per round. The full plan includes delivery, examples, workflow, resources, budget, permissions, verification, failure handling and concurrency, with conditional defect-reproduction questions. These free-text answers do not grant capabilities or prescribe a fixed delivery endpoint. Draft/request identity is reserved in browser IndexedDB before dispatch and reused unchanged after uncertain replies. Successful receipt must match home, draft, request, purpose, revision 1 and `eligible_for_execution:false`. This endpoint never starts a Builder or Worker, reserves execution budget or activates a team.

### Builder workspace intent

Admin `POST /api/v1/messaging/superagents/drafts/:id/workspaces` accepts `{request_id,expected_revision,workspace_refs}`. References use the existing `{host_id,workspace_id,root_ref}` structure; at most 64, without repeated host/workspace pairs. The command atomically updates the interview revision and exact-request receipt, retains answers, and clears old inspections/proposals when the workspace selection changes. Revoked drafts and stale revisions fail; altered reuse of a request ID conflicts. Replay after restart returns the original receipt. References are configuration intent, not proof of availability, filesystem access or authority.

Owner `GET /api/kode/builder/workspace-directory` lists registered Hub nodes; optional `node_id` reads that registered node's workspace metadata and projects canonical workspace references. Unknown nodes, duplicate/unrecognized parameters and mutations are rejected. Remote unavailability stays a sanitized 503, never an empty successful discovery. No arbitrary SSH host is accepted and no runtime is started.

Owner dsh `POST /api/kode/builder/workspaces` forwards `{draft_id,request_id,expected_revision,workspace_refs}` to the atomic workspace-intent command, with bounded JSON and strict fields. The UI reads registered workspace references, retains selected references if discovery fails, and persists the original command before dispatch. Ambiguous failure permits exact retry only. Canonical paths returned by the registry are preserved; saving does not confer access or imply that a previously registered remote workspace is presently reachable.

### Builder patch conflict recovery

Admin `GET /api/v1/messaging/superagents/drafts/:id/patch-status` accepts `kind=answers|workspaces`, `request_id` and positive `expected_revision`. Under the Store lock it reads the command receipt and latest draft. It returns `recorded` with the stored request/receipt, `rejected_revision` only when no receipt exists and the draft has advanced past the expected revision or is revoked, otherwise `unconfirmed`. An unconfirmed outcome is not permission to discard/reidentify a command.

Owner dsh `/api/kode/builder/patch-status` adds `draft_id` to the same query and enforces exact fields. The browser matches home/draft/kind/request/revision before displaying recovery. After `rejected_revision` without a record, an explicit user action retires the local pending slot with disposition `rejected_revision`, preserves original inputs, and refreshes the draft. A subsequent user submission uses a new identity. Recorded commands still recover by exact retry; unknown outcomes retain the original pending record. No automatic rebase or resubmission occurs.

### dsh current team budget projection

Owner `GET /api/kode/collab/budgets?team_id=...` reads the team's current configuration, its budget policy and linked budget accounting. It returns team/home/revision identity, policy revision and separate budget records with scope, unit, period, total/spent/reserved/available, estimated and internal-price charged amounts. Missing policy is explicit `policy_missing`; failed or mismatched reads return sanitized 503 rather than synthetic zero balances. Shared budgets remain separately labeled, and different units are never aggregated. This is a current read across endpoints, not an activation snapshot or execution-admission guarantee.

The IM budget panel permits explicit total-limit adjustment for a policy-linked budget owned by the current team. It preserves the immutable unit and period, displays a review step before confirmation, and reserves a home/team/budget-scoped request in IndexedDB before dispatch. Recovery first reads the exact owner budget receipt; a recorded request must match all command fields and the result identity, with `activation_performed:false`. Only an explicit null receipt permits the same POST. Shared budgets are read-only in this panel. This is not new-period funding, a provider top-up or automatic team activation.

Creation retries first read the original draft-command receipt and preserve its selected questionnaire version, including older intake versions. A same-identity changed purpose conflicts. New creation does not truncate the existing complete questionnaire to the first displayed round; subsequent owner answers advance through the persisted plan.

### dsh Builder model discovery

Owner GET `/api/kode/builder/models?provider=...` reads public model metadata from an already registered official LLM provider. Adding `model=...` resolves exact-model reasoning metadata through the adapter. Unknown/removed providers return 404; invalid or duplicate parameters return 400; discovery failures/timeouts return sanitized 503. Responses are no-store, carry home/provider identities and `eligible_for_dispatch:false`. Only model ID/name/provider and declared reasoning IDs/names/default are returned; provider settings are not exported. A 10-second response deadline does not cancel a catalog adapter whose listModels API has no cancellation argument; no inference is requested. Model discovery is advisory, independent of account quota, pricing, grant and budget admission.

The Builder resource panel exposes on-demand discovery for registered official providers. Reading or inspecting a model does not persist a selection, reserve funds or start a runtime. Unspecified reasoning metadata is shown as undeclared rather than inferred from model names.

### Builder default resource proposal

Owner GET `/api/kode/builder/default-selection?draft_id=...&revision=...` proposes a Builder selection from public registered resources. It uses explicit Builder overrides, the current official default model selection and execution profile defaults, or a unique available choice. Ambiguity returns `needs_configuration`; catalog order and model names do not imply suitability or price. Kode executor routes are not substituted for official provider identities. Allowed-model and declared effort constraints remain enforced.

The route binds its proposal to the current open home/draft/revision and rechecks public resource/default snapshots after metadata lookup. It has a 10-second response deadline; catalog adapters without cancellation may finish later. It returns `eligible_for_execution:false` and makes no selection, account, budget, grant, session or team writes. The UI fills an unsaved proposal only when no saved or pending selection exists, retains manual configuration, and requires explicit saving before subsequent startup admission. Backend admission remains authoritative.

### Builder runtime selection intent

Owner GET/POST `/api/v1/messaging/superagents/drafts/:id/selection` reads or persists a Builder runtime choice. POST takes `request_id`, selection `expected_revision`, `draft_revision` and a typed selection (`profile_id`, `provider`, `model`, nullable `effort`, exact draft `workspace`). The Hub atomically checks the live draft and selection revisions, verifies workspace membership and stores both latest intent and an immutable request receipt. Same-request retries recover the historical receipt even after later edits or restart. Worker access is denied. GET exposes current draft revision/status alongside the saved record's draft revision so a stale choice remains visible without implying currency.

The owner dsh bridge is GET `/api/kode/builder/selection?draft_id=...` or POST with the same fields plus `draft_id`. Unconfirmed writes require retrying the original command. These records are configuration intent only (`eligible_for_execution:false`): they do not prove resource existence, model support, quota, permission or budget admission. No session or team is created. Selection form integration and consuming the confirmed selection during startup are separate work.

The Builder UI now persists that runtime intent using a separate home/draft IndexedDB command slot before POST. Unknown outcomes retain the original command and both revisions; successful receipts must match exact selection fields and remain ineligible for execution. Reopening restores the Hub record without writing. The form lists registered local controlled dsh profiles, official provider metadata and local draft workspaces; it does not configure the future team's Worker roles. A changed draft revision is displayed for reconfirmation. Startup consumption, funding/permissions and definitive stale-selection conflict recovery remain separate work.

Builder owner starts may carry `selection_revision`. The Host derives `start.selection_ref` from that revision, the original draft revision and the actual requested provider; callers cannot inject an independent nested reference. The Hub checks the latest persisted selection and its exact profile/model/effort/workspace inside the funding transaction. It requires the initialized draft to be the next revision and to preserve the selected interview (legacy questionnaire initialization is the only allowed questionnaire/questions addition). Mismatches fail before reservation. Historical start receipts are recovered first, so later selection edits cannot alter a committed start. Existing starts without the optional reference retain their prior API behavior; the new IM startup path must send it. This binding does not replace normal resource/account, model, grant or budget admission.

### Builder creation funding confirmation

Owner GET/POST `/api/v1/messaging/superagents/drafts/:id/funding` reads or confirms the initial creation budget. POST takes request_id, draft_revision, selection_revision, unit, positive limit, starts_at/ends_at and explicit integer input/cached/output prices per million tokens. In one transaction it checks the current draft and selected home workspace, creates a team-scoped creation budget, a requested-model internal price version and a minimal read/builder_draft_write grant limited to the seven Builder tools and selected workspace. The grant expires with the budget and denies tool network access. IDs are derived from home/draft/request identities. Any failure rolls back all three records.

Responses label this as 团队预算 with purpose builder_creation, zero initial reserved/spent, execution_started:false and activation_performed:false. Prices are user-supplied internal accounting, not vendor prices or balance claims. Confirmation records are historical snapshots, not current available-balance reads. Original requests recover the exact record after restart or subsequent draft changes; another initial confirmation for that draft is rejected rather than creating additional funds. Budget/price/permission reconfiguration and expired periods require a separate explicit flow, not a new initial request. Existing operation admission still governs any reservation and execution.

The dsh owner bridge is GET `/api/kode/builder/funding?draft_id=...` or POST with these fields plus draft_id. It bounds JSON, rejects injected authority fields and non-integer amounts, and preserves same-request retry semantics. The frontend provides explicit review/confirmation; startup integration remains pending.

The creation budget form requires a unit, positive integer limit, future expiry and explicit integer internal prices. Review reads the current saved selection and freezes its revision, selected model/workspace, pricing and period; it does not mutate the Hub. Confirmation reserves the original command plus selection snapshot in IndexedDB before POST. The response must match that snapshot, original request values and exact minimal grant scope before local acceptance. Lost replies reuse the original command regardless of subsequent supplied values. The saved summary is labeled an initial confirmation snapshot, not current provider or spendable balance. This flow does not start inference.

### Builder startup planning from confirmed configuration

Owner POST `/api/kode/builder/start-plan` accepts draft_id, command_id, request_id, owner_session, session_id, candidate team_id, reservation amount, explicit limit_ids and unknown_quota (`require_fresh` or `team_budget`). It assembles the existing start command from the current saved selection and initial funding confirmation. Planning checks exact draft/selection identity, registered local workspace, executable profile fingerprint, adapter model configuration, current budget availability/period, unchanged grant and current resource-account binding. It neither reserves funds nor creates a session. Returned dispatch_authorized is false; quota policy is explicit, not an inferred provider balance. The existing atomic start remains the final resource/grant/budget authority.

The returned command includes selection_revision and all immutable startup identities. Frontend durable confirmation and account/bucket onboarding remain to be connected; callers must retain the same command when submitting or recovering a start. The planner does not silently replace stale funding configuration, create accounts, fabricate quota buckets or decide an unknown-quota policy.

The browser startup command helper reserves the exact confirmed command in a home/draft IndexedDB slot before POST `/api/kode/builder/start`. Only a matching official `created` receipt (session/command/profile/model/effort/workspace/Builder scope and tool set) is accepted. Uncertain or mismatched responses leave the original intent pending. A terminal `created` slot retains the receipt and is deliberately not replaceable by the generic outbox's accepted-slot reuse behavior. Reopening/retrying that slot returns the original creation receipt rather than issuing a new start. This is historical creation evidence, not proof that the runtime is currently live or that any conversation has been consumed. The helper is tested with the native runtime but not yet mounted in the frontend startup controls.

Builder startup controls now generate internal identities, discover the selected profile's known quota windows and prepare a read-only plan for explicit confirmation. Default policy requires fresh quota; the owner may explicitly allow unknown quota under team-budget constraints. Missing account binding prevents planning. Confirmation sends the fixed persisted command; uncertain outcomes expose original-request recovery. Restored local created receipts are identity-validated and labeled historical creation evidence rather than runtime liveness or completed configuration.

Resource policies may have no window or monetary requirements only when unknown_quota is explicitly team_budget. Such admission always returns unknown_requires_team_budget (never fresh_quota), requires a current account binding and a budgeted operation, and rejects any currently known exhausted window for that binding. This avoids fabricating a quota-window ID for providers without quota telemetry. Require-fresh with no requirements remains invalid. Empty policies confer no provider balance assertion.

The created Builder surface now mounts an owner conversation view. Outgoing text is bounded to 16 KiB and stored with original request/operation/attempt/epoch/draft identity before submission. Queued receipts must match exact request content and worker/home identity; queue acceptance is not presented as model consumption. Unknown results keep the original text for explicit retry. Read-only conversation polling runs while visible, advances validated event/text cursors, follows bounded long-text fragments and retains prior content on errors. Only user/assistant text is rendered; creation receipts do not trigger inference. Full cross-device discovery and cold-runtime input/resume management remain separate work.

The Builder proposal surface displays the proposed team type/purpose, workspaces, execution targets, coordinator choice/startup, Worker responsibilities/capabilities/resources, workflow/project/delivery references, policy references and concurrency/proactive settings. Review freezes the displayed draft revision; explicit acceptance calls the existing accept-proposal owner route with a durable original request and target team identity. The client checks the exact canonical team specification, team/home/revision and non-executable receipt before recording success. A saved slot is not reused to create another team. Acceptance remains a team-draft operation; referenced policy contents and activation readiness still need separate inspection. Proposal updates to an already accepted team are not yet exposed by this initial-acceptance form.

### dsh reviewed activation controls

Accepted Builder proposals expose owner activation review and confirmation through the existing team routes. The browser persists the exact reviewed command before submission, retries the original command after an uncertain result, and checks the returned home/team/revisions/grant/policy references before recording success. Restored confirmation records are historical, not evidence of current execution admission. Review issues or incomplete Host adapter readiness suppress the confirmation control; the Host and Hub remain authoritative for all activation and live admission checks.

The dsh deactivation control reads the current activation revision before owner confirmation and durably retains the exact deactivation command until a matching inactive receipt arrives. Snapshot/configuration identity must match the reviewed activation. Withdrawal of activation authority is not an attestation that in-flight work has stopped; cancellation and terminal evidence remain separate.

### Builder account grouping confirmation

Owner `POST /api/v1/messaging/superagents/drafts/:id/account` accepts `request_id`, `draft_revision`, `selection_revision`, `account_id`, `account_epoch`, `create_account`, and `expected_binding_revision`. Host/profile derive from the saved local Builder selection; the browser cannot inject them. Optional creation starts an enabled account at epoch 1 only, and account creation plus version-checked binding commit atomically. Existing-account binding never rotates its epoch. Selection/draft/workspace validation precedes changes. Exact immutable receipts precede live validation on retry; a conflicting reuse of request ID fails.

Owner `GET /api/v1/messaging/superagents/drafts/:id/account-requests/:request` returns the historical receipt, not current quota or balance. dsh exposes the fixed owner bridge `/api/kode/builder/account` (GET requires exact draft/request IDs; POST includes draft_id). These actions do not start execution, create a team, or fabricate provider quota. Quota status remains `not_checked` until independently observed.

Workflow-derived owner grant proposals include read/delegation and the fixed control tools for a Coordinator even when its explicit Worker list is empty, because Coordinator startup and workflow creation require delegation. Saving a new authority bundle does not activate it. An active but older activation snapshot requires renewed explicit activation confirmation when team/grant/policy versions differ; an unchanged active snapshot does not.

Owner team budget confirmation optionally accepts `initial_policy: { max_assignment_charge }`. This is limited to a new budget (`expected_revision: 0`), a positive per-assignment cap within its limit, and an absent policy at the team's existing budget_policy_id. Budget and initial policy commit in one transaction and share the original request receipt. Existing policies require their own reviewed update; this option cannot replace them. The dsh initial-budget form exposes explicit review, confirmation and original-command recovery. It creates neither a grant nor activation, and never represents provider credit.

### Owner scheduling setup

`GET /api/v1/messaging/teams/:id/scheduling-options/:revision` returns the version-matched team, current account bindings/quota observations, and up to 20 exact host/profile/model/revision capability records per target with explicit truncation flags. The response is bounded to 1 MiB and is never an execution admission. Missing capability evidence is not synthesized.

`POST /api/v1/messaging/teams/:id/scheduling` accepts `{request_id,team_revision,policy}` with the team's referenced scheduling policy write. The Hub checks full target coverage, resource/account identity, enabled current account epochs/binding revisions and actual capability-record model identity inside the write transaction. It records an immutable request/result and human audit event without activation. Exact retries precede live checks; new requests cannot reuse stale policy versions. `GET .../scheduling-requests/:request` returns its receipt. dsh exposes these through the fixed owner-only `/api/kode/teams/scheduling` bridge.

Team resource confirmation optionally accepts `reuse_binding: true`. It cannot be combined with account creation. The transaction requires an enabled current account and an exact existing host/profile/account/epoch/revision match, saves the assessment, and leaves the shared binding revision unchanged. Successful responses explicitly mark binding_reused. Original receipts remain recoverable after later invalidation without re-enabling the binding. Existing callers omit the field and retain binding-write behavior.

The dsh scheduling setup offers explicit user capability assessments (task fit, optional cost/latency preferences, confidence, evidence, validity, pinning). They remain user declarations and never provider prices or measured capability. Initial evaluation creation currently targets capability revision 1; selecting existing revisions remains supported. Updating higher-version or pinned assessments requires a separate explicit update flow.

### Builder candidate policy names

Scoped `kode_builder_read_draft` adds `candidate_configuration` for its fixed home/candidate team. `proposed_policy_ids` supplies deterministic bounded names for a new grant, budget policy and scheduling policy, derived from that identity. `configuration_created:false` and `eligible_for_execution:false` explicitly mean this read creates no records or authority. These are proposed names, not evidence that a policy exists or its name is reserved. Existing selected policy references should be preserved. Owner configuration endpoints still verify team/revision, existing-record conflicts and explicit confirmation before writing budgets, scheduling or grants. Builder procedure `kode.builder.interview.v2` explains this distinction and requires actual catalog/details checks before claiming readiness.

### Initial team budget settlement selection

The owner team-budget command's optional `initial_policy` accepts optional `settlement:"internal_price"` alongside `max_assignment_charge`. Omission preserves legacy policy serialization and behavior. Unsupported settlement strings fail policy validation and roll back the entire initial allowance/policy transaction. The explicit field participates in immutable request identity and restart replay. It does not create resource price versions, imply provider invoicing, reserve budget or activate the team. The initial-budget UI presents this as an unchecked owner choice and shows the selected mode before confirmation; resource prices must still be configured separately.

### Atomic scheduling price configuration

Owner scheduling confirmation accepts optional `internal_prices`, a map from configured target ID to an immutable internal Price. Empty/omitted maps retain legacy wire receipts. Each supplied price must match that target's `internal_price_id`, requested model and the current same-team budget policy's unit; that budget policy must select `internal_price` settlement. Foreign/unreferenced targets or admin-attested price attribution are rejected. Existing immutable-price conflicts retain their refusal behavior.

Price versions, scheduling policy, exact request receipt and audit event commit in one Hub transaction. Any policy or price failure rolls them all back. Exact retries recover before current-state checks, including after restart; conflicting request reuse fails. A successful receipt adds `internal_prices:{label:"内部计价",provider_invoice:false,prices:{...}}`. This configuration does not reserve/charge budget, alter existing activation snapshots or activate a team. The dsh owner bridge forwards the optional map; browser creation controls are a separate integration step.

The scheduling UI now exposes optional per-target internal price input. Explicit rates and generated immutable IDs are frozen in its durable command before submission; response loss retries that original price map. Confirmation verifies the exact price receipt and internal/not-provider-invoice labels. Unchanged targets retain existing price references. Prices are displayed with budget unit and per-million-token basis before saving; no resource execution or activation follows automatically.


### Team resource preflight: account assignment capacity

Builder and activation resource preflight target rows include `assignment_capacity` with `scope: account_shared_across_teams`, `configured`, `snapshot` (null or account_id/revision/max_active_assignments/held), and `eligible_for_execution: false`. Top-level `assignment_capacity_checks_complete` reports configuration coverage only; `assignment_capacity_issues` lists `assignment_account_capacity_missing` per target. A configured capacity is not a provider quota, a free slot guarantee or authorization. Reads do not configure limits or reserve slots; dispatch retains its authoritative capacity admission. This additive diagnostic does not change the activation command contract.


### Optional account capacity in scheduling confirmation

Owner team scheduling commands may include `account_capacities`, keyed by account ID; each value is `{account_id, expected_revision, max_active_assignments}`. Only accounts belonging to configured team targets are accepted. Capacity uses existing compare-and-set and active-hold bounds, and commits atomically with scheduling, optional prices and the durable request receipt. Result `account_capacities` has `scope: account_shared_across_teams` and a `capacities` map of resulting snapshots. Exact historical retries return the original receipt and never reapply limits over newer revisions. Scheduling options include each target's current `assignment_capacity` snapshot or null. Limits are explicit owner configuration, not inferred provider quota; omitted maps preserve existing commands.


### Activation requires configured assignment capacity

New activations require an explicit assignment capacity for each configured execution target's account. Activation review returns `assignment_account_capacity_missing` issues and no prepared command while a capacity is absent. The home activation transaction rechecks configuration; it creates neither capacities nor holds. A configured account being busy does not prevent activation; live dispatch handles contention. Exact historical activation retries still return their immutable receipts before current-state checks.


### Coordinator accounting finalization

Owner-only `POST /api/v1/messaging/operations/:id/coordinator-accounting` accepts `{request_id, attempt, epoch, expected_revision, price_id, settlement: "internal_price"}`. It requires the exact reported local Coordinator operation and immutable control binding, bound reservation/price, finished reconciled official calls and matching cumulative charge. Mixed/native or unresolved usage is refused. It finalizes the reservation at the recomputed configured internal charge and releases the unused hold atomically with the durable receipt/audit. Exact per-attempt replay precedes live checks; different commands conflict. Receipt includes team/control identity, calls and settled reservation, `provider_cost_status: "unconfirmed"`, and `completion_authorized: false`. This endpoint does not initiate draining or close a running executor; automatic Host closure remains separate work.


### Coordinator close intent and drain

Owner-only `GET/POST /api/v1/messaging/operations/:id/coordinator-close` reads or records a durable close intent. POST accepts `{request_id, attempt, epoch, price_id, settlement: "internal_price"}` and requires the matching local Coordinator execution and bound price. Historical identical requests replay; conflicts are rejected. GET returns intent, operation, pending_inputs and pending_runs. The fence rejects new human-input dispatch to this operation, while preserving conversation messages and existing delivery retries. Accepted deliveries and run updates drain normally. Pending runs include nonterminal runs and terminal runs whose latest notification has not been consumed. The Host close method waits/rechecks before report/dispose/finalization; it never implicitly resumes a missing runtime. Accounting refuses unresolved drain state. Automatic lifecycle scheduling is not supplied by these endpoints alone.


### Pending Coordinator close discovery

Owner-only `GET /api/v1/messaging/coordinator-closes/pending?after=<opaque cursor>` returns `{home_hub, items: [{operation_id, command}], next_cursor}` with at most 32 unresolved durable close intents. Finalized accounting attempts are excluded. Cursors are bounded close-document keys, not operation authority. The mounted Host recovery service replays the validated close command and preserves blocked/error cases for later scans; discovery never resumes inference or changes budgets. Idle-close initiation remains separate.


### Coordinator idle-close lifecycle

The owner Coordinator close command accepts optional `idle_only` (default false). GET close state includes `idle_close_ready` as a hint; POST rechecks readiness in the same transaction as the durable close fence. Pending/unanswered human requests, unconsumed deliveries, unfinished WorkRuns or missing terminal replies, superseded control, and unresolved official calls prevent idle close. Ordinary explicit close may persist an intent while work drains. The flag belongs to the close command, not the final accounting command.

The mounted Host close-recovery service may initiate idle close only for its owned current local Coordinator under active authority and confirmed `internal_price` policy. Its request identity is deterministic per operation/attempt/epoch. Durable pending intents are retried independently of live handles; this service never creates or resumes inference. New human messages remain stored while a predecessor closes and are subsequently routed by bootstrap/recovery.


### Team directory search

Owner GET `/api/v1/messaging/teams` accepts optional `q` alongside `after` and `limit`. Search is bounded to 160 UTF-8 bytes, rejects NUL, trims outer whitespace and matches literal substrings in current team name/purpose (SQLite ASCII case folding). `%` and `_` are literal characters. Filtering precedes stable ID pagination. Omitted/empty query retains the original directory behavior; search does not modify team revisions, conversation state or execution. The dsh owner bridge `/api/kode/collab/teams` forwards this query and rejects combining it with `team_id`.


### User-visible conversation read position

The dsh owner-only bridge `/api/kode/conversation/read-state` accepts GET with exactly one `conversation_id` query parameter, or POST JSON `{conversation_id, through_sequence}` with no query parameters. It rejects principal overrides, unsafe/non-integer/negative positions and oversized bodies. An unconfirmed response returns `retry: same_position`; clients can read the durable position or repeat the same write. The Host registers and disposes this route independently of runtime message consumption.

Owner GET `/api/v1/messaging/conversations/:id/read-state` returns home_hub, team_id, conversation_id, principal_id (`local_owner`), through_sequence, latest_sequence and unread_count. POST accepts only `{through_sequence}`. Nonzero sequence must belong to the conversation; future/foreign sequences are refused. Cursor updates are monotonic and idempotent, with one audit event per actual advance. Unread counts only incoming visible messages after this position, excluding local owner's own messages. State survives Hub restart and never acknowledges runtime delivery, consumes Coordinator input, cancels work or changes authorization. UI must mark only messages actually presented/read, not infer reading from Worker consumption.

### Cancellation decision attribution

Owner-only WorkRun cancellation commands record `{kind: "human", id: "local_owner"}` as the decision actor, independently of the WorkRun's original `owner` (which may be a Superagent). Request cancellation records that actor in its durable intent and affected operation/run events. Direct never-dispatched and settled cancellation likewise attribute the decision to the owner. Evidence-based finalization records `{kind: "system", id: "cancellation_reconciler"}` while retaining the cancellation intent; it is not a second human decision. Existing command receipts and historical audit events remain immutable on exact replay.

### Configured human delivery acceptance

DeliveryPolicy may set `human_acceptance: true`; absent/false retains prior serialization and behavior. This is part of the frozen project-config hash. After all ordinary delivery checks pass, delivery finalization records exact evidence and enters `waiting_user` with `human_delivery_acceptance_required`, keeping `completion_authorized: false`.

Owner POST `/api/v1/messaging/work-runs/:id/delivery-decision` accepts `{request_id, expected_revision, evidence_hash, choice: "accept" | "reject", reason}`. It requires the pending frozen policy/gate and exact evidence/revision; Worker principals cannot call it. Exact retries return the durable original receipt, conflicting requests fail. Acceptance queues another full delivery validation; it never directly completes work. Rejection remains `waiting_user` with `human_delivery_rejected`. Changed evidence requires fresh acceptance; no waiver of required review/verification, authority or budget evidence is granted. Final delivery receipt includes the accepted human decision when required. UI onboarding/decision controls and full native acceptance validation are still being integrated.

The dsh owner bridge is POST `/api/kode/work-run/decision`, with the Hub decision fields plus `run_id`. It rejects unknown authority fields, query parameters, invalid hashes/revisions/choices and oversized reasons. Unconfirmed writes return `retry: same_request`. Frontend decision storage is scoped by home Hub, team, run, gate revision and evidence hash; retry retains original request/choice/reason, and accepted receipts do not imply WorkRun completion.

### Human conversation follow-up reference

Owner conversation send accepts optional `prior_run_id` (valid identifier). It must identify terminal work in the same team; intake rejects missing, active or foreign work before accepting a new message. Exact request replay returns its historical receipt, including lineage, and changed or omitted lineage conflicts. Coordinator workflow authorization must preserve an explicitly linked human input. This does not reactivate old work or bypass current workflow, grant or budget checks. The frontend outbox stores lineage with the original request and validates it on recovery receipts.

### Coordinator human-feedback status projection

The scoped workflow-status tool returns original inputs, prior_run_id and a bounded human_acceptance summary (state, revision, evidence_hash, requested_at and recorded decision). Acceptance evidence bodies are explicitly omitted with evidence_included=false. Decision reasons remain human task data and confer no additional authority. Existing same-team checks, pre/post runtime authority validation and the 64 KiB whole-result limit apply. A saved acceptance is not completion_authorized; final Hub validation remains mandatory.


### Builder current execution metadata (catalog projection)

The existing scoped `kode_builder_catalog` accepts `kind: current_execution`, empty `after_id`/`after_version`, `limit: 1`, and the exact current `expected_revision`; `command_revision` is forbidden. This retains the seven-tool Builder grant. The Host verifies the fixed local draft, active managed Builder binding, exact operation attempt/epoch/worker and selected model, then returns only this Builder's profile ID/revision, provider/model/effort, and same-profile current account grouping. Executor arguments/environment, credentials, unrelated profiles/accounts and other teams are not projected.

The result is an optional candidate basis for a separately owner-reviewed team configuration, not a Host-wide resource inventory, a role recommendation or Worker permission. `role_fit_status: not_assessed`, `quota_status: not_checked` and `eligible_for_execution: false` are explicit; current account grouping is not proof of supplier balance. Capability assessment/revision, Worker grants, prices, account capacity, budgets and runtime admission remain independent required configuration. Missing metadata is not replaced with invented values. Builder procedure v5 documents these limits.

`current_execution.capability_configuration` also exposes the supported future `proposed_initial_revision: "1"`, with `configuration_created: false` and `requires_owner_assessment: true`. It permits an explicitly incomplete proposed target to enter owner configuration; it does not resolve an existing capability profile or bypass the owner assessment form, scheduling revision checks, preflight or activation.


### Local Git artifact prerequisites at activation

The product Host now awaits read-only artifact readiness during Builder preflight and owner activation review/new activation, after validating the same frozen configuration. A stage using `kode_capture_output` requires its repository to match an explicitly selected local workspace, be a canonical Git root, and have an existing HEAD commit/tree. Missing baselines remain blocked; the Host never initializes Git or creates a commit as part of preflight. Remote artifact roots are explicitly unchecked. Exact historical activation receipt recovery still runs before current filesystem/runtime checks. Artifact content/evidence, executable identity and live grant/resource admission remain execution-time checks.


### Fresh derived transcript with initial official policy metadata

Derived Assignment admission retains `official_fresh_empty` with literal event_count0 and no policy_metadata. Full desktop official initialization can instead attest `official_fresh_policy_metadata`: event_count is the actual1–3 events, policy_metadata.event_types are unique members of permission/preset, sandbox/mode, approval/policy, and event_hash is SHA256 of the full initial event records. The Host requires fresh/unseeded identity and unchanged attestation before/after durable flush, workspace lock and home admission. No user/assistant/system/tool or other plugin history is admitted.

This extends context evidence only; the same worker, operation epoch, immutable input hash, derived snapshot, grant/model/tool/lease and final source-selection checks remain mandatory. Final-input validation uses the same strict context validator. Policy metadata is retained in audit; it is not relabelled as zero events or treated as task data. The new attestation requires a supporting home Hub; there is no legacy zero-count fallback after rejection.


### Coordinator reply causal WorkRun update

Host run-update inputs retain a trusted source form kode-coordinator-run-update with exact run/revision/team/conversation/original-human reference. The model publication schema remains request_id/source_message_id/content. Host infers a source_update only from its actual most recent consumed input, rereads the canonical Home notice/message, validates its operation/control/worker and content, and confirms durable consumption before posting. It never infers authority from quoted human text. Exact historical publication receipt recovery precedes fresh-context inference.

Home Publish optionally accepts source_update{run_id,revision}; it must resolve to an existing same-scope consumed notice. Replies retain in_reply_to for the original human input, use source_delivery_id for the actual notice cause and preserve source_input_delivery_id for the human cause. Replies without an update keep prior semantics. This lets the existing idle-close requirement prove a final Run notice was actually answered; it does not waive final status, usage, consumption, grant or settlement checks.


### Owner WorkRun recheck receipts

`recheck_execution` is an owner command on the existing Home WorkRun endpoint, with stable request_id, expected_revision and reason. It appends one execution_recheck_requested event/revision without changing frozen stages, Assignments, permissions, budget, stop or completion. Pending human decisions, cancellation and terminal work reject new intent. Historical exact request receipts precede live state checks.

Owner/admin GET `/api/v1/messaging/work-runs/:id/commands/:request` returns snapshot `work_run_command_receipt.v1` with Home/team/run/request, current run revision/state and either the exact canonical command+result or null. A single SQL snapshot is required: separate receipt/version reads are not equivalent. Only null receipt plus a strictly later revision proves the older CAS command can no longer commit. Same-version absence remains uncertain/retryable with the original identity. Offline, unsupported, malformed or foreign replies prove nothing. Receipt retention must preserve this append-only/negative-proof invariant; deleting history without a tombstone cannot retain the same contract. Host proxies it through owner-only GET `/api/kode/work-run/receipt`. No Agent receives owner mutation or receipt-reading authority from this interface.


### Prepared input provenance and Home trace

Official-call Begin optionally accepts prompt_provenance with schema_version1, source official_prepared_input, system_sha256, system_messages and optional instruction. This is a trusted Host report of the actual prepared model input, not provider-side execution/interpretation attestation. Only hashes/versions/references are transported; no prompt bodies. Absent fields in historical/ordinary calls remain valid and visibly incomplete. A known Builder/Coordinator version is recorded only when its marker occurs in actual system input. Worker instruction uses the already validated immutable mandate format, effective input hash, assignment_id, message_id and mandate_sha256; Home checks assignment/operation and its canonical mandate receipt. Original-call identity includes this metadata, so changed proof is an identity conflict and nested receipt recovery must deep-compare values.

Owner/admin GET /api/v1/messaging/work-runs/:id/trace supports a fixed manifest and twelve scoped views. It is read-only; Workers cannot read it. Membership is anchored by per-view watermarks and a run revision; mutable existing records reflect their current contents. Source scopes explicitly identify shared Coordinator operations, shared human requests and team history; shared usage is not allocated to individual work. The redaction policy hides credential/environment/argument fields before search. Archive references report expected records, content hash/size and availability, not raw artifact/log bytes. Optional current effective prompt proof is exported as recorded; missing historical instructions are counted explicitly, never inferred from current code. Host owner proxy GET /api/kode/work-run/trace preserves Home/team/run scope.

Search cursors advance over scanned nonmatching rows; an empty page can have a next cursor. Client full export chunks have hard byte/record limits and validated cumulative per-source counts; continuation is bound to the exact manifest. Only a final complete part plus its preceding parts constitutes the full anchored export. This does not imply that remote-only unarchived data is available, or that raw archive payloads were included.


### Tool input/output content identity

Terminal tool evidence optionally carries io {schema_version:1,input,output}; input/output hold encoding (json_utf8 or js_undefined), SHA256 and UTF-8 byte count only. Host persists input identity before tool dispatch, adds observed output identity after return (also for a normalized error), and retains null output when no result was observed. These records never store raw arguments/results. The existing worker_session/call_id/operation/attempt/epoch link identifies the controlled execution-session transcript; raw tool payload availability is execution_session_only, not an implied Home archive. Necessary delivery artifacts and verification command logs retain their separate completed Home archives. Hashes prove recorded content identity, not successful side effects; uncertainty and resolution requirements are unchanged.

Home validates optional observation bounds, includes them in exact immutable receipt identity and retains old metadata-only evidence without backfill. Outbox recovery deep-compares nested values. Current Host+Home are tested together; optional additions are backward-compatible with old stored records/requests, not a claim that an older deny-unknown-fields server accepts a newer request. An unsupported/mismatched receiver fails closed and pending audit must reconcile before further execution. Ordinary legacy message transport remains separate from full managed-collaboration admission.

Trace manifest retention states home_persistent_no_automatic_expiry for Home records and completed archives; owner deletion is not currently supported. This is independent of transport expiry. It does not promise survival after external database deletion or preservation of unarchived remote session payloads. Future cleanup requires explicit missing ranges/tombstones and must preserve command receipt negative-proof semantics.


### Home-wide named verification resources (schema29)

Frozen registered ProjectCommand references may declare up to16 unique opaque exclusive_resources IDs. Home derives the assignment union from those references, reserves it atomically with account/workspace holds, and enforces one held assignment per resource ID across execution Hosts. Nonempty assignment admission must send the exact names and exclusive_resource_scope="home"; absent/foreign scope is refused. Host kernel leases add cooperative local exclusion and must remain held until process stop is confirmed. Stop requests and expiry never independently release uncertain ownership. Empty declarations preserve historical request hashes.

Schema29 replaces the experimental v28 Host-scoped partial unique index with a Home-wide index. If any v28 named holds remain active, upgrade refuses and preserves both the original database/version/rows and consistent backup. Confirm release through the original runtime before upgrading; never delete holders to force migration. Independent physical resources require distinct IDs. Cross-Home high availability and uncooperative/manual processes are outside this exclusion contract.


### Fresh-session Coordinator publication after custody transfer

A new runtime Session may hold the exact direct-successor control and adopt the existing WorkRun. Its original human intake remains addressed to the original Session and must not be copied/re-consumed. Publication authority is derived from the immutable intake plus audited transfer. If the current Session differs from the intake recipient, publication additionally requires source_update referencing that transferred run and a Hub notification consumed by the current operation/attempt/epoch/control/worker. Both Host tool and Home validate this requirement; authority alone never permits a fresh Session to publish without observing its own update. Historical creation/publication receipts remain exact read-only recovery and do not restart the original runtime.


### Selected-project CI and skill observations

The Builder inspection tool accepts at most eight explicit locations from the fixed project-document selector set. Supported nested locations are .github/workflows, skills, .agents/skills, .codex/skills, .claude/skills and .codex-plugin/plugin.json. The additional root CI document is .gitlab-ci.yml. The owner-facing request carries only a registered workspace identity and selectors. The Host checks the selected draft workspace and granted operation before resolving its canonical directory.

The bundled kode-session-server provides an isolated --inspect-project stdin mode. It returns bounded JSON and finishes before loading service configuration or administrator tokens. The Host supplies its observed directory device/inode identity. On macOS/Linux the reader verifies that identity, opens each directory component with openat/O_NOFOLLOW, refuses linked leaf files and non-regular files, and reads at most64KiB per file. Inventories stop at128 directory entries and56 returned facts, with a256KiB serialized fact budget. The Host process enforces a15second timeout and512KiB output bound. Supported manifests retain exact UTF-8 content hashes and observation times as untrusted project data.

DirectoryScanned and DirectoryPartial serialize as directory_scanned and directory_partial in Builder facts. Complete supported inventories and explicit missing directories supersede their earlier active-cache members. Historical draft revisions and command receipts retain the original observations. Partial inventories retain prior members and may update only selected observations. Home independently checks the location allowlist, exact granted workspace, required selection markers, unchanged unselected facts and the ban on removing prior members during partial scans. Inspection grants no activation or execution authority.

Builder procedure version kode.builder.interview.v6 explains these locations and coverage states. Missing or incomplete categories remain explicit pending checks, persisted with the observations in the draft. Historical records default to an empty optional pending_checks field. A matching native helper is required for nested reads. Older root-only usage retains its compatibility path with native_directory_anchor_unavailable coverage when the helper is absent or lacks this mode. A failed identity check or invalid helper result does not enter that compatibility path. A project skill or plugin manifest discovered this way still requires the separate owner-reviewed workflow dependency contract before Worker execution.

### Owner intervention and session diagnostics

Owner WorkRun commands add takeover and resume with request_id, expected_revision and bounded reason. The backend accepts finalize_takeover from the authenticated Home reconciler surface. The browser control route exposes the two owner decisions. Exact command receipts and atomic absent-receipt/current-revision snapshots support recovery after a lost response. A stale uncommitted command becomes obsolete only with that negative proof.

Takeover atomically changes the run to taking_over, fences all nonterminal Assignment operations and removes their execution leases. Shared stop finalization requires exact authenticated drain and finalized accounting, or the existing proven-never-admitted zero-charge path. Home commits paused only after those gates and resource release. Interrupted Assignments retain their records and carry the interrupted state. Scheduling capacity and final delivery exclude those settled historical Assignments from the active count. They supply no current-stage completion evidence.

Resume requires paused execution, finalized accounting, released holds and current authority matching the run's frozen team authorization. It keeps the same WorkRun/context and resets every stage to pending while retaining attempt counters. The work_run_resumed audit event retains the superseded stage snapshots. Prior selected evidence, waivers and human acceptance require new validation. The result is waiting_resource with execution_authorized false in the resume intent. Fresh Assignment creation, permissions, quota/budget, resource admission and independent evidence validation continue through their normal gates.

Remote lifecycle polling recognizes taking_over before waiting for Worker output. Interruption omits newly captured completion proofs that may carry a fenced epoch. An already persisted stop command is replayed exactly. Disconnection or unresolved accounting retains the pending stop and resource fence.

GET work-runs/:id/diagnostics requires an exact run_revision and supports bounded Assignment-id pagination. It reads one SQLite snapshot and emits at most25 entries, including execution identity, current/historical stage association, operation state/epoch/lease, stop/accounting metadata and resource-hold count. It returns read_only true and runtime_liveness not_probed. It contains no raw session transcript or tool payload. Host and browser enforce owner access and matching run/team/Home scope.

Current intervention UI places manual work in the already-authorized workspace. Managed Worker sessions retain the controlled-execution fence. Full remote takeover execution, Coordinator pause notifications and the native read-only Session-history experience require follow-up verification/implementation before closing the intervention requirement.


### Worker clarification observations (local Home, implementation in progress)

Owner-only `POST /api/v1/messaging/work-assignments/:id/clarifications` accepts
`{request_id,call_id,command,questions}`. Questions are bounded data, not an execution grant.
The Home checks the frozen dispatch command, executor identity, consumed mandate, held
resources, live operation/lease and exact started official model call. Receipt storage,
WorkRun revision and audit event commit atomically. Exact replay returns the immutable
receipt even after the live attempt changes; changed request contents conflict.
Owner-only `GET .../clarifications/:request_id` returns `{clarification: receipt|null}`.
Worker session principals cannot invoke these owner routes.

Receipts use `snapshot:assignment_clarification_receipt.v1`, bind Assignment, stage attempt,
operation, model call, context hash and Home, and always carry `completion_authorized:false`.
Questions use `id`, `question`, optional `header`, `options`, `isOther`, `isSecret`.
At most eight questions and 32768 serialized question bytes are accepted per request.
A WorkRun keeps up to 128 pending receipts in insertion order in `clarifications`, with
`pending_clarification` projecting the first receipt for existing consumers. Another
request ID cannot introduce a second receipt for the same pending model call.
Stage waiver clears only that stage's pending receipts; explicit intervention resume
archives and clears all pending receipts. Immutable historical receipts remain readable.

The fixed-team Coordinator status tool returns one sanitized question request and
`worker_clarifications:{count,revision,next_cursor}`. Continue with optional
`clarification_after`; any revision change requires restarting pagination. Optional
`omit_inputs:true` avoids repeating original inputs. Full frozen dispatch commands are
omitted. Terminal runs project no pending questions. Reads grant no answer, retry or
completion authority. The Host durably queues the exact observation before Home I/O
and recovers lost responses by receipt read before replay. Native managed Codex question
capture waits for process drainage and records the observation before final usage events
close the active model call. Usage still accounts if clarification delivery fails.

Remote observations use the existing owner-only operation accounting relay with actions
`assignment_clarification:{assignment_id,observation}` and
`assignment_clarification_read:{assignment_id,request_id}`. Both require the negotiated
`operation_assignment_clarification_v1` feature and the existing Assignment context feature.
The authenticated execution peer and exact operation Worker must match before Home reads
or writes the receipt. These actions preserve the existing 65536-byte accounting envelope
limit. Oversized observations are retained pending locally with an explicit delivery error.
After a drained native question is acknowledged by Home, the managed adapter ends the
admitted model decision normally. Reported usage retains its usual accounting status.
Missing usage remains unresolved and blocks a subsequent call through the existing
accounting gate. Failure to obtain the Home receipt or confirm native drainage retains
the existing interruption path. The decision journal labels the native outcome
`requires_clarification`. The originating Coordinator consumes the durable notice, reads
fixed-team status and publishes the question in its stable conversation.
Local consumed-human answers and resumption are described below. Remote answer/resumption acceptance remains pending. An accepted question
receipt alone does not prove the conversation/answer loop is complete.


### Consumed-human clarification answers

Owner-only `POST /api/v1/messaging/work-assignments/:id/clarification-answers` accepts
`{request_id,question_request_id,source_message_id,conversation_id,operation_id,
control_revision,attempt,epoch}`. The referenced operation is the supervising Coordinator,
with its exact consumed human input and current fixed conversation/control. Its grant must
explicitly include `kode_coordinator_answer_clarification` as well as the existing delegation
capability and base workflow control. The pending question must still belong to this active
Assignment/attempt with consumed mandate, held resources and live Worker lease. The question
model call must be finished with reported accounted usage. Secret questions require external
configuration and are refused by this endpoint. Human text is taken unchanged from the Hub
conversation record, capped at16384 bytes, and cannot be supplied by the model tool.

The answer command atomically inserts a bounded inbox message, immutable
`assignment_answer_receipt.v1` receipt, Assignment answer reference, WorkRun revision and
audit event. Only the exact pending question is cleared. Receipt identity is per Assignment
and question. Exact replay returns the original result, including after terminal state or
restart, while changed arguments conflict. GET `.../clarification-answers/:question_request_id`
returns `{answer:receipt|null}`. Ordinary Worker session principals cannot invoke these routes.

The existing local/remote durable message transport carries
`kode.assignment.clarification-answer.v1`. On the execution Host, the Worker accepts it only
when its current Assignment contains the exact receipt/message/hash, sender, Worker,
operation, stage attempt and context. It enters the session as a durable Agent relay message.
Before each model call, the Host revalidates any retained answer against Home context and
its exact committed session message. Runtime-context snapshots keep their existing semantics.
The original mandate and workflow evidence gates remain authoritative.

The optional Coordinator tool takes only request, Assignment, question and human-message
references. It confirms consumption before submission and recovers uncertain writes by
reading the original receipt. Startup planning, preparation, dispatch and resume carry this
tool only when the owner granted it. Existing four-tool Coordinator configurations remain
valid. The authority review form exposes an answer-forwarding checkbox and describes the
permission in its review. Existing grants initialize this choice from their saved tools.
New teams propose it enabled for explicit review. Builder procedurev8 and Coordinator
procedurev3 explain the permission and its limits.

Current implementation retains account/workspace/exclusive holds while waiting for a human
answer, then resumes the same Worker under its original operation. This preserves its
working state and consumes capacity until answer, cancellation or intervention. Local
Superagent-to-human-to-Worker resumption and three-stage completion have actual runtime
coverage using a controlled model adapter. Installed Codex0.154.0 engine answer continuation
also has local acceptance through an owned synthetic Responses peer. The implementation
Worker retains one official session and operation across its question and answer, with
five native decisions and confirmed process drainage. Independent review, actual verification,
Home completion and restart receipt checks run in the same scenario. This engine protocol
coverage uses synthetic model output. A paired-process Home/execution Hub scenario also
covers remote answer/resumption through real authenticated links, remote implementation,
independent remote review, actual remote verification, Home completion and restart receipt
replay. These processes run on the same machine with controlled model output. Actual
cross-machine/SSH and live-provider delivery still require dedicated acceptance. Downstream frozen clarification inputs have controlled
local runtime and restart acceptance coverage.

### Clarification model input and normal report gates

For an Assignment with confirmed answers, every subsequent official model-call admission
requires `prompt_provenance.instruction.answers`, in Home archive order. Each compact entry
contains `question_request_id`, `message_id` and `content_hash`. The list must exactly match
Home's current Assignment answer receipts. Missing proof, stale lists and foreign entries
are refused before new admission. The Host validates all current answers in the actual
prepared model input and committed session events, and hashes that effective input. Prompt
provenance stores compact hashes and references. Original human text stays in the existing
durable messages and the frozen workflow context.

Assignment context reads include `clarification_progress.ready_to_report` when a pending
question or confirmed answer exists. It is false while any question for that Assignment
remains pending, any answer lacks exact consumed delivery evidence, or no current-attempt,
current-epoch finished/accounted official call contains the entire current answer list.
Remote consumption is read from authenticated delivery mirrors. Local delivery evidence
cannot satisfy a remote Worker's consumption gate. Hosts wait before reusing published
outputs, reporting or stopping. Home independently checks the same condition inside normal
operation reporting and stage-completion transactions. Cancellation retains its existing
independent stop path.

When preparing a dependent stage, Home verifies each passed ancestor Assignment's immutable
question/answer receipts, durable answer message and original human conversation content.
It freezes `clarifications` entries containing `receipt`, `question` and `response` under that
producer in `inputs.binding.sources`. The existing input and mandate hashes cover this
context, including independent review and verification. Existing Assignments without answers
retain their previous input representation. Delivery TTL does not remove confirmed historical
requirement context. Prepared downstream inputs remain immutable across retry and restart.


### Queued request scheduling

An authenticated connection receives a peer-scoped notification after an operation or
workspace request enters its existing bounded pending queue. Each live connection has its
own retained notification permit, released with that connection's observation record.
Concurrent connections continue to arbitrate operation sending through the shared `sent`
flag. Notifications coalesce and do not wake other peers. Both accepted and initiating
WebSocket loops retain the 500ms periodic path for queued recovery, directory updates,
authorization checks and heartbeat timeout checks. Wire envelopes, capability negotiation,
response deadlines and uncertain-outcome handling retain their existing contracts.

The paired-Hub controlled-model answer/resumption workflow completed in 12.763s and 12.386s
after this scheduling change, compared with the recorded 503.203s polling run. This is a
same-machine integration observation. Actual cross-machine/SSH and live-model latency need
their dedicated acceptance runs.

### Read-only missing-usage diagnostics

Home admin `GET /api/v1/messaging/work-runs/:id/accounting-status` returns a
single-snapshot observation with `home_hub`, `run_id`, `team_id`, `run_revision`,
`authority: home_accounting_observation`, `read_only: true`, and `retry_allowed: false`.
It reports terminal `usage_unresolved` calls for current stage Assignments at their
operation's current attempt, plus the run's pinned Coordinator origin. Replaced stages
remain in trace; replacement team control does not adopt a run without explicit transfer.
Started calls, including those without intermediate usage, are not terminal blockers.

A blocker returns `state: waiting_accounting`, `blocked: true`,
`reason: usage_reconciliation_required`, and
`recovery: blocked_until_trusted_usage_is_reconciled`. Otherwise the state is
`no_usage_blocker`, not a settlement or execution authorization. `unresolved_calls` contains
at most 64 safe projections, with `truncated` indicating omitted rows. Each projection
includes call/operation/attempt/epoch, Assignment/stage references (null for shared
Coordinator calls), call/accounting state, and the actual reservation's
id/unit/charged/held/finalized/frozen when bound. Raw session content is excluded.

The owner-only dsh execution observation includes this result as `accounting`; a current
nonterminal blocker disables retry and reports `waiting_accounting`. The fixed-team
Coordinator status tool includes `execution_accounting` after checking its own authority
and the run's Home/team/revision. Home's existing durable Coordinator-update discovery
also recognizes these blockers and queues their reason and accounting summary through
the same revision-idempotent inbox, lease, grant, budget and resource checks. No call is
started by a diagnostic read or notice queue operation.

Host WorkRun monitoring persists a waiting-accounting fence when missing outputs or a
progression failure has this definite Home evidence. Restart retains the fence; retry
cannot clear it while Home still reports missing usage. A failed or stale diagnostic read
remains a generic per-run recovery fence, never proof of missing usage and never a reason
to stop unrelated teams. The projection does not change canonical WorkRun completion,
settle calls, release reservations, accept manual token counts or authorize replay.

Builder admin `GET /api/v1/messaging/operations/:id/builder-close` additionally returns
read-only `accounting` without requiring a close intent. The Builder/Home/attempt scope
is checked independently of generic operation visibility. Terminal missing usage produces
`state: waiting_accounting`, `reason: needs_reconciliation`, `retryable: false`, unresolved
call references and the actual reservation facts. Nonterminal calls remain pending;
other unresolved accounting remains blocked. The owner Host close/accounting surfaces
recognize only the exact Home unresolved-usage rejection in the same operation attempt
and epoch. Unknown HTTP/transport failures keep their original uncertainty. Storing a
definite waiting observation prevents endless close resubmission and does not assert that
execution resumed, accounting settled or any held amount was refunded.

### Owner conversation cursor stream

`GET /api/kode/conversation/events?conversation_id=<id>&after=<sequence>` is an owner-only Host SSE adapter for the durable Home conversation message API. Credentials remain in the normal owner connection; they are not query parameters. Duplicate/unknown query fields, unsafe cursors and a `Last-Event-ID` earlier than `after` are rejected. A newer valid header resumes from that cursor. Home/conversation/team identity is verified before opening the stream and remains pinned.

Each `messages` event carries a sequence `id` and a bounded existing message-page projection. A page may be split into single-message events; `has_more` and `next_cursor` describe continuation after that event. Clients validate identity/order and suppress exact replay, retaining their last accepted cursor on reconnect. Receiving a message is not a read acknowledgment: the separate owner read-state API still advances only from the visible conversation viewport.

The current Host adapter polls the existing Home cursor API, normally once per second while connected, and drains backlog pages serially. It is not a native Home change feed. It retains at most one 50-message Home page, pauses further polling and writes under response backpressure, and cancels reads/timers when the connection, plugin or visible client surface closes. Heartbeats carry no user content. Browser clients abort hidden streams, resume from their accepted cursor, batch store notifications by animation frame, and retain a slower REST fallback. Long-history rendering uses measured viewport virtualization; this bounds rendered message nodes, not the total in-memory history cache.

### Automatic task checkout preparation

Writable automatic assignments require a trusted Host task checkout and Home-derived execution scope; the declared original repository root is not a writable fallback. Before Git branch/worktree metadata creation, the assigned execution Host obtains `POST /api/v1/messaging/work-assignments/:id/task-workspace/prepare` authorization. This admin/assigned-peer operation checks the current Run/stage/input/context/authorization, operation attempt and epoch, exact assignment revision, and original registered repository binding. Its durable receipt authorizes provisioning only (`provision_authorized:true`, `scope_authorized:false`, `execution_authorized:false`), pins the Run/repository/Host base, root and branch, and rejects overlap with another Run's planned or final task checkout. Replays recheck live authority.

Final `POST /api/v1/messaging/work-assignments/:id/task-workspace` must match that preflight and its resulting revision, prove the frozen starting content basis, and recheck live authority before deriving a scope. Resource holds, Worker creation and fresh admission follow the final scope; a preparation receipt alone cannot authorize them. The same typed operations route back to Home through the negotiated `operation_assignment_task_workspace_v1` capability. An accepted preparation can leave an orphan checkout if authority changes before final admission; it does not authorize execution after revocation.

Different Runs use separate checkouts/branches even when their original repository binding is shared. Rework reuses its Run's pinned checkout with explicit frozen content proof. Local delivery exposes the archived task artifact and its base/branch/root as unintegrated; it does not imply that original working-tree files were modified or changes were merged. Commit/integration/deployment effects still require their configured explicit stages and authorization.

### Managed Codex provider usage receipts

A managed decision owns one admission gate, an inference nonce and exactly one forwarded request. Its native thread and turn are sealed once. When native usage is entirely absent, the decision may select a provider receipt collected directly from that gate's successful HTTP 200 Responses stream. The stream must reach upstream EOF with one consistent response identity, a completed terminal and strictly valid counters under the pinned codec. Process stop and native stdout drain remain independent prerequisites. Native-invalid, conflicting, incomplete, failed, cancelled or multiply dispatched evidence does not enter this fallback. A terminal frame alone is insufficient.

If the native downstream closes after a complete successful terminal, the Host may continue draining that same upstream without issuing another request. Production uses one nonextendable two-second deadline and an eight-MiB tail limit. Only real upstream EOF and successful final framing permit `upstream_eof_with_peer_close`; normal forwarding also waits for destination finish. Timeout, invalid/conflicting/truncated tail, upstream error, owner cancellation or another request fails closed. Native stdout drainage is a separate condition and cannot replace upstream EOF.

The durable decision record distinguishes `codex_thread_token_usage` from `codex_admitted_provider_response`. Provider receipts include inference/thread/turn/response identity, codec and transport basis, `requested_model`, optional `reported_model`, and `model_basis: requested_model_unverified`. A returned model label is an observation, not verification of actual execution identity. Admission still checks the exact requested model/effort/tools and native configuration; native reroute guards remain active. Existing frozen requested-model pricing is unchanged, as is `inference_verified: false`.

Only one usage event reaches the existing Home accounting path. This adds no manual correction, retry, refund or supplier-billing authority; unsupported or unresolved accounting retains its hold and blocks subsequent admission. No global diagnostic array can be used to reconstruct a historical call's missing usage.


### Explicit workflow artifact inputs and manual rejection (Superagents increment)

`WorkflowPack.stages[].execution.input_artifact` optionally names `{stage, output}`. It selects exactly one ancestor Artifact output in the same repository as the stage execution scope. If the stage publishes review or verification evidence, its `artifact_output` must equal that selected output. These constraints are checked during Home workflow registration and again against frozen Assignment inputs before deriving an execution directory. Materialization must still use the complete Home archive, exact snapshot/sequence and scoped receipt; the mapping adds no filesystem or execution permission. Other ancestor sources remain in provenance and are not implicitly copied into cwd.

A workflow using this field has hash format `kode.workflow.input-artifact.v8`. Absent/null fields are omitted and existing v1–v7 workflows retain their hashes. Without a mapping, existing ambiguous multi-snapshot input refusals remain. A writable implementation rework continues from its previous completed attempt's artifact, ahead of the initial input mapping; selecting a baseline cannot silently discard prior rework changes. Home/Host versions must understand this contract; an old component's refusal is not successful admission and must not be bypassed by dropping the field.

`on_reject.max_reworks` now accepts 0–100. Zero means retain the rejected evidence and wait for owner action without scheduling a new attempt, invalidating the baseline or allocating another execution. The configured target must still be an ancestor. This does not create a waiver. An owner waiver is a separate existing scoped/CAS command requiring current authority and stopped/settled execution; it retains `waived` and never synthesizes passed evidence. Escalation `after_reworks` thresholds remain 1–100.

The Builder catalog `kind=workflow_template` exposes unregistered `software-feature` and `software-bugfix` proposals. They contain no registered hashes, account credentials, grants or scheduling readiness claims. The owner-reviewed bugfix method captures an isolated baseline, then requires an exact registered reproduction judge before implementation. The judge returns exit 0 only when the expected defect is confirmed; ordinary failure is not automatically success. Its diagnosis rejection policy uses zero automatic reworks and may allow an explicit owner inability-to-reproduce waiver. Independent post-fix review and verification still apply. Role tags, command/scenario identities, project bindings, delivery policy, resources and permissions require actual configuration and activation.

This increment does not implement the reserved generic `Report` validator, any new external-platform adapter, or cross-Run automatic inheritance of archived bytes. Validation evidence is tracked separately from these protocol definitions in the Superagent change's current audit.
