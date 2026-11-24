# Kode 扩展平台（L0–L2）设计

> 状态：草案（2026-11-23）。承接 PR #49 的扩展宿主，以及 11-17 定下的分工：Kode 管 backend CLI 和会话，编排、团队、dsh UI 等业务都做成扩展。
> 第一个业务消费方是 `kode-plugins/kode-team`（见该仓库的 `docs/architecture.md`）。
> 参考了 Cindy（Ghost 插件的权限组、device-link 白名单 + 能力位 fail-closed）、PiBot（`BrainCapability` + contract 分层、单一 policy 入口）、VS Code（activation events）。

## 1. 定位与分层

```
┌──────────── L3 扩展（策略，可替换、可独立发布）────────────┐
│ dsh UI（kode.new-ui） │ kode-team │ 编排 Crew │ SpecOps │ … │
└──────────────┬────────────────────────────────────────────┘
               │ kode.api/v1（HTTP + 推送） + agentTools 代理 + 视图桥
┌──────────────▼──────── L2 扩展平台 ────────────────────────┐
│ manifest/capability 授权 · 每个扩展一枚 scoped token · 审计 │
│ 贡献点：sessionViews / activityItems / sidebarSections /    │
│         panels / sessionActions / agentTools / notifications│
│ 生命周期：按 activation 拉起、空闲回收；宿主下沉 session-server│
│ identity providers / secrets（refresh token 永不出核心）     │
└──────────────┬────────────────────────────────────────────┘
┌──────────────▼──────── L1 通信底座（Fabric）───────────────┐
│ 节点身份、地址 {node_id, session_id}                         │
│ 持久消息 + 投递/取消回执（#48）· 事件总线（cursor + 推送）   │
│ 跨设备：SSH peers / cloud relay / mobile                    │
└──────────────┬────────────────────────────────────────────┘
┌──────────────▼──────── L0 Kode Core ──────────────────────┐
│ 15 个 backend · 会话生命周期（PTY / ACP / app-server）       │
│ 语义事件（以原生历史为唯一来源）· transcript · 工作区/worktree│
│ memory · 会话占用（runtime claim / import_session）          │
│ 伙伴（Bot）档案：身份 · 角色说明 · 记忆范围 · 权限上限 · 长期会话│
└────────────────────────────────────────────────────────────┘
```

伙伴的**身份**放在 L0，**行为**（定时任务、外部 IM、团队、编排）放在 L3。详见第 9 节。

**不变量**
1. L0–L2 里不出现 team、room、lead、worker、workflow 等业务名词，只有会话、消息、事件、工作区，以及扩展私有数据（不透明 JSON）。
2. 扩展永远不进 PTY 字节热路径；只消费语义事件，需要看终端时单独开字节流。
3. 扩展之间不直接互调；需要协作时，通过平台事件和会话消息，或者以后的 `ports` 契约（参考 PiBot：capability 之间只依赖彼此的 contract）。
4. 凭据、本地路径、完整 transcript 默认不越过账号边界；扩展要外发数据，走声明过字段的出口，并记审计。

## 2. 现状（main，2026-11-23）

| 已有 | 位置 |
|---|---|
| `kode.extension/v1` manifest：`capabilities`、`backend`（ready line / stdin EOF 退出 / progress line）、`contributes.sessionViews` | `apps/gui/src-tauri/src/extensions/manifest.rs`、`backend.rs` |
| 安装、升级、停用、卸载即时生效；随包内置扩展；扩展设置页、日志 | `extensions/mod.rs`、`ExtensionsSettings.svelte` |
| 扩展视图以子 webview 叠放，视图桥（注入脚本、隐藏跳转回传） | `extensions/view.rs`、`embed.js`、`ExtensionViewPort.svelte` |
| 左侧 ActivityRail 显示扩展视图入口 | `lib/ActivityRail.svelte` |
| PTY ↔ 结构化切换：`runtime/claim`、`runtime/request import_session` | `messaging/api.rs`、`lib/runtime_switch.ts` |
| 会话操作：create / input / interrupt / answer / transcript；`/ws` | `kode-bridge/src/lib.rs` |
| 会话间消息 + 投递和取消回执；跨节点 link v2 | `messaging/*`（#48） |

**缺口**（kode-team 和编排都依赖这些）

