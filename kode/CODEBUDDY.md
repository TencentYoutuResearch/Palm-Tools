# CODEBUDDY.md

给 AI 协作者(CodeBuddy / Codex / Claude / 任意其它模型)的项目速读。**先读完这一页再动代码**。

> 2026-07 当前方向:`kode` 已从 TUI v0.1 切到 **独立 GUI 应用**。TUI 只保留 P0 bugfix,不要在旧 TUI UI 上加新功能。
>
> - 当前主线:`apps/gui` = Tauri 2 + xterm.js + Svelte 5
> - 共享核心:`crates/kode-core`
> - 远端/手机协议:`crates/kode-bridge` + `apps/mobile`
> - 共享记忆:`crates/kode-memory`
> - SpecOps 控制台:`apps/specops`
> - 路线图先读 [`.specops/specs/roadmap.md`](./.specops/specs/roadmap.md)

## 这是什么

`kode` 是一个管理本地和远端 AI CLI 会话的 workspace。桌面端用 GUI 管多个 tab,每个 tab 仍是一个独立 PTY + vt100 终端模拟,可跑 `codebuddy` / `claude` / `claude-internal` / `codex` 以及配置里的其它 backend。

类比:tmux 的精神,但专门服务于 AI CLI;GUI 负责多 tab、状态栏、backend 管理、memory 审核、远端桥、SpecOps 入口和移动端配对。

## 硬约束

1. **极致性能**:PTY 字节路径要合并/节流,避免高频 IPC 或无意义重绘。
2. **零渲染问题**:不能丢字符、破坏颜色/光标/alt-screen,不能让子 TUI 黑屏。
3. **macOS 优先**:Windows 不承诺。
4. **文件可维护性**:单个源码/文档文件尽量保持 2000 行以内;逼近上限时按职责拆分。

## 当前结构

```text
kode/
├── crates/
│   ├── kode-core/       PTY、Session、Config、cost、model alias、CoreEvent
│   ├── kode-bridge/     纯 axum HTTP/WS bridge、协议路由、语义事件解析、headless bridge bin
│   ├── kode-sync-server/中心化 session 镜像、一次性绑定、在线命令路由
│   ├── kode-memory/     shared memory store、MCP server、CLI、hooks、git sync
│   └── kode-tui/        legacy TUI,已冻结,只修 P0
├── apps/
│   ├── gui/             当前桌面主线:Tauri 2 后端 + Svelte 5/xterm.js 前端
│   ├── mobile/          Flutter 手机/桌面伴侣
│   └── specops/         TypeScript/Bun SpecOps sidecar + Web console
├── docs/                DESIGN、UX contract、smoke 脚本等文档
├── deploy/              remote memory bridge 构建/部署脚本
└── .specops/specs/      roadmap、协议、memory、SpecOps 规范
```

Cargo workspace 只包含 Rust crate 和 `apps/gui/src-tauri`。`apps/mobile`、`apps/specops` 是独立 Flutter / pnpm 项目。

## 关键模块

- `crates/kode-core/src/config.rs`:数据驱动 backend 默认配置。新增内置 backend 先看这里。
- `crates/kode-core/src/session/`:PTY session 内核、状态机、jsonl tail。
- `crates/kode-core/src/pty/`:portable-pty spawn/read/kill。
- `crates/kode-bridge/src/lib.rs`:headless HTTP/WS bridge 的共享 router/context。
- `crates/kode-bridge/src/semantic.rs`:codebuddy/claude jsonl → message/tool_use/ask/plan 等语义事件。Codex 语义解析目前仍是空实现。
- `apps/gui/src-tauri/src/lib.rs`:Tauri 后端入口,注册 commands、启动 bridge、memory、hook relay、SpecOps。
- `apps/gui/src-tauri/src/state.rs`:GUI AppState、CoreEvent 路由、PTY 字节 coalesce、transport 注册。
- `apps/gui/src-tauri/src/transport/`:local/remote session transport。
- `apps/gui/src-tauri/src/backend_admin.rs`:Manage backends 写盘,用 `toml_edit` 保留用户注释。
- `apps/gui/src-tauri/src/memory*.rs`:GUI memory 审核/搜索/MCP setup。
- `apps/gui/src/lib/`:Svelte 组件和 IPC glue。
- `docs/DESIGN.md` / `docs/UX-CONTRACT.md`:GUI 视觉意图与行为契约。

## Backend 规则

