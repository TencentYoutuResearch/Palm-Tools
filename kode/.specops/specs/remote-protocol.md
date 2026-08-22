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