| # | 缺口 | 现状 |
|---|---|---|
| G1 | 权限过粗 | 只有 3 个 capability；`workbench` 会把 admin token 文件直接交给扩展 |
| G2 | API 分散 | 会话操作在 bridge `/api/v1/sessions`，通信在 `/api/v1/messaging`，两套鉴权，没有 SDK |
| G3 | 没有事件订阅契约 | `/api/v1/messaging/events` 只能拉取；`turn_completed` / `awaiting` 不对扩展开放 |
| G4 | 会话没有归属元数据 | 扩展建的会话没法标记 owner、parent、labels，重启后扩展无法恢复状态 |
| G5 | 扩展不能给 agent 加工具 | 想加 MCP 工具，只能各自去改 15 个 CLI 的配置 |
| G6 | 贡献点太少 | 只有 `sessionViews`（铺满会话区）；缺侧栏分组、主区域面板、会话操作、通知 |
| G7 | 扩展宿主挂在 GUI 上 | GUI 一关，扩展后端就停 |
| G8 | 没有身份 provider 和密钥存储 | kode-team 需要 IOA / Maestro Broker 令牌 |
| G9 | 没有长期 agent 身份 | `messaging/agents.rs` 和 dsh `agent-profiles.js` 只有启动模板（类型、可执行文件、参数、环境变量），没有名字、角色说明、记忆范围、权限上限，也没有跨原生会话延续的长期对话 |

## 3. 权限：capability 与 scoped token（G1）

```jsonc
"capabilities": [
  "sessions.read",          // 目录、元数据、transcript 片段
  "sessions.create",        // 只能在自己有权限的节点上建会话
  "sessions.input",         // 只能对 owner=自己 的会话写；对其他会话写，需要再声明 sessions.input.any
  "sessions.interrupt",
  "events.subscribe",
  "messaging.send",
  "workspaces.read", "workspaces.worktree",
  "agentTools.contribute",
  "ui.activity", "ui.sidebar", "ui.panel", "ui.sessionActions", "notifications",
  "identity.provider", "identity.token:<audience>", "secrets",
  "bots.read", "bots.manage", "bots.input",   // 伙伴，见第 9 节
  "net:<origin>",           // 只做声明和展示（后端进程不在沙箱里）；安装时向用户列出
  "workbench"               // 遗留的全权限，只给内置签名扩展，安装时标红提示
]
```

- 宿主为每个扩展签发一枚 **scoped token**，形如 `ext:<id>:<rev>`，只包含它在 manifest 里声明、并经用户同意的 capability。网关按 token 校验每一次调用。
- 升级时，如果 capability 有新增，就挂起新版本，等用户重新同意（参考 Cindy 的 `ghostInstallConsent`）；只减少权限则直接生效。
- **审计**：创建或写入会话、外发消息、拿身份令牌，都写本地审计日志，记录扩展 id、会话、时间、摘要。
- **版本协商，fail-closed**：网关通过 `GET /api/ext/v1/hello` 返回 `{api, capabilities, features}`。扩展遇到缺失的 feature 必须降级，或者在界面上提示"Kode 版本过旧"，不能盲调。这一点参考 Cindy 的 `CHANNEL_NOT_ALLOWED`。

## 4. 统一 API：`kode.api/v1`（G2、G4）

在 session-server 上挂一个网关 `/api/ext/v1/*`，内部转发给 bridge 和 messaging。扩展只用这一个入口，所有资源都用 `{node_id, session_id}` 寻址；`node_id` 指向远端节点时，由 Fabric 经 link 路由过去执行。

| 方法 | 说明 |
|---|---|
| `GET  sessions?owner=&label=&node=&cursor=` | 分页列出会话（含 `ext_meta`） |
| `POST sessions` `{node_id, backend, cwd, worktree?, model?, permission_mode?, initial_input?, bot?, owner_ext, parent?, labels[], ext_meta}` | 创建会话。传 `bot` 时用伙伴的配置（backend、角色说明、记忆范围、权限上限），`backend` 可省略。`owner_ext` 由网关从 token 里填，扩展不能伪造。必须带 `idempotency_key`，响应丢失后重试不会建出第二个会话 |
| `POST sessions/:id/input` `{text, idempotency_key}` | 复用 #48 的投递语义，返回 `message_id` 和投递状态 |
| `POST sessions/:id/interrupt` | |
| `POST sessions/:id/answer` | 回答审批或提问（需要声明 `sessions.input`） |
| `GET  sessions/:id/transcript?limit=&tail_bytes=` | 有界读取 |
| `PATCH sessions/:id/meta` `{labels, ext_meta}` | 只能改 owner=自己 的会话 |
| `POST host/open-session` `{node_id, session_id, view?}` | 让 GUI 聚焦这个会话，可指定 TUI 或 dsh |
| `POST host/notify` `{title, body, action?}` | 写入事件中心和系统通知 |
| `GET/PUT storage/kv/:key` | 可选；扩展也可以直接用 `KODE_EXTENSION_DATA` 下的自有 SQLite |
| `GET  identity/token?audience=` | 短期 access token；refresh token 永远留在核心 |