- Backend 是数据驱动的。默认值在 `crates/kode-core/src/config.rs::Config::default()`,用户可在 `~/.config/kode/config.toml` 的 `[backends.<key>]` 增删改。
- 内置默认包含 `codebuddy`、`claude-internal`、`claude`、`codex` 以及一批常见 AI CLI 预设。
- `mcp_setup` 描述怎么把 memory MCP 接进 backend: `codebuddy` / `claude` / `codex` / `json-merge`。
- 不要把硬编码 backend 名塞进 `memory_mcp` 或其它业务逻辑;能从 config 读就从 config 读。
- GUI 的 BackendChooser 使用启动时的冷快照。Manage backends 写盘后会 emit refresh,但新 backend 要重启 GUI 才能完整参与 spawn 选择。
- `backend_admin::KNOWN_CANDIDATES` 只负责 PATH 自动探测候选;新增候选要改数组并发版。
- `codebuddy`、`claude`、`codex` 默认 args 不能加 positional。positional 很可能被 CLI 当作初始 prompt 发给 LLM;相关回归测试已覆盖。
- Codex 权限映射不同:没有 codebuddy/claude 的 `--permission-mode`;spawn 层会把 bypass 映射成 `--ask-for-approval never --sandbox danger-full-access`。

## Metadata / Jsonl

状态栏的 model / title / tokens 不靠解析 PTY 输出,靠 CLI 自己的 jsonl / rollout 文件:

- codebuddy:`~/.codebuddy/projects/<slug>/<session-id>.jsonl`
- claude / claude-internal:`~/.claude/projects/<slug>/<session-id>.jsonl`
- codex:`~/.codex/sessions/**/rollout-*.jsonl`

`crates/kode-core/src/session/jsonl_tail.rs` 负责:

- codebuddy/claude:已知 session id 时直接 tail;resume 时可全局扫描回退。
- codex:CLI 不支持外部指定 `--session-id`,启动后按 cwd + mtime 认领最新 rollout,或按 session uuid 查找。
- title:用户手动改名后 `title_pinned=true`,不要被 AI title 覆盖。
- semantic bridge:目前 `kode-bridge::semantic` 只把 codebuddy/claude 解析成 message/tool_use/ask/plan,Codex 还没接。

## Memory 规则

- 共享 memory root 默认 `~/.kode-memory`,可用 `KODE_MEMORY_ROOT` 覆盖。
- 模型侧通过 MCP server:`kode-memory-mcp`;GUI/CLI 也读同一套 SQLite + markdown fact 文件。
- memory 是“提议 + 审核”模型。agent 应 `memory_propose`,由用户/GUI review 后才正式进入可检索池。
- 不要重新引入直接写入 fact 的捷径;`memory_write` 这类接口违反审核模型。
- 改 memory 相关代码前先看 [`.specops/specs/memory-design.md`](./.specops/specs/memory-design.md) 和 [`.specops/specs/memory-git-sync.md`](./.specops/specs/memory-git-sync.md)。
- 在 kode 内工作时,改模块前先搜 MCP memory:模块名、错误文本、设计关键词都要搜一次。

## TUI 冻结边界

`crates/kode-tui` 是 v0.1 legacy fallback:

- 可以修 P0:崩溃、子进程僵死、数据丢失、看不到输出。
- 不加新 UI/UX 功能,不继续演进 ratatui 布局。
- 外层 kode TUI 绝不能 `EnterAlternateScreen`,子进程自己会用 alt-screen。
- `PtyHost::kill` 必须用 `clone_killer()` 的独立 kill 句柄,不要回到 `Arc<Mutex<Child>>` wait/kill 共用的死锁设计。
- vt100 resize 用 `screen_mut().set_size(rows, cols)`,不是不存在的 `parser.set_size`。
- `Ctrl-b Ctrl-b` 要能向子进程发送真实 Ctrl-b。

## GUI 性能约束

- PTY 高频字节不要用 Tauri `emit`;当前设计是前端订阅 IPC `Channel`,后端约 8ms coalesce 一次发送。
- `CoreEvent::PtyBytes` 走高频 byte channel;`PtyExited` / `JsonlMeta` 等低频事件才 emit / bus。
- xterm.js 每个 tab 一个实例;后台 tab 仍需持续 feed,切回要零延迟。
- macOS `.app` 启动时 PATH 会很小,`apps/gui/src-tauri/src/lib.rs` 已用 `fix_path_env::fix()` 修正。不要移到 Builder 之后。
- macOS 终端类体验需要关闭 `ApplePressAndHoldEnabled`,否则长按不 repeat、快打会吞字符。

## 远端 / 手机协议

- 协议文档:[`.specops/specs/remote-protocol.md`](./.specops/specs/remote-protocol.md)
- 手机中心同步协议:[`.specops/specs/cloud-sync-protocol.md`](./.specops/specs/cloud-sync-protocol.md)
- `crates/kode-bridge` 是可独立运行的 headless bridge,默认端口 `47870`。
- GUI 内也启动同协议 bridge,共享 sessions/bus/token。
- `apps/mobile` 通过中心服务看 session、历史、输入、状态,不再发现 LAN bridge 或读取桌面永久 token。
- `apps/gui/src-tauri/src/cloud_sync.rs` 只建立出站 WSS;未扫码绑定时中心服务不接受 session 上传。
- Phase 11 已有 remote endpoint / SSH tunnel / remote workspace 支持;优先走 `apps/gui/src-tauri/src/transport/remote.rs` 和 `endpoints.rs`。

