---
schema_version: 1
id: roadmap
kind: spec
title: kode roadmap — project direction and phase planning
status: active
verifies:
  - specops
  - rust
paths:
  - .specops/specs
  - Cargo.toml
---

# kode — 路书 / Roadmap

> **2026-05-30 重大调整**:由 TUI 路线转向 **独立 GUI 应用**(Tauri 2 + xterm.js + Svelte 5)。
> 触发原因(用户三条强需求):①快捷键冲突宿主终端;②TUI 表现力受限;③后续要内置 agent 直接调 API,需要丰富 UI。
> v0.2-0.4 的 TUI 计划**已废弃**(留作 Decision Log 的反面教材)。

## 初衷不变(用户硬约束)

> **极致性能 + 零渲染问题** —— 从 TUI v0.1 继承,GUI 版必须扛得住。
>
> 这两条不是口号,是**可量化的验收指标**(见 v0.2 验收标准章节)。
> 任何 Phase 的设计决策若与之冲突,必须在 Decision Log 写明权衡。

## 现状

**v0.1.0-tui**(冻结)— 2026-05-30
- ✅ Rust TUI + ratatui + vt100-ctt + portable-pty,1900 行
- ✅ 33 个单测,2.4 MB release 二进制
- ✅ codebuddy session jsonl 解析(model/title/tokens 实时同步)
- ✅ scrollback 翻看(C-b [ / 滚轮自动进入)
- ✅ 模型自动注入子进程(--model)+ 模型名智能压缩
- ⚠️ **不再演进**,只接受 P0 bugfix(用户决定)
- **P0 定义**:让用户无法完成基本工作流的 bug。
  例:崩溃 / 子进程僵死 / 数据丢失 / 看不到子进程输出。
  非 P0:UI 美化、新功能、可绕开的 corner case。

## 目标架构(v0.2 起)

```
kode/                              ← monorepo
├── crates/
│   ├── kode-core/                 ← Phase 1 抽出来的纯 Rust 逻辑
│   │   ├── pty/                     直接搬 src/pty/
│   │   ├── session/                 直接搬 src/session/  (state/heuristic/jsonl_tail/mod)
│   │   └── config.rs                直接搬 src/config.rs
│   └── kode-tui/                  ← 现有 src/,改成依赖 kode-core,冻结维护
└── apps/
    └── gui/                         ← Tauri 2 应用,新建
        ├── src-tauri/               Rust 后端(commands + event bridge)
        │   ├── Cargo.toml           依赖 kode-core
        │   └── src/
        │       ├── main.rs
        │       ├── commands.rs      Tauri command:spawn_session/write/kill/list
        │       └── events.rs        从 mpsc → tauri::Event 桥接
        ├── src/                     前端 SvelteKit
        │   ├── routes/+page.svelte  主窗口
        │   ├── lib/
        │   │   ├── terminal.svelte  xterm.js 容器,1 个 tab 1 个实例
        │   │   ├── tablist.svelte
        │   │   ├── statusbar.svelte
        │   │   └── command-palette.svelte  Cmd+P
        │   └── stores/sessions.ts   Svelte store 管理 tab 列表
        ├── tauri.conf.json
        └── package.json
```

## 路线图

> **已归档** — Phase 0-7 (TUI 收尾 → GUI v0.2 MVP) 已完成,详见 [`.specops/specs/roadmap-phase-0-7.md`](./roadmap-phase-0-7.md)。
>
> 主页只保留**当前活跃**的 Phase 8 / 9 / 10 / 11。

### 已归档摘要(Phase 0-7)

| Phase | 主题 | 状态 |
|---|---|---|
| 0 | 收尾 TUI v0.1 | ✅ |
| 1 | Rust core 模块化(`crates/kode-core`) | ✅ |
| 2 | Tauri 2 + Svelte 5 + xterm.js 单 tab POC | ✅ `cb6b5fd` |
| 3 | 多 tab + 侧栏 + 后台保活 + LRU 快照 | ✅ `32aa67c` |
| 4 | 全应用快捷键 + Command Palette | ✅ `101ce17` |
| 5 | 状态栏组件化 + 主题 + Cost 计算 | ✅ `e50bd6d` |
| 6 | 打包 + 性能验收(.app 5.0 MB / zip 2.1 MB) | ✅ `f606ff5` |
| 7 | 持久化 + 多窗口 + UI/UX 重构 + 7.4 bug 修复 | ✅ `d6519fb` + `ab0168d` + `d77bfa5` |

完整 checklist + 关键性能点 + Decision Log 见归档文件。

### Phase 8 — 内置 Agent (v0.3,数周后再规划)

用户明确未来要做。**不在 v0.2 MVP 范围**,但架构要预留:
- `kode-core` 加 `agent/` 子模块,定义 `trait Agent { fn invoke(...) }`
- 第一个实现:thin OpenAI/Anthropic API wrapper(走 HTTP/SSE)
- UI 层:Cmd+K 弹"自带 agent"模式,与 codebuddy/claude tab 并列(不一定占 PTY tab,可能是浮层对话框)
- 设计要点:agent 调用的工具用 MCP 协议(与 codebuddy/claude 生态对齐)

### Phase 9 — 手机端伴侣(v0.3,完整规划已出)

**目标**:在手机上看到 / 操作桌面端正在跑的 codebuddy / claude session,
覆盖 idle/busy/awaiting-decision 状态感知、聊天上下文回看、Plan 与 AskUserQuestion 答疑选择适配。

**技术栈决策**:Server = Go + docker compose 一键部署;App = Flutter(iOS+Android 同代码)。
**联调路径**:先用桌面 Tauri 后端起一个 9.1 桥跑通协议,Flutter 切 endpoint 即可换到 Go server。

#### Phase 9.0 — 协议规范(已完成,2026-05-30)

server 实现无关的契约,Rust 桥与 Go server 都按这个实现。**9.1 端到端验证已锁住此契约**(115 个测试中的 14 个 E2E 跑了完整事件类型 + REST 端点)。

- [x] 新文档 `.specops/specs/remote-protocol.md` v1:WebSocket 事件 schema + REST 端点 + 鉴权 + version 字段
- [x] 事件类型(语义层,非 raw jsonl):
  - [x] `connection.hello`(连接建立时全局事件)
  - [x] `session.created` / `session.exited`(`session.updated` 暂走 `meta`,无独立事件)
  - [x] `message` { id, role, text, tool_calls?[`.specops/specs/memory-git-sync.md`] }
  - [x] `tool_use` { id, tool, input_summary, output_preview, status }
  - [x] `meta` { model, title, tokens, input_tokens, output_tokens, cached_tokens, cost_usd, context_pct }
  - [⏳] `ask_user_question` / `plan_proposed` / `task_create-update` — 协议字段已定义,实现待 Phase 9.2 联调时按真实 jsonl 信号补(目前桑 Rust bridge `/answer` `/plan_response` 占位 500)
- [x] REST(全套已实现并通过 E2E 测试):
  - [x] `POST /api/v1/auth/login`(Rust bridge 不实现,Go server 实现)
  - [x] `GET  /api/v1/sessions`
  - [x] `POST /api/v1/sessions` { backend_key, cwd?, resume_session_uuid? }
  - [x] `GET  /api/v1/sessions/:id`
  - [x] `GET  /api/v1/sessions/:id/history?from=<unix_ms>&limit=<n>`
  - [x] `POST /api/v1/sessions/:id/input` { bytes_b64 | text }
  - [⏳] `POST /api/v1/sessions/:id/answer` 占位 500
  - [⏳] `POST /api/v1/sessions/:id/plan_response` 占位 500
  - [x] `DELETE /api/v1/sessions/:id`
  - [x] `GET  /healthz`(无需鉴权)
- [x] WebSocket:`/ws?token=<bearer>` 服务端推送事件流;ping/pong 心跳
- [x] 鉴权:bearer token / JWT;HTTPS 由 caddy / Tailscale 反代承担

#### Phase 9.1 — Rust 端 HTTP/WS 桥(~2 天,联调用)

不开新 crate;在 `apps/gui/src-tauri/src/` 加 `bridge/` 模块,复用 AppState。

- [x] 9.1.0:`bridge/server.rs` axum 0.7 监听 `127.0.0.1:9870`(env `KODE_BRIDGE_PORT/BIND/DISABLE` 可覆盖)
- [x] 9.1.1:`bridge/events.rs` `BridgeBus`(broadcast 容量 256 + 历史 ring buffer 1000/session,meta 只留最新)— `state.rs::spawn_event_router` 把 `CoreEvent::PtyExited / JsonlMeta` 同时复制到 GUI emit 和 bus
- [x] 9.1.2:鉴权 — `persistence::load_or_init_bridge_token()` 启动时读 / 生成 32-hex token 写入 `state.json`,REST `Authorization: Bearer ...`、WS `?token=...` 双通道接收;常量时间比对避免侧信道。**Show Pairing QR** 命令面板项已落地(`get_pairing_payload` 命令 + `PairingDialog.svelte` + qrcode lazy chunk,主 bundle 不增重)
- [x] 9.1.3:实现 9.0 协议全部 REST 端点(GET /sessions、POST /sessions、GET/:id、DELETE/:id、GET/:id/history、POST/:id/input、WS /ws);`/answer` `/plan_response` 占位 501,等 9.1.4 真懂 PTY 编码后落地
- [x] 9.1.4:`bridge/semantic.rs` 解析层 — codebuddy/claude jsonl → message / tool_use(text + tool_use + tool_result),与 `kode_core::session::jsonl_tail` 双 tail 互不干扰;ask_user_question / plan_proposed / task_create-update 等 9.2 联调实测后补
- [x] 9.1.5:claude 后端 jsonl 已在 7.4 解决 model/title/tokens;9.1.4 又补齐 message/tool_use 解析。剩下 plan / ask 类事件保留 TODO
- [x] 9.1.6:`docs/protocol-smoke.sh` curl + wscat 端到端验收脚本(用户启动 GUI 后 `KODE_BRIDGE_TOKEN=$(jq -r .bridge_token state.json) bash docs/protocol-smoke.sh`)
- 测试:**101 个全绿**(65 core + 21 gui:含 9 events + 10 semantic + 2 persistence-token 新增 + 4 旧测 / 15 tui)

#### Phase 9.1.7 — 端到端集成测试(2026-05-30 补)

把"假定能跑"换成"自动验证一定能跑"。

- [x] 重构:抽 `Arc<BridgeCtx>` 共享 sessions/bus/token,router 不再依赖 AppHandle
  - `bridge/ctx.rs`:`BridgeCtx { config, sessions, byte_buffers, core_tx, next_id, bus, token }`
  - `state.rs::AppState` 持有 `Arc<BridgeCtx>`,所有 Tauri 命令走 `state.ctx.xxx`
  - `state::build_test_ctx()` 暴露给集成测试:不需 Tauri runtime,直接构造 ctx
  - 编译期保证:`AppHandle` 仅用于 GUI emit,不再渗到 router 层
- [x] `tests/bridge_e2e.rs` — 真启 axum + 真 PTY(/bin/cat 当 echo backend)+ 真 reqwest + 真 tokio-tungstenite:
  - healthz 不需 token / 401(无 token & 错 token) / 空 list
  - spawn → get → list → input → kill → 404 全链路
  - 错误路径:未知 backend 400、bytes_b64 invalid 400、空 input 400
  - WS:hello 推送、session.created/exited 实时广播、ping/pong、token 校验
  - history endpoint 拿到 session.created 回放
  - answer/plan_response 占位 500 已锁
- [x] dev-deps:reqwest(rustls)+ tokio-tungstenite + futures-util + tokio full
- 测试:**115 个全绿**(对比 9.1 的 101 多了 14 个真集成 E2E)
- 性能:14 个 E2E 跑完总耗时 0.12 秒(并行 tokio test)

#### Phase 9.1.8 — Release 二进制端到端验证(2026-05-30 补)

不光跑 cargo test,**真启 release 二进制 + 真 HTTP/WS 客户端验证**。

- [x] `cargo build --release -p kode-gui` 出 6.0 MB 二进制(打开 webview 失败也无所谓,bridge 是后台 task)
- [x] `KODE_BRIDGE_PORT=29870 ./target/release/kode-gui` 后台启,日志 `bridge listening addr=127.0.0.1:29870`
- [x] curl 全套真验证:
  - `/healthz` → "ok"(无需 token)
  - 无 token → 401
  - Bearer + 空 list → `{"sessions":[`.specops/specs/memory-git-sync.md`]}`
  - 错 backend → 400 `{"error":"bad_request"}`
  - 真 spawn codebuddy(cwd=/tmp)→ 200 + `{"id":1, "model":"claude-opus-4.7", "status":"starting", "session_uuid":"a633..."}`
  - 真 list → 包含上面 session
  - 真 delete → 204
- [x] node ws 客户端真 WS 验证:`connection.hello` → `session.created` → `session.exited` 三条事件全到
- [x] 端口正确释放,无僵尸进程

**结论**:9.1 的 Rust 桥可以单独运行,任何外部 HTTP/WS 客户端(Flutter / Go server 联调 / curl / wscat)都能连进来按协议跑。Phase 9.2(Flutter)联调时,只需把 endpoint 设为 GUI 桥即可。

#### Phase 9.2 — Flutter App MVP(`apps/mobile/`)

> **2026-05-30 更新**:9.2.0 + 9.2.1 已在主仓 `apps/mobile/` 完成。后续详情屏 / 输入 / 离线缓存待独立 Flutter 开发会话推进(每个屏幕需要真机/模拟器调样式,不适合纯 codegen)。

- [x] 9.2.0:Flutter 3.x 项目脚手架,riverpod + go_router + sqflite + dio + web_socket_channel + flutter_secure_storage + mobile_scanner
- [x] 9.2.1:配对屏 — 扫 QR(mobile_scanner 解 `kode://pair?host=…&port=…&token=…`)/ 手输 host+port+token,本地 secure_storage 存;走 `/healthz` + `/sessions` 双重验证才保存
  - `lib/src/protocol/protocol.dart` —— Envelope / SessionDto / Endpoint 数据模型
  - `lib/src/api/api_client.dart` —— Dio REST + WS 自动重连 + 25s ping/pong
  - `lib/src/state/providers.dart` —— Riverpod sessions 状态机,WS 事件增量更新本地缓存
  - 9 个 Flutter 单测覆盖协议解析(URI 解析 / Envelope / SessionDto)+ analyze 干净
- [x] 9.2.2:主屏 session 列表 + 状态徽章(idle / busy / awaiting / exited 四色)— 已完成基础版,待补 awaiting 颜色 + 长按菜单
- [x] 9.2.3 第一刀:session 详情屏(`session_detail_screen.dart`)— 对话气泡(user/assistant)+ tool_use 折叠卡(running/ok/error 状态点)+ 历史回放(`/history?from=0` 拉 71 事件实测通)+ WS 实时增量(message / tool_use / meta 自动同步)+ 输入框 → POST `/input`;ask_user_question / plan_proposed 占位卡片(等真信号实测落地)
- [x] **桌面联调:macOS Flutter 自动配对** — `lib/src/storage/desktop_auto_pair.dart` 启动时读 `~/Library/Application Support/kode/state.json` 拿 bridge_token,候选端口 `[KODE_BRIDGE_PORT, 9870, 29870, 18870]` 依次 probe,第一个 `/healthz + /sessions` 都通的胜出。无需扫 QR 也无需手填,Flutter macOS app 启动就跳到 sessions 列表。**坑**:macOS Debug 必须关 sandbox(`DebugProfile.entitlements` `app-sandbox=false`)否则没法读他人目录;`flutter_secure_storage` 在没 keychain entitlement 时抛 `-34018`,bootstrap 已加 1.5s 超时 + 吞错(只丢失持久化,endpoint 仍推给 UI)
- [ ] 9.2.4:输入框 + 长按快捷指令
- [ ] 9.2.5:离线缓存(sqflite + `/history?from=` 增量)
- [ ] 9.2.6:联调阶段(endpoint 切桌面 bridge / docker Go server)
- [ ] 明确 out of scope:完整 PTY 渲染(不上 xterm-mobile)、多设备实时协同、推送通知(P2)

#### Phase 9.3 — Go server + docker compose(完成,2026-05-30)

完整 Go 实现,与 Rust bridge 共用同一份协议契约。本仓 `services/kode-server-go/` 子目录,go.mod 独立。

- [x] 9.3.0:`services/kode-server-go/` 脚手架,`go 1.22`
- [x] 9.3.1:Go server 用 net/http(Go 1.22 原生 path patterns)+ gorilla/websocket + creack/pty + modernc.org/sqlite(纯 Go,无需 cgo,Alpine 镜像构建简单)
  - **不**用 Gin —— 标库 mux 已经够用,少一个依赖
- [x] 9.3.2:`internal/semantic/` 把 Rust `bridge/semantic.rs` 用 Go 重写
  - 字段一致:message / tool_use / tool_result;summarize_tool_input(Bash/Read/Write/Edit 已知)
  - 12 个 Go 单测覆盖与 Rust 端 10 个 Rust 单测对齐的 case
  - **协议契约靠交叉测试锁住**:同样的 jsonl 输入,两边输出语义事件应等价
- [x] 9.3.3:协议端点全实现(`internal/server/server.go`)
  - REST:healthz、/login(Go 独有)、sessions CRUD、/input、/history、/answer 占位 500、/plan_response 占位 500
  - WS:`/ws?token=`,JWT 校验,connection.hello / session.created / exited 实时广播,ping/pong
  - 15 个 server-level E2E 测试(用 httptest + gorilla/websocket dialer 真跑)
- [x] 9.3.4:`internal/store/` sqlite 持久化
  - schema:sessions + events 两表,`idx_events_session_ts` 加速 /history 查询
  - meta 类型在 /history 只回放最新一条(对齐协议 §4.4)
  - 5 个 store 单测
- [x] 9.3.5:`internal/auth/` JWT(`golang-jwt/jwt/v5`)+ bcrypt
  - `kode-server -hash <password>` 子命令为 deploy 生成 bcrypt hash 写 yaml
  - `kode-server -config c.yaml` 启动;无 users 时拒绝 /login(协议层强制)
  - 8 个 auth 单测
- [x] 9.3.6:`Dockerfile` 多阶段 + distroless `gcr.io/distroless/base-debian12:nonroot`
  - CGO_ENABLED=0,镜像目标 < 30 MB(modernc sqlite 纯 Go)
- [x] 9.3.7:`docker-compose.yml` 一键起;两种部署模式注释化(远程 AI 箱 / 共享桌面 jsonl)
- [x] 9.3.8:`deploy/DEPLOY.md` —— Tailscale + caddy 双方案;部署验证流程;FAQ
- [x] 9.3.9:**跨实现 smoke 对齐** —— `docs/protocol-smoke.sh` 统一脚本
  - `bash docs/protocol-smoke.sh --rust --port 29870 --backend codebuddy` 跑 Rust bridge
  - `bash docs/protocol-smoke.sh --go --port 39870 --user alice --pass wonderland` 跑 Go server
  - 12 步 healthz/401/403/spawn/list/get/input/history/answer-501/delete/404/WS hello,双实现行为对齐
  - **真启 release 二进制 + 真 curl + 真 node ws 客户端**双向跑通

#### Phase 9.3 测试 + 二进制矩阵

```
Go server 测试      58 个全绿
   ├─  5 config
   ├─  5 events     (Bus 广播 + ring + meta-only-latest)
   ├─ 12 semantic   (与 Rust 端 case 等价)
   ├─  5 store      (sqlite CRUD + history cutoff)
   ├─  8 auth       (JWT + bcrypt + ExtractBearer)
   ├─  8 session    (PTY spawn + slug 算法)
   └─ 15 server     (REST + WS E2E)

二进制大小
   ├─ Go binary (host build):16 MB
   ├─ Go binary (Linux + distroless):预估 < 30 MB(没本地 docker 验证)
   └─ Rust GUI release:6.0 MB

跨实现端到端
   ├─ Rust bridge + 12 步 smoke ✓
   └─ Go server + 12 步 smoke    ✓
```

总测试 173/173 全绿(115 Rust + 58 Go)。

> Phase 9.2 Flutter App(`apps/mobile/`)9.2.0 + 9.2.1 已落地;9.0 + 9.1 + 9.3 全部就绪后,Flutter 端可联调任一 server 实现。跨平台契约由 `docs/protocol-smoke.sh --rust|--go` 统一锁住。

#### 风险与未决��项

- jsonl schema 是 codebuddy / claude 内部协议,版本升级可能破解析 → 协议加 schema_version,语义层用 best-effort 兜底
- 远程 AI 箱模式的环境变量 / 凭证管理(`ANTHROPIC_API_KEY` 等)— 容器化场景需要外置
- Plan 在 codebuddy / claude 双方的具体 jsonl 信号需要实测确认(目前只见过 ExitPlanMode 的提示文本,没确认是否有结构化字段)
- 多设备同时操作同一 session:简单"最后一次 input 赢"语义 + 显示当前 active 设备名

### Phase 10 — 共享 memory 系统(v0.3)

**目标**:让 kode 管理的所有 agent(codebuddy / claude / 未来的内置 agent)共享一个**项目级 gotcha 与经验沉淀池**,跨 tab、跨会话、跨 agent 类型。完整设计与论证见 [`.specops/specs/memory-design.md`](./memory-design.md);本节只列里程碑与状态。

**为什么是独立 Phase**:memory 的价值不依赖 Phase 8(内置 agent),对现有 codebuddy / claude 已经成立 → 应当先于 Phase 8 落地,且能为 Phase 8 提供基础设施。

**形态**:agent 通过 MCP stdio 工具访问 → 提议进 pending → 用户在 kode UI 审核 → approve 后才进检索池。能量预算调控提议泛滥;质量仪表盘观测 agent 写入水平。

**当前状态**(2026-06-07 校准):
- M1 / M2 / M3 / M6 **已落地**(commit `0f187a4`),`crates/kode-memory/` 3282 行 + 31 测试全绿
- baseline 实测 **Top-5 73.3% / Top-1 60.0%**(过 70% 验收线;新打分公式重新基线后保持)
- CLI(`kode-memory`)+ MCP server(`kode-memory-mcp`)+ docs(`MEMORY_QUICKSTART.md`)三件套完整,可独立 dogfood
- **M4 GUI 集成已落地**(2026-06-06):review queue + Cmd+Shift+M + 状态栏徽章 + MCP setup banner + prompt-only 注入开关
- **M4.1 MCP setup 自动检测**(2026-06-06):启动 800ms 探测 codebuddy 配置,banner 一键 `mcp add`,dismiss 持久化,`memory_mcp_*` Tauri 命令 + UI 入口
- **M4.2 prompt-only 注入**(2026-06-06):新 `crates/kode-memory/src/prompt.rs` + `inject_kode_memory_prompt`,`Session::new` 通过 `--append-system-prompt` 注入指令段,教 codebuddy / claude / claude-internal agent 调 `memory_search` / `memory_propose`,跨 backend 共享同一池子;持久化 kill switch + 命令面板预览
- **M4.3 GUI 体验完善**(2026-06-07):metrics.jsonl 事件流 + Browse 面板(⌘⇧B)+ MemoryFactDetail 反链视图 + RelatedFactPicker(edit-then-approve 时建链)+ 状态栏 hover 卡片(今日 propose / 7天接受率 / per-author 能量)+ links 表 + 双向链 + dead_end 三字段 + applies_to glob 加分 + recall_clicked 反馈环 + 时间衰减打分 + Browse filter 持久化。新增 5 Tauri 命令、4 Svelte 组件,共 239 测试全绿
- **v1 真正剩余 = Phase 10.9 Obsidian-compat vault**;M5 GUI 仪表盘 / M7 / 10.14 LLM 助攻 / embedding 推到 v1.1+

#### Phase 10.1 — M1 数据层(4 天)✅
- [x] facts/ + pending/ + archive/rejected/ 目录与原子写(`store.rs` 1151 行)
- [x] SQLite FTS5 索引(`tokenize='trigram'`)
- [x] `reconcile()`:启动时扫 facts/ 重建 SQLite 缺失项(quickstart §6 已说明删 SQLite 重启不丢数据)
- [x] 验收:并发 1000 写入无丢失(`tests/concurrent.rs` 107 行)
- 实现:commit `0f187a4`

#### Phase 10.2 — M2 MCP 工具(2 天)✅
- [x] `memory_search` / `memory_read` / `memory_propose` / `memory_list_recent`(agent 可调)
- [x] `memory_list_pending` / `memory_review` / `memory_deprecate`(仅用户可调)
- [x] **prototype 里的 `memory_write` 已移除**(改成 propose 走待审)
- [x] 错误码:`out_of_energy` / `duplicate` / `scope_invalid` / `body_too_long`
- [x] 验收:`bin/mcp_server.rs` 452 行 + `tests/e2e_flow.rs` 350 行集成;`duplicate` 通过 BM25 Top-1 阈值检测,quickstart §3 已演示
- 实现:commit `0f187a4`

#### Phase 10.3 — M3 能量预算(1 天)✅
- [x] `budget.json` 每个 author 一条记录(`budget.rs` 270 行)
- [x] propose -1 / approve +0.5 / reject 额外 -1 / blacklist 额外 -2
- [x] 0 能量时 propose 返回 `out_of_energy` + `next_refill_at`
- [x] 24h 缓慢回血
- [x] 验收:quickstart §8 已锁住 5.00→4.00→4.50 / 4.00→3.00 数值
- 实现:commit `0f187a4`

#### Phase 10.4 — M4 审核 UI ✅(2026-06-06 完成)
> GUI 入口 = memory 真正"走起来"的最后一公里。已落地 M4 + M4.1 setup banner + M4.2 prompt-only 注入。

**M4 review queue**(`apps/gui/src-tauri/src/memory.rs` + `App.svelte`):
- [x] kode GUI memory 视图(命令面板入口 + `Cmd+Shift+M` 快捷键)
- [x] 待审队列 dialog:approve / edit-then-approve / reject / blacklist 一键操作
- [x] 状态栏:有待审时显示 pending 数字徽章
- [x] `apps/gui/src-tauri/` 直接依赖 `kode-memory` lib(零 IPC 开销)
- [x] 端到端验收:`memory_propose` → 状态栏徽章亮 → ⌘⇧M 审核 → fact 进检索池

**M4.1 codebuddy MCP setup 自动检测**(`memory_mcp.rs`,~450 行 + 7 测试):
- [x] 启动后 800ms 探测 codebuddy CLI + `~/.codebuddy.json` 是否配 `mcpServers.memory`
- [x] 未配 + 未 dismiss → emit `memory-mcp-setup-required` → 浮层 banner 提示
- [x] 一键 `codebuddy mcp add -s user memory <bin> -e KODE_MEMORY_ROOT=...`
  - **关键回归**:positional 必须在 `-e` 之前(commander.js 的 `-e <env...>` 是 variadic)
  - 测试:`setup_args_put_positional_before_dash_e`
- [x] "暂不提示"持久化到 `state.json::mcp_prompt_dismissed_at`
- [x] 命令面板"Memory MCP: 重新检测 / 配置 codebuddy…"手动入口
- [x] banner z-index 修复(`.memory-mcp-floating { position: absolute; z-index: 5 }`)避免被 term-wrapper 覆盖

**M4.2 prompt-only 注入**(prompt-only,2026-06-06,~290 行 + 10 测试):
- [x] `crates/kode-memory/src/prompt.rs`:`PROMPT_TEMPLATE`(~80 行 markdown,中文)+ `build()`
  - `<kode-memory>` XML 标签包裹,3 条 trigger / 4 条 anti-trigger 强约束
  - 显式列工具名(`memory_search` / `memory_propose`)+ 能量预算说明 + supersedes 申诉路径
- [x] `crates/kode-core/src/session/mod.rs::inject_kode_memory_prompt`
  - 沿用现有 `inject_*` 模式;尊重用户已显式 `--append-system-prompt` / `--system-prompt` / `--system-prompt-file`(不覆盖)
  - kill switch 关闭时短路;空 prompt 也短路
  - 5 个回归测试(disabled / explicit_user_prompt / empty / order / 与 permission_mode 共存)
- [x] `Session::new` 加 `kode_memory_prompt_enabled: bool` 参数,GUI 从 `PersistedState::kode_memory_prompt_enabled`(默认 true)读取
- [x] Tauri 命令 `memory_prompt_status` / `memory_prompt_set_enabled`(在 `memory_mcp.rs`)
- [x] 命令面板 2 项:"Memory Prompt: 预览注入内容…"(dialog 显示完整文本)/ "Memory Prompt: 启用 / 禁用"
- [x] 跨 backend 闭环:codebuddy / claude / claude-internal 通过同一 MCP server 共享 `~/.kode-memory/`,scope 用 `project:<cwd-slug>` 隔离
- [x] 数据流:agent → MCP `memory_propose` → pending → 用户审核 → facts/ → 跨 tab `memory_search` 召回

**测试增量**(基线 → 当前):kode-core 81 → 86(+5) / kode-gui 67 → 68(+1) / kode-memory 25 → 29(+4),总计 183/183 全绿

#### Phase 10.5 — M5 metrics 事件流最小集(0.5 天)— **v1 收尾,GUI 仪表盘留 v1.1**
> 决策:v1 只埋点不出图。embedding / 仪表盘看 dogfood 真实数据再做。

- [ ] `metrics.jsonl` append-only 事件流:propose / approve / edit_then_approve / reject / blacklist / search / recall
- [ ] CLI `kode-memory dashboard` 已有总览,**v1 只新增"7 天接受率 + 按 author 分组接受率"两行**
- [ ] 验收:跑一周 dogfood 后 `metrics.jsonl` 有真实数据,CLI 能算出每 author 的接受率
- [ ] 不变量:metrics.jsonl 永远 append-only(MEMORY_DESIGN §8.7)

#### Phase 10.6 — M6 Baseline 数据(1 天)✅
- [x] 从 `CODEBUDDY.md` / `ROADMAP.md` 抽 51 条高质量种子 fact(`kode-memory init --with-baseline`)
- [x] 30 个"模拟提问"(`tests/baseline_recall.rs`)
- [x] `crates/kode-memory/tests/baseline/` 套件 + Top-1/Top-5 召回准确率
- [x] 验收:**Top-5 73.3% / Top-1 60.0%**,过 70% 线
- 实现:commit `0f187a4`

#### Phase 10.7 — M7 老化追踪(1 天)— **v1.1+,不动**
- [ ] 月度抽 20% 已 approve fact,启动时弹 "这条还准吗?" 复审 prompt
- [ ] `feedback.jsonl` 记入 → 两个月后能算"approve 后真实存活率"

---

> **2026-06-06 v1 范围扩展(Phase 10.9 - 10.14)**:讨论了 Mem0 / MemTree / Zep / MemoryOS / Obsidian 五种范式,
> 决定吸收 6 项改进进 v1。embedding 推后到 v2,先看 E + E′ 能否把 Top-5 从 73.3% 推到 ≥ 80%。
> 决策详见底部 Decision Log "2026-06-06 memory v1 范围扩展"。

#### Phase 10.9 — A: Obsidian-compat vault(0.5 天)— v1
> **定位:Obsidian 与 kode 自带 GUI 双推**。用户不装 Obsidian 仍可用 CLI / kode GUI。
> 装了 Obsidian 白嫖图谱 / 反链面板 / 全文搜索 / 移动端 / Dataview。

- [ ] 文件名改为 `<ULID>--<slug>.md`(ULID 可排序保留 + 一眼可读)。reconcile 兼容旧的纯 ULID 文件名
- [ ] frontmatter 链字段双语法:`supersedes: "[[01HXYZ]]"` 解析成 ULID,序列化也带 `[[`.specops/specs/memory-git-sync.md`]]`
- [ ] 内部目录拆分:私有数据(`index.sqlite` / `budget.json` / `metrics.jsonl` / `tmp/`)挪到 `~/.kode-memory/.kode-memory/`,vault 根只剩 Obsidian 友好的 `facts/ pending/ archive/ templates/ .obsidian/`
- [ ] 提供 `.obsidian/workspace.json` + `graph.json` 模板,`kode-memory init --obsidian` 安装
- [ ] **不索引规则**:`facts/` 下不带合法 frontmatter 的 .md 视为用户笔记,reconcile 跳过 — Obsidian 用户可在 vault 里随手记日记不会污染池子
- [ ] reconcile 走 fsnotify 增量(用户在 Obsidian 改了文件 → 我们更新索引)
- [ ] quickstart 加一节"用 Obsidian 当 memory 前端"

#### Phase 10.10 — B: 双向链 + 反链(0.5 天)— v1
- [ ] frontmatter 新增 `related: [...]` / `contradicts: [...]`(语义同 Obsidian wikilinks)
- [ ] SQLite 加 `links` 表 `(src_id, dst_id, kind)`,kind ∈ {supersedes, related, contradicts}
- [ ] `memory_read(id)` 返回值多带 `backlinks: [...]`(谁引用了我)
- [ ] 检索路径扩展:Top-K 命中后,顺藤摸 `related` 一跳推荐(限 +3 条)
- [ ] 验收:在 vault 里手动 `[[link]]` 两条 fact,Obsidian 图谱视图能看到边

#### Phase 10.11 — C: 结构化分类 + dead_end(0.5 天)— v1
> **dead_end 是这次最重要的新增**。agent 复活率最高的失败模式 = "上次试过 X 不行,这次又试一遍"。
> 给"试过 X / 因为 Y / 改用 Z"一等公民结构,比挤在 tags 强 10 倍。

- [ ] frontmatter 新增 `kind: gotcha | pattern | decision | constraint | convention | dead_end`
- [ ] `dead_end` 增三个可选字段:`tried: <text>` / `failed_because: <text>` / `use_instead: <text>`
- [ ] frontmatter 新增 `subsystem: <name>`(自由字符串,项目维护命名)
- [ ] tags 仍保留,语义改为"跨 subsystem 主题"(deadlock / perf / hidpi 等),不再混进种类
- [ ] `memory_search` 增 `kind?` `subsystem?` filter
- [ ] baseline 50 条种子 fact 全部回填 kind / subsystem,30 个 query 加几个 dead_end 检索

#### Phase 10.12 — D: 路径 glob scope(0.5 天)— v1
- [ ] frontmatter 新增 `applies_to: ["crates/kode-core/pty/**", ...]` 可选
- [ ] `memory_search` 加 `current_path?` 参数
- [ ] BM25 命中后,applies_to 命中 `current_path` → score × 1.3 加分
- [ ] MCP server 接当前 cwd / 当前编辑文件路径(从 agent 端透传)— 这条要 codebuddy / claude 配合

#### Phase 10.13 — E + E′: 检索反馈环 + 时间衰减(1 天)— v1
> v1 不上 embedding 的关键。**先吃这个,看 baseline Top-5 能否从 73.3% 推到 ≥ 80%**。

- [ ] SQLite facts 表加 `recall_count_30d` / `recall_clicked_count_30d` / `last_recalled_at`
- [ ] metrics.jsonl recall 事件回写这三个字段(后台 task 每小时聚合一次)
- [ ] 新打分公式:
  ```
  score = bm25 * 0.55
        + confidence * 0.15
        + log(recall_clicked_30d + 1) * 0.10        # 反馈环
        + recency_decay(created, half_life=180d) * 0.10   # E′ 时间衰减
        + path_match_bonus * 0.10                  # D 路径加分
  ```
  系数取整数倍便于调参,baseline 跑一遍 → 调
- [ ] **门槛**:跑完 v1 收尾后 baseline Top-5 < 80% → 触发 Phase 10.15(embedding);≥ 80% → embedding 推 v2

#### Phase 10.14 — F: review LLM 助攻(0.5 天)— v1,依赖 M4 GUI 通
- [ ] kode GUI 审核 dialog 打开时后台调一次 LLM(用户绑定的某个后端,默认 claude-haiku 省钱)
- [ ] LLM 看到 pending 这条 + Top-3 相似 fact,返回 ≤ 3 条建议:
  - "建议 supersedes #XYZ(理由:...)"
  - "建议拆成两条:① ... ② ..."
  - "建议改写:..."
- [ ] 用户一键应用 / 忽略
- [ ] 验收:dialog 打开 → 1.5s 内出建议;不出也不阻塞 review
- [ ] 不变量:LLM 只给候选,**不替代用户决定**

#### Phase 10.15 — embedding 重排(v1.1 或 v2,看 10.13 baseline)
- [ ] fastembed-rs 集成,bge-small-zh 多语模型
- [ ] facts 入库时算 384 维向量存 SQLite BLOB
- [ ] 检索:BM25 取 Top-50 → embedding cosine 重排取 Top-K
- [ ] 验收:baseline Top-5 ≥ 90%

#### Phase 10.16 — 不做的事(明确划线)
- ❌ 完整 MemTree 自动建树:< 500 条规模没必要,加新 fact 整树重排导致 git churn 崩
- ❌ Zep bitemporal 时序图:90% fact evergreen,supersedes + 单字段 software_version 已够
- ❌ MemoryOS 真分层存储:SQLite + facts/ 已混合担当 hot+cold,分层是 v3
- ❌ Daily notes / 会话日志进 vault:那是 trace,会污染池子
- ❌ Mem0 风格 LLM 自动入库:违反"提议+审核"门槛
- ❌ agent 自己判断 supersedes:池子毒化最快路径

#### Phase 10.17 — git 同步(去中心化跨机/remote)— 设计完成,**已实现**

> **决策**:走去中心化 git 同步而非中心 server。完整设计见 [`.specops/specs/memory-git-sync.md`](./memory-git-sync.md)。
> 外部 git CLI + union merge + approve-push + 启动 pull→reconcile。能量点/metrics 留 `.kode/` 不同步(各机本地)。

- [x] `crates/kode-memory/src/git_sync.rs`:ensure_git_available / init_repo / commit_and_push / pull_union / sync
- [x] `SyncConfig`(`.kode/sync.json`):remote / branch / auto_sync / auto_push;load/save
- [x] `cli.rs`:`Cmd::Sync` 子命令(`--init`/`--remote`/`--enable`/`--disable`/`--no-push`)
- [x] `cli.rs` cmd_review + GUI `memory_review`:approve 后 best-effort commit+push(store 不碰 git)
- [x] GUI `memory.rs`:`spawn_sync_task` 启动 pull→reconcile 一次(不做 interval)
- [x] `.gitattributes` `facts/*.md merge=union`;`.kode/` 在 repo 外天然隔离
- [x] 测试:临时目录真 git,bare remote 两仓互推 union 合并 + reconcile 重建索引;降级路径(无 git/无 remote/push 失败不阻塞 approve)
- 不变量:`.kode/` 永不进 git / pull 后必 reconcile / sync 失败不坏 vault / agent 不能 push / approve 永不因 sync 失败

#### Phase 10.18 — 远端 memory 审核(协议侧)— 设计完成,待实现(~2 天)

> **决策**:远端写、本地审;Go server exec `kode-memory` CLI(`--json`)转发;走 Phase 9 协议 REST。
> 完整设计见 [`.specops/specs/memory-git-sync.md` §11](./memory-git-sync.md#11-远端-memory-审核remote-review协议侧-设计完成待实现)。

- [ ] 阶段 A:`kode-memory` CLI 加 `--json`(pending/review/search),稳定 DTO + 单测
- [ ] 阶段 B:Go server `MemoryConfig` + `runMemoryCLI` + 3 端点(`/api/v1/memory/*`)+ hello 能力位
- [ ] 阶段 C:GUI 3 个 `*_remote` Tauri 命令(复用 `endpoint_fs_list` 模式)+ `MemoryPanel` endpoint 下拉
- [ ] 阶段 D:`PROTOCOL.md` §4.12-4.14 + `connection.hello` memory 能力
- 不变量:提议+审核门槛不变 / Go 只转发不重写 / CLI 不可用 503 降级 / bearer 复用 / exec 无注入 / 复用既有 DTO

#### Phase 10.8 — GUI 仪表盘(v1.1)
- [ ] GUI 仪表盘视图:7/30 天接受率 / 编辑率 / 拒绝率 / 黑名单率 / top tags / 跨 agent 对比柱状图
- [ ] 跨 author 质量对比图

#### v1 范围(2026-06-06 三次修订)
**已完成**:
- M1 + M2 + M3 + M6(commit `0f187a4`)
- **M4 GUI 集成 + M4.1 MCP setup banner + M4.2 prompt-only 注入**(2026-06-06,本批次)

**v1 收尾剩余**:
- M5 事件流最小集(0.5 天)
- 10.9 Obsidian-compat(0.5 天)
- 10.10 双向链(0.5 天)
- 10.11 结构化分类 + dead_end(0.5 天)
- 10.12 路径 glob scope(0.5 天)
- 10.13 检索反馈环 + 时间衰减(1 天)
- 10.14 review LLM 助攻(0.5 天)
**v1 剩余 4 天**(M4 已落地)

**v1.1**:GUI 仪表盘(10.8) + M7 老化追踪(10.7) + 视 baseline 决定 embedding(10.15)
**v2**:git 同步(10.17,已实现) / 远端审核(10.18,设计完成) / embedding(若 v1 baseline ≥ 80%)

#### 关键不变量(改代码前必读,详见 MEMORY_DESIGN.md §8)
1. `facts/*.md` 是 source of truth;SQLite 是可重建索引
2. 写入路径必须原子:tmp → fsync → rename → SQLite 同事务
3. agent 不能直接写 facts/,必须走 `memory_propose` → 用户审核
4. FTS5 必须用 trigram tokenizer(unicode61 不分词中文)
5. 能量点变化必须事件驱动,不要批量 / 异步
6. **(10.9 新)** vault 根只有 Obsidian 友好的 `facts/ pending/ archive/ templates/ .obsidian/`,
   私有数据(SQLite / budget / metrics)在 `.kode-memory/` 隐藏子目录
7. **(10.9 新)** `facts/` 下不带合法 frontmatter 的 .md 视为用户笔记,reconcile 跳过
8. **(10.14 新)** review LLM 助攻只给候选,不能替代用户决定;1.5s 不返回也不阻塞 review
9. **(M4.2 新,2026-06-06)** prompt 注入路径必须**尊重用户**:已显式 `--append-system-prompt` / `--system-prompt` / `--system-prompt-file` 时短路不覆盖;`kode_memory_prompt_enabled = false` 时短路;只对**新 spawn** 的 tab 生效,不重写现存子进程 args
10. **(M4.1 新,2026-06-06)** codebuddy MCP 配置只能通过 `codebuddy mcp add` CLI 写,**不直接 mutate `~/.codebuddy.json`**(schema 真源在 codebuddy 自己手里);positional 必须在 `-e <env...>` 之前(commander.js variadic)

#### Phase 10 风险与未决事项
- **跨机同步**:✅ 方案已定(Phase 10.17,已实现)。能量点/metrics 留 `.kode/` 不同步。远端 pending 审核见 10.18(协议侧,Go exec CLI 转发)。
- **embedding 检索**(v2):fastembed-rs 集成时 rerank 公式怎么调?BM25+confidence 已能用,看 baseline 数据再决定是否上
- **agent 自动 supersedes 策略**:agent 看到老 fact 觉得过时,是它该判断还是只该提示用户?

### Phase 11 — Remote Backend in GUI(v0.3,草拟于 2026-06-09)

让 GUI 既能开本地 PTY tab(默认、零回归),也能连**远端 `kode-server-go`** 开 tab,远端 codebuddy/claude 在远端跑。复用 Phase 9 协议层全部投资,不写 SSH 包装。

**核心不变量**:本地 tab 不走协议层,Local 与 Remote 是真正分叉的两条路径,只在 Tauri command 入口分流(防 ROADMAP §484 PTY → 像素 P99 < 16ms 回归)。

完整 checklist + 决策日志见 [`.specops/specs/roadmap-phase-11.md`](./roadmap-phase-11.md)。

| 子阶段 | 主题 | 工时 | 状态 |
|---|---|---|---|
| 11.1 | 协议补丁:resize / list backends / list dirs / pty_bytes | 0.5 天 | ✅ `8ccb81b` |
| 11.2 | `SessionTransport` 入口分流(不抽字节路径) | 0.5 天 | ✅ `d4f8b2f` |
| 11.3 | `RemoteTransport`:reqwest + tokio-tungstenite + 自动重连 | 1 天 | ✅ `d4f8b2f` |
| 11.4 | Endpoint 配置 + token 存 state.json + 配对 UI | 0.5 天 | ✅ `c281518` |
| 11.5 | BackendChooser 双分组 UI(本地 / 远端) + RemoteCwdPicker | 0.5 天 | ✅ `c281518` |
| 11.6 | 状态栏连接指示 + SSH -p 端口支持 | 0.25 天 | ✅ `cf5f6ef` |
| 11.7 | 端到端验证:Rust bridge smoke step 1-16 全通 | 0.25 天 | ✅ `c2f4fbe` |

**SSH 模式附加**:GUI 内嵌 SSH 隧道(`d0bd128`),通过 `ssh -N -L` 连无公网 IP 的 devcloud server — 相当于用 SSH 当传输通道而不需要 Tailscale。见 `services/kode-server-go/deploy/DEPLOY.md`。

**预估** 3.5 天。依赖 Phase 9.0 协议契约 + 9.3 Go server。

## v0.2 MVP 验收标准(Phase 0-6 完成)
- [ ] **独立 .app 启动**(双击 / Spotlight / dock 图标)
- [ ] 多 tab 全应用快捷键自治(Cmd+T/W/1..9/P 等),不受宿主影响
- [ ] xterm.js 渲染 codebuddy 与系统 Terminal.app 视觉无差异
- [ ] model / title / tokens / cost 实时从 jsonl 同步
- [ ] 主题深浅切换 + 跟随系统
- [ ] 复用 kode-core 100%(无 PTY/session 重复代码)

### 性能(硬约束,与 TUI 版"极致性能 + 零渲染问题"初衷一致)
- [ ] 启动到首个 tab 可见 P99 **< 400ms**
- [ ] dmg **< 15 MB**
- [ ] 单 tab 空闲 CPU **< 0.5%**
- [ ] PTY 字节 → 像素端到端延迟 P99 **< 16ms**(60 FPS)
- [ ] tab 切换感知延迟 < 50ms(snapshot 重建)
- [ ] 10 个 tab 内存增长 < 100MB(LRU 缓存生效)
- [ ] dump 100KB 输出不丢字符不撕裂

### 渲染零问题(继承 TUI 版)
- [ ] 不闪烁 / 不撕裂 / 不丢字符 / 字体加载不重排
- [ ] WebGL 失败优雅降级 canvas
- [ ] HiDPI 切显示器后字符不模糊
- [ ] 窗口快速拉伸不撕裂(resize debounce 生效)

## 决策日志(从 v0.1 继承 + 切换决策)

- **2026-06-06 memory 跨 backend 共享走 prompt-only 注入,不做镜像 / 不做 LLM 提炼**(M4.2)
  问题:codebuddy / claude / claude-internal 三家都有自家 auto-memory 机制(各写各的 `~/.codebuddy/projects/<slug>/memory/*.md` 或 `CLAUDE.md`),tab 之间不通。
  讨论的方案:
    - (a) **file watcher + cache 镜像**:监听三家 memory dir,用 LLM 提炼并镜像到 kode-memory。否决:LLM 提炼引入新依赖 + 不可靠 + 镜像漂移
    - (b) **observer agent 解析 PTY**:通用但 brittle,违反 §8 不变量
    - (c) **session 结束 LLM 总结**:延迟高 + 仍需 LLM
    - (d) **prompt-only 注入**(选定):只动 system prompt,通过 `--append-system-prompt` 教 agent 调 `memory_search` / `memory_propose`。所有 backend 共用 kode-memory MCP server → 数据天然共享。零 file watcher、零 LLM 调用、零镜像
  结论:**最薄方案胜出**。agent 仍是写入主体,审核闸门 + 能量预算 100% 保留。原 backend 自家 memory 路径不动(允许并存,坏处仅是冗余);kode 只在子进程系统 prompt 末尾追一段指令。
  落地:`crates/kode-memory/src/prompt.rs` PROMPT_TEMPLATE + `kode-core::session::inject_kode_memory_prompt`(沿用 inject_* 模式)+ persistence kill switch + GUI 命令面板预览。
  关键不变量:尊重用户已显式 system prompt(不覆盖)+ kill switch 默认开 + 只对新 spawn tab 生效

- **2026-06-06 codebuddy MCP setup 走 CLI 不直写 JSON**(M4.1)
  问题:GUI 启动后要让 codebuddy / claude tab 能调到 `memory_search` 等 MCP 工具。stdio MCP 模型下 server 由调用方 spawn,kode 进程层无法集中 spawn。
  方案:启动 800ms 探测 → 未配 → banner → 一键调 `codebuddy mcp add -s user memory <bin> -e KODE_MEMORY_ROOT=...`(写 `~/.codebuddy.json` 的真源是 codebuddy 自己,我们不直接 mutate)。生命周期一起 = kode 退 → tab 退 → codebuddy 退 → 各自 spawn 的 `kode-memory-mcp` child 自然退。所有 child 共指 `KODE_MEMORY_ROOT=~/.kode-memory` → 数据共享;scope `project:<cwd-slug>` → 工程隔离
  踩坑:commander.js `-e <env...>` 是 variadic,会吞后续 token。必须 `... -s user <name> <command> -e KEY=val`,不能 `... -s user -e KEY=val <name> <command>`。回归测试 `setup_args_put_positional_before_dash_e` 锁住

- **2026-06-06 memory v1 范围扩展**(Phase 10.9 - 10.14)
  讨论了 5 种 memory 范式:Mem0 / MemTree / Zep / MemoryOS / Obsidian。结论:
    - **抄 Obsidian**:vault 兼容(双 GUI 路线 — kode 自带 + Obsidian)。文件名 ULID--slug、frontmatter `[[link]]` 双向链、私有数据挪到隐藏子目录
    - **抄 Mem0 一点**:review 时后台调 LLM 给 supersedes/拆分/改写候选,不替代用户决定
    - **抄 Obsidian 反链**:related / contradicts 字段 + SQLite 反链表
    - **dead_end 一等公民**(原创):agent 复活率最高的失败 = "上次试过 X 不行又试一遍",给 tried/failed_because/use_instead 显式结构
    - **路径 glob scope** + **检索反馈环 + 时间衰减**:轻量自适应,试图把 Top-5 73.3% 推到 ≥ 80%
  否决:
    - 完整 MemTree 自动建树(< 500 条规模 overkill,cluster 漂移 git churn)
    - Zep bitemporal 时序图(90% fact evergreen,supersedes 已够)
    - MemoryOS 真分层存储(规模不到)
    - Mem0 自动入库 / agent 自动 supersedes(都违反"提议+审核"门槛 - 池子毒化最快路径)
  embedding 推到看 10.13 baseline:Top-5 < 80% 触发 v1.1 上 embedding,≥ 80% 推 v2

- **2026-06-13 memory 跨机同步走去中心化 git 同步,不走中心 server**
  用户先问"无感+优雅的跨机/remote 方案",候选包括中心化(挂 kode-server-go)、Syncthing P2P、git 同步。
  中心化否决理由:单点故障、离线不可用、需改协议+server 模块(工程量大)。
  Syncthing 否决理由:无版本历史、审核流(pending→approve)跨机不清晰。
  选定 **git** 理由:ULID 文件粒度天然 union-merge 无冲突、有完整版本历史+审计、`reconcile()` 已就绪(pull 后重建索引)、`.kode/` 物理在仓库外天然隔离。
  kode-memory 自管 repo 同步(`kode-memory sync`),用户不手动 git。
  配置:外部 git CLI(系统自带,缺失给平台引导) + approve 后 best-effort push + 启动 pull 一次 + `.kode/sync.json` 总开关。
  落地:Phase 10.17(已实现),详见 [`.specops/specs/memory-git-sync.md`](./memory-git-sync.md)。

- **2026-06-13 远端 memory 审核走"远端写、本地审",Go exec CLI 转发**
  用户确认 codebuddy 跑 remote 宿主(模式 A),远端 agent 的 propose 落到远端 `~/.kode-memory/vault/pending/`,本地 GUI 看不到。
  否决"远端只读不写"(方案丙,会丢失远端 agent 的沉淀)与"Go 重写 memory 逻辑"(双实现漂移风险)。
  选定 **Go exec `kode-memory` CLI `--json`**:复用 Rust 全部 memory 逻辑(查重/能量/审核门槛),Go 只当 HTTP 转发层,零漂移。
  数据流:本地 GUI → Phase 9 REST → Go server → exec `kode-memory` CLI `--json` → 解析回传。
  闭环:审核走协议(实时),数据落地仍走 git push(去中心化)——审批 approve 后远端 CLI 的 commit_and_push 仍触发。
  落地:Phase 10.18(设计完成,待实现),详见 [`.specops/specs/memory-git-sync.md` §11](./memory-git-sync.md#11-远端-memory-审核remote-review协议侧-设计完成待实现)。

- **2026-06-06 Phase 10 进度校准 + v1 范围收紧**
  现状(commit `0f187a4`):M1/M2/M3/M6 已落地,baseline Top-5 73.3%,CLI + MCP server + 31 测试全绿
  v1 真正剩余:**M4 GUI 集成(P0,3 天)+ M5 事件流最小集(0.5 天)**,共 3.5 天
  推迟:M5 GUI 仪表盘 → v1.1;M7 老化追踪 → v1.1+;embedding 重排 → v2(看 dogfood 是否真有召回问题再做)
  原因:M4 是 memory "走起来"的最后一公里 — LLM 提议如果用户不能在 GUI 里看到,等于没用。
  其余增强先压住,优先用 dogfood 数据指导决策

- **2026-06-02 共享 memory 系统作为 Phase 10 独立立项**
  原因:agent 跨 tab / 跨会话共享项目级 gotcha 与经验,价值不依赖 Phase 8 内置 agent
  替代方案否决:
    (a) 塞进 Phase 8 — 会拖延 memory 落地,且 Phase 8 自身规模未明
    (b) 用 `CLAUDE.md` 顶部段做 — 粒度太粗、不可被 LLM 增量更新、不可结构化检索
    (c) 让 agent 直接写 fact 文件 — 写入门槛低 → 池子被低质量内容稀释 → 检索质量塌
  选定:**MCP stdio + 提议+审核流 + 能量预算**,见 `.specops/specs/memory-design.md`。
  Prototype 已在 `crates/kode-memory/` 验证并发安全 + stdio 桥接;v1 把 `memory_write` 改造成 `memory_propose`

- **2026-05-30 TUI v0.1 → GUI v0.2**
  原因:用户三条强需求(快捷键冲突宿主 / UI 受限 / 未来 agent UI)
  替代方案否决:fork wezterm(框架受限)、wezterm-term + winit 自拼(工作量 4-8 周)、Electron(体积大、安全性)
  选定:**Tauri 2 + xterm.js + Svelte 5**,因为出活快(1.5-2 周)+ Rust 后端可复用 60% 现有代码 + 前端任意 UI

- **为什么不选 native 原生 GUI(egui / iced / gpui)**
  Rust 原生 GUI 启动 < 50ms / 二进制 < 10MB,跟"极速"最贴。
  **但**终端模拟内核要自己造(xterm.js 等价物在 Rust 生态不存在,vt100 只是 parser 不含渲染);
  造一个 production 级 = 4-8 周;放弃。
  Tauri 2 已经能做到 <400ms / <15MB,差距可接受。

- **为什么不选 wezterm-mux + 自写前端**
  wezterm 已经有 mux 协议(多 client 共享后台 PTY),理论上可以白嫖。
  **但**:mux 协议未公开稳定 API、版本兼容性风险、强耦合 wezterm 进程在背后跑;放弃。

- **为什么 Svelte 5 不是 SvelteKit**
  SvelteKit 是 SSR 框架,桌面 SPA 用不到 SSR、文件路由、server hooks。
  纯 Svelte 5 + Vite + runes 模式:bundle 更小、启动更快、心智更简单。
  此调整是"启动 < 400ms / dmg < 15MB"硬指标决定的。

- **为什么 Svelte 不是 React/Vue**
  体积最小、编译后 JS 量最少、对小应用最优;React/Vue 生态更大但对 kode 量级 overkill

- **为什么 xterm.js 不是自己用 canvas 渲染 vt100**
  xterm.js 是 VSCode / GitHub Codespaces / Cursor 都在用的生产级方案,支持 sixel / image inline / 链接识别 / WebGL 加速。自己造 = 倒退 5 年

- **为什么 Tauri 2 不是 Tauri 1**
  v2 stable 已发布(2024-10),event channel API、菜单 API、updater 都比 v1 完善;新项目没必要选 v1

- **为什么后端字节流用 Channel 不是 emit**
  emit 走 JSON IPC,每帧字节要 base64 + JSON parse,高频时延迟高;Channel 是 v2 新增的高吞吐二进制管道

- **为什么 Rust 端要 byte coalescing(8ms)**
  TUI 版主循环 `while let Ok(more) = evt_rx.try_recv()` 已经 batch;
  GUI 版跨进程 IPC 比 mpsc 贵得多,不 batch 就裸跑会被 `cat` 大文件打挂前端事件循环

- **为什么 xterm 实例不全部常驻 DOM**
  TUI 版常驻的是 vt100 Parser(纯数据 ~50KB/tab);
  GUI 版每个 xterm 实例约 5MB DOM/canvas,10 个 = 50MB 浪费。
  正解:vt100 Parser 在 Rust 端常驻,前端 LRU 缓存 1-3 个 xterm,切换时用 snapshot 重建

- **(继承自 TUI)为什么不在 codebuddy args 加 positional**
  positional 第一个被当 prompt → 自动发给 LLM。回归测试已锁

- **(继承自 TUI)为什么读 jsonl 不解析 stream-json stdout**
  codebuddy 交互模式不输出 stream-json;`--print --output-format stream-json` 是非交互模式

- **(继承自 TUI)为什么 default_model 也要注入 --model**
  否则启动到第一条 jsonl 回写之间状态栏显示 "auto",体验差;
  注入后第一帧就显示对的模型,且子进程也用对模型(避免 codebuddy 默认模型变化导致用户困惑)

## 不会做的事(刻意 out of scope)

- 自带终端模拟器内核(用 xterm.js,不自己造)
- 自带 LLM 调用 SDK(用 HTTP/SSE 走官方 API,不绑定 SDK)
- 内置代码编辑器(用户应该用 VSCode / Cursor / vim)
- 同步到云端(隐私 + 复杂度)
- iOS / Android(移动端不是终端用户主战场)
- TUI 版继续演进(冻结于 v0.1.0)

## 性能基线(v0.1 TUI 留底,v0.2 验收时对比)

测于 macOS / M-series,2026-05-30 TUI v0.1:
- 启动到首个 tab 可见:< 100ms
- cargo build 增量:~5s
- cargo build --release:~13s
- cargo test:0.49s(33 个)
- release 二进制:2.4 MB(LTO + strip)

**v0.2 GUI 硬指标**(继承"极致性能"初衷,允许相对 TUI 放宽,但严格于业界平均):
- 启动到首个 tab 可见 P99 < **400ms**(Tauri 2 + 系统 WKWebView 在 M 系实测 300-400ms 可达)
- dmg 体积 < **15 MB**(Tauri 2 不打包 webview;严格控制前端依赖)
- 单 tab 空闲 CPU < **0.5%**
- PTY → 像素端到端 P99 < **16 ms**
- 不达标的话回头优化,**不接受"可以更快但来不及"**

## 给接手的人(强烈推荐先读)

### 必读
1. `CODEBUDDY.md` — 项目速读 + 已知的坑(TUI 版的,仍然适用 core 部分)
2. **本文件** — 当前路线和决策

### 关键复用点(GUI 版直接拿)
- `crates/kode-core/src/pty/` — PtyHost 已经 100% 验证,**别重写**
- `crates/kode-core/src/session/jsonl_tail.rs` — codebuddy 状态文件解析,**别重写**
- `crates/kode-core/src/session/state.rs` + `heuristic.rs` — 纯数据,直接用
- `crates/kode-core/src/config.rs` — TOML 配置,默认值已对(注意 codebuddy args 必须空!回归测试已锁)

### 别动的关键约束(从 TUI 版继承)
1. **codebuddy args 不能加 positional**(会变 prompt)
2. **PtyHost::kill 用独立 killer**(避免与 reaper 死锁)
3. **启动 codebuddy 必须强制 `--session-id <uuid>`**(否则找不到 jsonl)
4. **vt100 的 resize 用 `screen_mut().set_size`**(注:GUI 版用 xterm.js 后这条不再适用,但 core 层若有人复用要知道)

### Phase 1 模块化的具体执行命令

已完成,作为参考保留在归档:[`.specops/specs/roadmap-phase-0-7.md`](./roadmap-phase-0-7.md) 的 Phase 1 段。

**剩余活跃工作**见上文 Phase 8 / 9 / 10。