SDK：`kode-ext`（Rust，一方扩展和 kode-team 用）和 `@kode/extension-sdk`（TypeScript，dsh 生态用）。两边从同一份 JSON Schema 生成类型，见第 10 节。

## 5. 事件总线（G3）

```
GET /api/ext/v1/events/stream?kinds=…&owner=self&label=…&after=<cursor>   (SSE)
```

| kind | 负载 | 来源 |
|---|---|---|
| `session.created` / `session.exited` | id、node、backend、labels | L0 |
| `session.turn_started` | turn_id | semantic tail / hook relay |
| `session.turn_completed` | turn_id、`final_ref`（transcript 位置，回答正文另行有界读取）、usage | 同上 |
| `session.awaiting` | `approval` / `question` / `input` 三类，附摘要 | 同上 |
| `session.runtime_changed` | pty ↔ dsh | runtime claim |
| `message.delivery` | message_id、prepared / queued / consumed / cancelled | #48 |
| `node.online` / `node.offline` | | Fabric |

- **先补齐，再推送**：连接建立时，先从 SQLite 补发 cursor 之后的事件，再接 `tokio::broadcast` 的实时推送。断线重连时带上最后的 cursor，保证不丢事件。
- 事件在服务端按 `kinds`、`owner`、`label` 过滤后再推送。
- `turn_completed` 以**原生历史**为准（rollout / jsonl），不以任何 UI 的副本为准。这样不管会话当前由 PTY 还是 dsh 驱动，扩展拿到的结果都一致。

## 6. 贡献点（G5、G6）

```jsonc
"contributes": {
  "sessionViews":    [...],                                   // 已有
  "activityItems":   [{ "id": "team", "title": "团队", "icon": "./icons/team.svg", "badge": "unread" }],
  "sidebarSections": [{ "id": "rooms", "title": "频道", "source": "/ui/sidebar" }],  // 纯数据，由 Kode 自己的样式渲染
  "panels":          [{ "id": "room", "title": "频道", "path": "/room", "placement": "main" }], // 只占主区域，保留 Kode 侧栏
  "sessionActions":  [{ "id": "share", "title": "分享到频道", "when": "session.idle" }],
  "cards":           [{ "id": "call-status", "attach": "session" }],
  "agentTools":      [{ "name": "team_channel_read", "scope": { "labels": ["team:call"] } },
                      { "name": "team_channel_post", "scope": { "optIn": true } }],
  "notifications":   true
}
```

- **sidebarSections 是数据，不是页面**：扩展后端在 `/ui/sidebar` 返回 `[{id, title, badge, children}]`，由 Kode 渲染，所以样式和会话列表一致；点击后打开对应的 `panel`。
- **panels** 复用现有的子 webview 和视图桥，只是位置改成主区域。视图桥新增两个请求：`open-session` 和 `notify`。
- **agentTools**：Kode 已经负责给 15 个 CLI 注入 `kode-sessions-mcp`。新增的工具由同一个代理在 `tools/list` 时按 `scope` 合并（会话带有指定 label，或用户在该会话里手动开启）；`tools/call` 时转发给扩展后端的 `POST /tools/<name>`，并附上调用方会话身份，扩展不能伪造调用方。
- **cards**：扩展输出声明式 JSON 卡片（状态、按钮、确认），Kode GUI、dsh、手机三端原生渲染，见 6.1。

### 6.1 多宿主渲染：Kode GUI、dsh、手机