## SpecOps

- 入口:`apps/specops`
- GUI 通过 `apps/gui/src-tauri/src/specops.rs` 管理 sidecar。
- 相关规范在 `.specops/specs/specops-*.md`。
- SpecOps Run 的隔离原则:在平台缓存目录独立 git worktree 执行,绑定 immutable base commit,不要直接污染用户主工作区。

## 常用命令

优先用根目录 `./run.sh`。它会自动回到仓库根目录执行,并统一处理 Node 版本、pnpm 依赖、SpecOps sidecar 构建、Tauri resource、macOS 签名降级等细节。直接手敲 `cargo` / `pnpm tauri` 只适合排查脚本本身。

```bash
# 查看脚本支持的全部入口
./run.sh help

# GUI 调试:启动 vite + tauri dev。cwd 默认是调用 run.sh 时的目录。
./run.sh dev
./run.sh dev /path/to/project
KODE_CWD=/path/to/project ./run.sh dev

# 只重打前端 dist;已运行 .app 需要 quit + 重启或 ./run.sh open
./run.sh fe

# macOS 打包 release .app。无 Developer ID 证书时自动 ad-hoc 签名并只打 .app。
./run.sh app

# 打开已打好的 bundle,会先 kill 旧实例
./run.sh open

# Rust 全量测试。PTY 相关测试必须单线程。
./run.sh test

# 全套检查: cargo check + svelte-check + cargo test
./run.sh check

# Rust build / fmt / clippy
./run.sh build
./run.sh build-release
./run.sh fmt
./run.sh clippy

# 单独跑核心 crate
cargo test -p kode-core -- --test-threads=1
cargo test -p kode-bridge -- --test-threads=1
cargo test -p kode-memory -- --test-threads=1
cargo test -p kode-tui -- --test-threads=1

# Legacy TUI fallback
./run.sh tui
./run.sh install-tui

# SpecOps
cd apps/specops
pnpm install
pnpm test
pnpm build

# Mobile
cd apps/mobile
flutter analyze
flutter test
```

打包注意事项:

- `./run.sh app` 会先删除固定 DMG 路径,避免打包失败后误装上一次遗留的旧 DMG。
- `apps/gui/src-tauri/resources/kode-remote-memory-bridge-linux-musl.tar.gz` 不存在时,脚本会跳过该 resource 继续打包;需要带上远端 memory bridge 时先跑 `bash deploy/build-remote-memory-bridge.sh --musl`。
- 自助 SSH 云同步部署依赖 `apps/gui/src-tauri/resources/kode-sync-server-linux-musl.tar.gz`;发布前先跑 `bash deploy/build-sync-server.sh`,把 x86_64 Linux 静态服务包嵌入 App。缺少该包时 GUI 仍可连接已有服务,但不能执行自动部署。
- 没有 Developer ID 证书的机器会自动走 ad-hoc 签名并跳过 DMG,这是本地调试的正常路径。
- `./run.sh dev` 会先构建 `apps/specops` 开发产物,确保 GUI 内嵌 SpecOps sidecar 可用。

## 修改前检查

1. 先看工作区是否已有用户改动:`git status --short`。不要回滚不是你改的东西。
2. 改模块前读对应文件顶部 `//!` / 注释;这个项目把很多“为什么”写在那里。
3. 改默认配置、启动参数、backend 行为必须加回归测试。
4. 改 GUI 交互要跑 `pnpm check`,有条件就用真实 GUI 目视验证。
5. 改 bridge / remote / mobile 协议要对照 `remote-protocol.md`,并补 REST/WS 测试。
6. 改 memory 要保持 append-only + review queue 模型,不要绕过审核。
7. SSH/网络测试 fixture 只用 `example.com` / `.example` 保留域名、RFC 5737 测试网段和虚构用户/路径;不要把个人主机名、内网域名、真实 IP 或本机用户目录带入测试。

## 不要做的事

- 不要在 `crates/kode-tui/src/ui/` 上加新功能。
- 不要给旧 TUI 外层加 `EnterAlternateScreen`。
- 不要给内置 AI CLI 默认 args 加 positional。
- 不要把 backend 行为重新写死成 `if key == "codebuddy"` 这类分支;优先走 config / `McpSetupSpec` / `Backend` 枚举。
- 不要用普通 `tracing::info!` 往 stderr 打会污染 PTY 的日志路径;需要日志时确认 GUI/TUI 的日志策略。
- 不要让 PTY 字节逐字节穿 Tauri emit。

## 同步说明

`AGENTS.md` 和 `CLAUDE.md` 都是指向本文件的相对软链。只维护 `CODEBUDDY.md` 这一份内容,避免多个 agent 入口漂移。