扩展的界面要在三个宿主里都能用：Kode GUI（Svelte，TUI 为主）、dsh（cordis/React，chat UI，**面向大多数用户的默认界面**）、手机（Flutter）。dsh 全屏时 Kode 自己的导航栏和侧栏是隐藏的，所以扩展入口**不能只挂在 Kode GUI 上**。

原则：**贡献点是宿主无关的数据契约，每个宿主各自渲染**。扩展只声明一次，不为每个宿主写代码。

| 贡献点 | Kode GUI | dsh（由 `@kode/dsh` 的 `kode-extensions` 桥渲染） | 手机 |
|---|---|---|---|
| `activityItems` + `sidebarSections` | ActivityRail + 侧栏分组 | `sidebar.panellist` 里的分组 | 底部 tab / 列表 |
| `panels` | 主区域子 webview | `main` slot 里的 iframe | 内置 WebView（P3） |
| `sessionActions` | 会话顶栏按钮 | `conversation.session.header.actions` | 会话菜单 |
| `cards`（取代原 `mobileCards`，三端通用） | 原生渲染 | `conversation.chat.node` / `tool.call.toolview` 原生渲染 | Flutter 原生渲染 |
| `notifications` | 事件中心 + 系统通知 | dsh 通知（`session-notifications.js`） | 推送 |

- **`cards`** 是声明式 JSON：标题、状态徽标、键值行、进度、按钮（按钮回调扩展后端的 `POST /actions/<id>`）、确认框。用于计划卡、Call 状态、"需要你处理"等。三端原生渲染，样式跟随各自宿主，不用 iframe。卡片可以挂在某个会话的对话流里（`session_id` + 锚点），也可以挂在面板里。
- **`panels`** 只用于卡片表达不了的完整页面（例如频道）。宿主通过视图桥把主题 token（`--fg-*`、`--acc` 等，或 dsh 的等价 token）和 `host=kode|dsh|mobile` 传给页面，页面自己适配。
- **dsh 桥**：`@kode/dsh` 新增一个 cordis 插件 `kode-extensions`，启动时读 `GET /api/ext/v1/contributions`，按上表注册 slot；扩展安装、停用时收到 `extensions.changed` 事件，增量注册或回卷（cordis 的 disposer 天然支持）。这样新扩展装上后，dsh 不用改代码、也不用重启就能显示它的入口。
- 能力检查和 Kode GUI 一致：dsh 桥使用当前用户身份调用网关，扩展的 capability 校验不因宿主不同而放宽。

## 7. 宿主下沉与生命周期（G7）

- 扩展的后端进程改由 `kode-session-server`（kode-bridge）托管；GUI 只负责嵌入 view，并把 view 的请求转给 server。GUI 关闭后，扩展照样可以服务手机和远端。
- `activation`：`onStartup`、`onView:<id>`、`onEvent:<kind>`、`onTool:<name>`、`onUri:kode://<id>/…`。平时不常驻，按需拉起；空闲 N 分钟且没有订阅、没有在途调用时回收。
- 现有的 ready line、stdin EOF 退出、progress 协议保持不变。

## 8. 身份与密钥（G8）

- 核心保留 Kode 账号（CloudBase / palm），同步依赖它。
- 扩展通过 `identityProviders` 注册额外的身份源（比如 kode-team 注册 Maestro Auth Broker / IOA）。登录流程由扩展驱动，令牌交给核心保管（macOS Keychain / Windows DPAPI）。扩展每次通过 `identity/token` 拿短期 access token。
- 账号切换时，核心广播 `identity.changed`；扩展必须丢弃在途请求，参考 maestro `LocalTeam.request` 的 principal 校验。

## 9. 伙伴（Bot）（G9）

伙伴 = **有名字、长期存在、带角色和记忆的 agent 身份**。Cindy 的伙伴、PiBot 的 Bot、maestro 的「我的助手」都是它。

### 9.1 归属

| 层 | 内容 |
|---|---|
| **L0 核心** | 伙伴档案、角色说明注入、记忆范围、权限上限、长期会话。dsh、kode-team、Crew、手机都要用，放核心避免插件互调 |
| **L3 `kode-bots` 扩展** | 定时任务（cron / 文件变化 / 事件触发）、外部 IM 接入（企业微信、飞书、Telegram）、伙伴自学技能 |
| **L3 kode-team** | 频道里 @ 伙伴；成员列表显示"张三的助手"（只是投影） |
| **L3 Crew** | 从伙伴里挑人担任 Lead / Worker 角色 |

### 9.2 档案

在现有 Agent registry（`messaging/agents.rs`）上扩展，不另起一套：

```jsonc
{
  "id": "bot_01…", "name": "Kit", "avatar": "gallery:<avatar-id>",   // 复用按状态变化的头像系统
  "persona": "你是负责代码评审的…",        // 角色说明
  "agent": "<agent profile id>",           // backend / 模型 / effort，引用现有档案
  "skills": ["review", "…"],               // 引用插件同步库里的 skill
  "memory_scope": "bot:bot_01…",           // kode-memory scope
  "permission_ceiling": { "mode": "workspace-write", "network": false },
  "default_workspace": { "node_id": "…", "cwd": "…" },
  "default": true                          // 每个账号一个默认伙伴 = 「我的助手」
}
```

- **角色说明注入**按 backend 数据驱动配置，和 `mcp_setup` 一样写在 `BackendConfig` 里：
  - `system_prompt_flag`（例如 claude 系 `--append-system-prompt`）；
  - `instructions_config`（例如 codex 的 developer instructions 配置项）；
  - 都不支持时，作为会话第一条消息发送，并在 transcript 里标为系统注入。
  - 禁止在业务代码里写 `if key == …`。
- **记忆**：伙伴默认只能读写 `bot:<id>` 和当前项目 scope；读取个人 scope 要单独授权。写入仍走 `memory_propose` + 审核。
- **skills** 只是引用，安装和同步仍归插件同步库（`.specops/specs/plugin-control-plane.md`）。

### 9.3 长期会话

- 每个伙伴有一条**主会话**（canonical session），这就是它在 IM、频道、手机上的"对话入口"。
- **伙伴以 dsh 为默认界面**：伙伴是聊天型的使用方式，主会话默认在 dsh 里打开；dsh 侧栏列出伙伴（头像 + 名字 + 状态），新建对话时可在 `conversation.hero.agentPreset` 里选伙伴。需要终端时随时切回 TUI，靠的还是现有的会话占用和 `import_session`。
- **上下文快满时调用 CLI 自己的压缩**（如 `/compact`），原生会话不变，伙伴 id、历史、头像都不变。是否支持、用哪条命令按 backend 数据驱动配置（`compact_command`），不写死。
- 只有 backend 不支持压缩、压缩失败或用户手动"重新开始"时，才轮换原生会话：先生成摘要，再开新的原生会话，把摘要和角色说明一起注入。
- 原生会话之间用 `bot_session_links(bot_id, seq, node_id, session_id, summary_ref, started_at, ended_at)` 串起来，历史可以一路往前翻。
- 伙伴也可以被临时派出新的普通会话（例如 Crew 里当 Worker），这些会话用 `labels: ["bot:<id>"]` 标记归属，但不算主会话。

### 9.4 权限规则

1. **只能收窄**：实际权限 = 用户授权 ∩ 伙伴上限 ∩ 运行场景上限（频道、Crew、定时任务各自的上限）。参考 PiBot："群组权限只能收窄成员权限"。
2. **来源不提权**：定时任务、外部 IM、其他伙伴转来的消息触发的运行，权限不超过该来源的上限，默认低于用户亲手发起。Cindy 文档里承认没做到这一点，我们一开始就做。
3. **跨人隔离**：只有伙伴的主人能指挥它（继承 maestro 规则）；别人只能看到投影。

### 9.5 API

| 方法 | 说明 |
|---|---|
| `GET/POST/PATCH/DELETE bots` | 需要 `bots.read` / `bots.manage` |
| `POST bots/:id/input` `{text, source, idempotency_key}` | 发到主会话；`source`（`user`/`routine`/`im`/`team`/`crew`）决定权限上限 |
| `POST bots/:id/spawn` `{node_id?, cwd?, worktree?, labels, parent?}` | 用伙伴的配置开一个临时会话 |
| 事件 `bot.session_rotated` / `bot.turn_completed` | 主会话轮换、回合结束 |

## 10. 语言与 SDK 策略

- **统一在协议层，不强制统一语言**。`kode.api/v1` 的 JSON Schema 是唯一事实来源，各语言 SDK 由它生成。
- **一方扩展默认 Rust 后端 + TS 界面**：不新增工具链（Kode 已有 Rust/TS/Dart）；直接复用 kode-bridge 的网关类型；以后可以选择**内置运行**（编进 session-server，作为同进程模块），省掉一个进程。
- 第三方扩展用任何语言都可以，只要遵守 ready line / stdin EOF / `kode.api/v1`。
- 提供 `kode-ext`（Rust crate）和 `@kode/extension-sdk`（TS）两份 SDK；暂不提供 Go SDK。

## 11. 性能不变量

以下都是现有代码里已经暴露过的问题，P0 一并修掉：

| 问题 | 现状 | 要求 |
|---|---|---|
| 消息存储整体串行 | `messaging/store.rs` 一个 `Mutex<Connection>`，`synchronous=FULL` | 一个写连接 + WAL 只读连接池；派生和可重放数据用 `NORMAL`，回执和取消仍用 `FULL`；高频写入合并成批量事务 |
| 事件只能拉取 | `/events` 每次 `SELECT … LIMIT 200` | 改为推送（见第 5 节） |
| `kode_sessions_wait` 空转 | 每 250ms 轮询（`session_mcp.rs:154`） | long-poll，阻塞在 `Notify` 上 |
| link 空转 | 每 500ms tick（`link.rs:338/443`） | outbox 有新数据时 notify 发送端；心跳单独 5s |
| 持锁做 IO 或进程扫描 | #62：约 1400 个会话的 snapshot 在锁内扫进程 | 锁内只做内存操作；debug 构建加锁持有时长告警 |
| 进程数 | 每个会话一个 MCP 进程，每个扩展一个 Node 进程 | 每个节点一个常驻 MCP 代理，会话侧只留很薄的垫片；扩展按 activation 拉起和回收；一方扩展用 Rust 写轻量后端（见第 10 节） |

需要埋的指标：锁等待和持有时长的 p99、事件从产生到推送的延迟、各扩展进程的 RSS 和 CPU。

## 12. 分期

| 期 | 内容 | 验收 |
|---|---|---|
| P0-a | 网关 `/api/ext/v1`、scoped token、`sessions.*`、`ext_meta`、事件推送（第 5 节）、第 9 节前四项 | 一个示例扩展跑通"建会话 → 发消息 → 收到 `turn_completed`"，全程没有轮询 |
| P0-b | `activityItems`、`sidebarSections`、`panels`、`sessionActions`、`cards`、`host/open-session`、`notify`、`agentTools` 代理；`@kode/dsh` 的 `kode-extensions` 桥 | kode-team P1 用得上的贡献点在 Kode GUI 和 dsh 里都可用 |
| P0-c | identity providers 和 secrets；宿主下沉到 session-server | GUI 关闭后，扩展仍能处理手机端发起的请求 |
| P0-d | 伙伴档案 + 默认伙伴、角色说明注入、`bot:<id>` 记忆范围、权限上限；`bots.*` API | 默认伙伴即「我的助手」，kode-team 能 @ 它 |
| P1 | dsh 扩展从 `workbench` 改为细粒度 capability；伙伴主会话轮换；多伙伴管理界面 | dsh 不再拿 admin token；伙伴跨原生会话保持身份 |
| P2 | `kode-bots` 扩展：定时任务、外部 IM；来源权限上限 | 定时任务触发的运行权限不超过其上限 |

## 13. 实现状态

### P0-a 第一步（分支 `feat/extension-platform-p0`）

| 内容 | 位置 |
|---|---|
| 网关 `/api/ext/v1`：`hello`、`sessions`（列表 / 创建 / 读取）、`sessions/:id/input`、`interrupt`、`meta`、`events`、`events/stream`（SSE） | `crates/kode-bridge/src/messaging/ext/mod.rs` |
| scoped token：`POST /api/v1/messaging/extensions/grants`（仅 admin）签发，重签即吊销旧 token；只存 SHA-256 | `ext/store.rs` |
| 会话归属、标签、`meta`、`parent`；创建按 `idempotency_key` 幂等（不同请求复用同一 key 返回 409） | `ext/store.rs` |
| 回合事件：从 runtime 持久日志按游标派生 `turn_started` / `turn_completed`（带 `final_message`）/ `awaiting` / `exited`，1.5s 空闲宽限合并闪烁；游标持久化 | `ext/projector.rs` |
| `initial_input`：等会话第一次 idle 再发，结果以 `session.input_result` 推送 | `ext/mod.rs` |
| 独立 SQLite（`<db>.ext.sqlite`，`synchronous=NORMAL`），不占用消息库的锁 | `ext/store.rs` |
| GUI：manifest 接受 API capability；只为新进程签发 token，传 `KODE_EXT_API` / `KODE_EXT_TOKEN`；停用、卸载时吊销 | `apps/gui/src-tauri/src/extensions/` |
| SDK `@kode/extension-sdk`（断线按游标续传）与示例扩展 | `packages/extension-sdk/`、`integrations/ext-sample/` |

与设计的差异：
- `sessions/:id/meta` 用 `POST`（不是 `PATCH`），与现有消息接口一致。
- `hello` 额外返回 `event_cursor`，用于"从现在开始订阅"且不丢事件。
- 会话只能在 GUI runtime 里创建（GUI 未运行时返回 503）；无 GUI 的 headless 创建属于 P0-c。

### P0-a 余下部分：推送替代轮询

| 原来 | 现在 |
|---|---|
| runtime 请求每 100ms 查一次结果；宿主每 500ms 领取一次命令 | 请求唤醒宿主的长轮询领取，回执唤醒请求方 |
| GUI 每 500ms 发布全部会话 | 会话有变化才发布（200ms 合并，5s 兜底）；领取命令改长轮询，旧后台自动退回轮询 |
| `kode_sessions_wait` 每 250ms 拉一次 | `events?wait=` 长轮询，提交即唤醒 |
| 跨机器连接每 500ms 发一次完整会话目录 | 存储变化、工作区请求时发送；目录没变时每 5s 才重发一次（兼作心跳）；2s 兜底 |

尚未做：消息库读写分离；dsh runtime 的领取循环仍按原间隔轮询。

### P0-d 伙伴（第一步）

| 内容 | 位置 |
|---|---|
| 伙伴档案（名字、头像、角色说明、Agent、模型、权限上限、默认工作区）存为版本化文档 `bots`；第一个伙伴自动成为默认伙伴 | `crates/kode-bridge/src/messaging/bots.rs` |
| 管理接口 `GET/POST /api/v1/messaging/workbench/bots`（仅 admin：GUI、dsh） | `messaging/api.rs` |
| 扩展接口 `GET /api/ext/v1/bots`（`bots.read`，不含角色说明）；`POST sessions` 支持 `bot: id \| "default"` | `messaging/ext/mod.rs` |
| 权限：默认 `min(default, 上限)`；请求高于上限直接拒绝（403），不悄悄降级 | `bots.rs` |
| 角色说明：支持 `--append-system-prompt` 的 backend 注入系统提示（与记忆提示共用一个 flag）；其他 backend（如 Codex）作为第一条消息发送 | `kode-core/src/session/mod.rs` |
| 记忆范围：会话标签 `bot:<id>`，角色说明里写明记忆范围 `bot:<id>` | 同上 |
| GUI 设置页「伙伴」：新建、编辑、删除、设为默认 | `apps/gui/src/lib/BotsSettings.svelte` |

尚未做：主会话与上下文压缩（P1，先 `/compact`，不支持时再轮换）、技能引用、来源权限上限（P2，`kode-bots`）、dsh 侧栏伙伴列表（P0-b 的 dsh 桥）。

### P0-b 第一步：面板

| 内容 | 位置 |
|---|---|
| manifest `contributes.panels`（`id`、`title`、`icon`=Kode 图标名、`path`），需要 `ui.panels` 能力和后台；与 sessionViews 共用 id 命名空间 | `apps/gui/src-tauri/src/extensions/manifest.rs` |
| 面板复用原生子 webview：只占主区域，Kode 侧栏和导航栏保留；选任意会话即离开面板 | `extensions/view.rs`、`App.svelte` |
| 左侧导航栏显示面板入口和角标 | `ActivityRail.svelte` |
| 页面经 `kodeHost.request` 请求：`badge {count}`、`notify {title, body, severity}`、`open-session {session_uuid}`、`close` | `App.svelte` `onPanelAction` |
| 示例扩展加了一个实时面板（事件列表、角标、完成提示） | `integrations/ext-sample` |

尚未做：dsh 桥（dsh 全屏时面板入口在 dsh 侧栏里）、`sidebarSections`、`sessionActions`、`cards`、插件经扩展 API 推角标（目前只能由面板页面上报）。
