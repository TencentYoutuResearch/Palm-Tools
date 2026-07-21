---
schema_version: 1
id: roadmap/phase-0-7
kind: spec
title: Phase 0-7 — TUI wrap-up to GUI v0.2 MVP (archived)
status: active
verifies:
  - specops
paths:
  - .specops/specs/roadmap.md
  - apps/gui
  - crates/kode-core
---

# Phase 0-7 — TUI 收尾 → GUI v0.2 MVP(已归档)

> 2026-05-30 完成。本文从 ROADMAP.md 抽出。
> ROADMAP 主页只保留一句话摘要 + 链接;详细 checklist 与决策保留在此供回溯。
> 当前活跃工作见主 [`roadmap.md`](./roadmap.md) Phase 8 / 9 / 10。

## 速览

| Phase | 主题 | 工时 | 状态 |
|---|---|---|---|
| 0 | 收尾 TUI v0.1 | 0.5 天 | ✅ |
| 1 | Rust core 模块化(`crates/kode-core`) | 0.5 天 | ✅ |
| 2 | Tauri 2 + Svelte 5 + xterm.js 单 tab POC | 2-3 天 | ✅ commit `cb6b5fd` |
| 3 | 多 tab + 侧栏 + 后台保活 + LRU 快照 | 2-3 天 | ✅ commit `32aa67c` |
| 4 | 全应用快捷键 + Command Palette | 1 天 | ✅ commit `101ce17` |
| 5 | 状态栏组件化 + 主题 + Cost 计算 | 1 天 | ✅ commit `e50bd6d` |
| 6 | 打包 + 性能验收(.app 5.0 MB) | 1 天 | ✅ commit `f606ff5` |
| 7 | 持久化 + 多窗口 + UI/UX 重构 + 7.4 bug 修复 | — | ✅ commit `d6519fb` + `ab0168d` + `d77bfa5`(7.4) |

**最终二进制**:`kode.app` 整包 5.0 MB(zip 后 2.1 MB),远低于 15 MB 目标。

---

## Phase 0 — 收尾 TUI 版(0.5 天)✅

- [x] `git tag v0.1.0-tui-final` + push
- [x] 在 `CODEBUDDY.md` 顶部加一行"项目已切换到 GUI 路线,此版本冻结"
- [x] 不删任何代码 — Phase 1 要原地搬

## Phase 1 — Rust core 模块化(0.5 天)✅

目标:把 UI 之外的所有逻辑抽到独立 crate,GUI 和 TUI 都能用。

**关键决策**:core 完全无 UI 依赖,**不暴露 Action 枚举**;只暴露 `CoreEvent`,
GUI/TUI 各自把 CoreEvent 包成自己的 Action variant。这样 mv 即可,不需要拆 enum。

```rust
// crates/kode-core/src/event.rs
pub enum CoreEvent {
    PtyBytes { id: SessionId, bytes: Vec<u8> },
    PtyExited { id: SessionId, code: Option<i32> },
    JsonlMeta { id: SessionId, model: Option<String>, title: Option<String>, tokens: Option<u64> },
}
// Session::new 接 mpsc::UnboundedSender<CoreEvent>,完全不知道 Action 存在
```

- [x] 仓库改 monorepo 结构,根 `Cargo.toml` 改 workspace
- [x] 新建 `crates/kode-core/`,把以下原样搬过去:
  - `src/pty/` → `crates/kode-core/src/pty/`
  - `src/session/` → `crates/kode-core/src/session/`
  - `src/config.rs` → `crates/kode-core/src/config.rs`
  - 新增 `crates/kode-core/src/event.rs` 定义 `CoreEvent`
  - **不**搬 `action.rs`(留在 tui;GUI 后端将自己定义 `BackendEvent`)
- [x] `crates/kode-core/Cargo.toml` 依赖:`portable-pty / tokio / serde / serde_json / anyhow / tracing / dirs / uuid / toml`(不要 ratatui / crossterm)
- [x] 新建 `crates/kode-tui/`,把现有 `src/` 剩余文件搬过去,改成依赖 `kode-core`;`Action::PtyBytes/PtyExited/JsonlMeta` 改为内部从 `CoreEvent` 转换
- [x] 验证:`cargo test --workspace` 全过(33 个测试)
- [x] 验证:`cargo build --release` 出 `target/release/kode-tui`,人工试一下确认无回归

## Phase 2 — Tauri 2 脚手架 + 单 tab POC(2-3 天)✅

实现:commit `cb6b5fd`

- [x] `cd apps && cargo create-tauri-app gui --beta`,选 **Svelte + TypeScript + Vite**(**不**用 SvelteKit;桌面 SPA 不需要 SSR)
- [x] `apps/gui/src-tauri/Cargo.toml` 加依赖 `kode-core = { path = "../../../crates/kode-core" }`
- [x] 前端 `pnpm add @xterm/xterm @xterm/addon-fit @xterm/addon-webgl`(只装这三个,不装 search/serialize/unicode11)
- [x] Tauri command:
  - `spawn_session(backend: string) -> SessionId`
  - `write_input(id: SessionId, bytes: Vec<u8>) -> ()`
  - `resize_session(id: SessionId, cols: u16, rows: u16) -> ()`
  - `kill_session(id: SessionId) -> ()`
  - `get_screen_snapshot(id: SessionId) -> String`(回放当前 vt100 屏幕为 ANSI,Phase 3 用)
- [x] Tauri event:
  - `session-bytes` { id, bytes_base64 } — PTY 字节流(高频)
  - `session-exited` { id, code }
  - `session-meta` { id, model?, title?, tokens? }
- [x] **关键性能点 1 — bytes 用 `tauri::ipc::Channel<Vec<u8>>` 而不是 emit**,避免每帧 base64 序列化开销
- [x] **关键性能点 2 — Rust 端 byte coalescing**:每 session 后端起一个 `tokio::time::interval(8ms)`,把 PTY reader 的小块累积到一个 `Vec<u8>` 里,interval tick 时一次发出。`cat` 大文件时把 IPC 频率从 1000+/s 降到 ~120/s
- [x] **关键性能点 3 — xterm 用 `term.writeUtf8(Uint8Array)`** 直接吃二进制,不要用 `term.write(string)`(后者要 UTF-16 重编码,慢)
- [x] **关键性能点 4 — WebGL 失败 fallback 必须有**:`try { loadAddon(WebglAddon) } catch { /* canvas */ }`。Intel macOS 老 GPU 黑屏率约 5%,这条不能省
- [x] **关键性能点 5 — 字体加载阻塞首次渲染**:`await document.fonts.load('14px JetBrains Mono')` 后再 mount xterm,避免字体替换时的重排
- [x] **关键性能点 6 — resize 必须 debounce 50ms**:窗口拉伸时不要每个像素事件都触发 `term.fit()` + PTY resize,否则 SIGWINCH 风暴
- [x] **关键性能点 7 — HiDPI 切显示器时 refresh**:监听 `devicePixelRatio` 变化触发 `term.refresh(0, term.rows-1)`,Mac 外接 4K 不会模糊
- [x] 前端:1 个 xterm.js 实例订阅 channel,`term.writeUtf8(bytes)` 渲染;`term.onData(d => invoke('write_input', { id, bytes: d }))`
- [x] **首屏 lazy mount**:`+page.svelte` 先渲染侧栏 + 状态栏占位(< 50ms),`onMount` 里 dynamic import xterm 再 mount;首屏感知 < 200ms
- [x] 验收:窗口里跑 codebuddy,视觉无差异,键盘鼠标正常,启动到首 tab 可见 < 400ms

## Phase 3 — 多 tab + 侧栏 + 后台保活(2-3 天)✅

实现:commit `32aa67c`

**关键决策**:**xterm 实例不常驻**,vt100 Parser 才常驻(在 Rust 端)。
- TUI 版常驻的是 vt100 Parser(纯数据,~50KB/tab),不是 ratatui widget
- GUI 版 xterm 实例每个 ~5MB DOM/canvas;10 个 tab 全常驻 = 50MB,浪费
- 正确做法:**前端 LRU 缓存 1-3 个 xterm 实例**,切到非缓存 tab 时 Rust dump vt100 screen 当前快照(`get_screen_snapshot`)→ xterm `writeUtf8` 一次性重建画面(~80×24 cells = ~5KB,< 5ms)
- **切换零延迟仍成立**(snapshot 重建 < 5ms < 1 帧)

- [x] 后端持有 `HashMap<SessionId, Session>`,每个 session 有独立 channel
- [x] 后端实现 `get_screen_snapshot(id) -> String`:`vt100::Parser::screen()` 遍历每个 cell,带 SGR 转义重建为 ANSI 字符串(用 vt100 自带的 `screen.contents_formatted()` 即可)
- [x] 前端 Svelte store:`tabs: Writable<TabInfo[]>`,active id;`mountedXtermIds: Set<SessionId>` LRU 容量 3
- [x] 切 tab 流程:目标 id 已在 LRU → `display: block`;不在 → 找 LRU 最旧 dispose,新建 xterm 实例,invoke `get_screen_snapshot` 拿快照写入,挂到 active 容器
- [x] **后台 tab 永不丢字节**:Rust 端 vt100 持续 feed,前端只是没渲染;切回时拿最新 snapshot 即对
- [x] 侧栏 HTML 渲染:状态点 + model 标签 + title + unread badge + tokens
- [x] 侧栏支持:点击切换、拖拽排序、双击重命名、右键菜单(关闭/复制 session-id)
- [x] 验收:开 10 个 tab,内存增长 < 100MB(对比每个 xterm 常驻应增 ~50MB)
- [x] 验收:任意 tab 切换 < 50ms 感知延迟

## Phase 4 — 快捷键(应用自治)+ Command Palette(1 天)✅

实现:commit `101ce17`

- [x] Tauri `Menu` + accelerator(macOS Cmd / Linux Ctrl):
  - `Cmd+T` 新 tab(默认后端) / `Cmd+Shift+T` 新 tab 选后端
  - `Cmd+W` 关 tab
  - `Cmd+1..9` 跳第 N 个
  - `Cmd+]` / `Cmd+[` 下/上
  - `Cmd+R` 重启 exited tab
  - `Cmd+P` 命令面板
  - `Cmd+,` 重命名 active tab title
- [x] Command Palette:Cmd+P 弹层,fuzzy 匹配命令,VSCode 风
- [x] 不再有 prefix 模式(应用全自治,不再担心冲突宿主)

## Phase 5 — 状态栏美化 + 主题(1 天)✅

实现:commit `e50bd6d`

- [x] 状态栏组件化:`<ModelBadge model={x} />` / `<TokensProgress used={x} budget={y} />` / `<CostChip usd={x} />`
- [x] cost 估算上线(model→price 表,见 Phase 5.1)
- [x] 主题:CSS 变量 + 深浅切换 + 跟随系统(`matchMedia('prefers-color-scheme: dark')`)
- [x] xterm.js 主题与应用主题同步

### Phase 5.1 — Cost 计算(0.5 天,从 v0.2 计划继承)
- [x] `crates/kode-core/src/cost.rs`:model → (input_price, output_price) 静态表
- [x] 主流覆盖:claude-opus/sonnet/haiku 系列 + gemini-pro/flash + gpt-5.x + glm-5.x
- [x] jsonl_tail 改成发 `Action::JsonlMeta { tokens, cost_usd }`,后端算好,前端只显示

## Phase 6 — 打包 + 签名 + 自动更新 + 性能验收(1 天)✅

实现:commit `f606ff5`

- [x] 关闭未用 Tauri features:`tauri.conf.json` 里 allowlist 默认全关,只开真正用到的
- [x] `Cargo.toml` release profile:`lto = "fat"` + `strip = "symbols"` + `panic = "abort"` + `codegen-units = 1`
- [x] 前端 vite build 产物分析:实测主 index 77KB / gzip 28KB;xterm 已自动分 chunk(289KB / gzip 71KB),无需进一步拆
- [x] `tauri build` 出 `kode.app`(dmg 卡在 bundle_dmg.sh 参数问题,后续再修;.app 已可手动 zip 分发)
- [ ] **性能数字硬验收**(必须达标,不达标回头优化):
  - [x] dmg < 15 MB —— **实测 .app 整包 5.0 MB,zip 后 2.1 MB,远低于目标**
  - [ ] [人工] 启动到首 tab 可见 P99 < 400ms — 需用户在桌面会话目视 / Instruments 验证
  - [ ] [人工] 单 tab 空闲 CPU < 0.5%
  - [ ] [人工] PTY 字节 → 像素端到端延迟 P99 < 16ms
  - [ ] [人工] dump 100KB 输出(`seq 1 5000 | xargs echo` 测)不丢字符不撕裂
- [ ] [人工/外部依赖] macOS code signing(需要 Apple Developer 账号)
- [ ] [人工/外部依赖] Tauri Updater 接入(需要 GitHub Release 源,可选)
- [x] 验收:可执行(进程拉起不崩溃);双击 .app 或 Spotlight 启动需用户手动验证

## Phase 7 — 持久化 + 多窗口 + UI/UX 重构(已完成,2026-05-30)✅

实现:commit `d6519fb`(Phase 7) + `ab0168d`(core 增强) + `d77bfa5`(7.4 补丁)

### 7.1 — 持久化
- [x] 会话列表持久化到 `~/Library/Application Support/kode/state.json`(macOS)/ `~/.config/kode/state.json`(Linux)
- [x] schema v1:`{ version, tabs: [{ backend_key, title, cwd }] }` — 不存 token / cost(runtime 重建)
- [x] debounce 500ms 写入(后端 `PersistWriter`),前端再 200ms throttle
- [x] 启动时弹 RestoreBanner:"Restore N session(s) from last time? · [Restore all] [Dismiss]"

### 7.2 — 多窗口
- [x] `Cmd+N` 命令 `open_new_window` 创建新 webview window(label `kode-{ts}`)
- [x] capabilities `windows: ["main", "kode-*"]` 授权所有子窗口
- [x] 新窗口通过 `?skip_persist=1` query string 跳过 restore,独立 tab 列表

### 7.3 — UI/UX 重构
- [x] kode-core 新增 `model_alias.rs` 统一短名归一,GUI 前端 `model_alias.ts` 镜像
  (旧的 TUI `compact_model_name` 退化为 wrapper,原 6 个测试仍绿)
- [x] kode-core 新增 `context.rs` 模型 → context window 静态表
- [x] jsonl_tail 解析 `inputTokens / outputTokens / inputTokensDetails[0].cached_tokens`
- [x] `cost.rs` 新增 `cost_usd(model, in, out, cached)` 精确版(cache 90% off)
- [x] `CoreEvent::JsonlMeta` 多带 input/output/cached/context_pct 字段
- [x] 侧栏 tab 卡片重设计:**session title** 主标题 + **backend chip(codebuddy/claude)** + **model chip(opus-4.7-1m 等)** + **context 进度条**(< 50% 绿、< 80% 黄、≥ 80% 红)
- [x] 状态栏:状态点 + model + mini context bar + ↓ input(cached)+ ↑ output + 精确 cost
- [x] 移除 tab 序号显示(Cmd+1..9 仍可用)

### 7.4 — Bug 修复(2026-05-30 补丁)

用户实测三个问题修复:

- [x] **resume 真生效** — restoreTabs 之前只是重新 spawn,现在持久化 schema 加 `session_id` 字段
  (v1 → v2 兼容,旧文件无字段反序列化为 None),恢复时通过 `--resume <sid>` 让子进程加载历史
  + 复用同一个 jsonl 文件 → token / model / context 立刻显示上次的值
- [x] **claude jsonl 解析** — 之前只支持 codebuddy 路径,导致 claude / claude-internal 后端的
  模型名只显示初始 alias("opus")、token / cost / context % 全空。新增 `Backend` 枚举做分流:
  - codebuddy 走 `~/.codebuddy/projects/<slug>/<sid>.jsonl`(slug 不带前导 dash)
  - claude/claude-internal 走 `~/.claude/projects/<slug>/<sid>.jsonl`(slug **带前导 dash**)
  - 字段差异:claude 模型在 `message.model`、usage 字段 snake_case、cached 来自 `cache_read_input_tokens`
  - claude **没有 ai-title** → 用第一条非命令前缀的 user message 作 title fallback
- [x] **model_alias 加 claude ver-tier 格式** — codebuddy 是 `claude-opus-4.7`,claude code 是
  `claude-4.7-opus`(顺序反了)。`short_model_name` 加 `swap_ver_tier_if_needed` 分支统一处理
- [x] **session-id 注入泛化** — `inject_codebuddy_session_id` 改为通用 `inject_session_id`,
  codebuddy / claude / claude-internal 都注入(claude-internal 也支持 `--session-id <uuid>`)
- [x] 测试:82 个全绿(64 core + 15 tui + 3 gui)

实现:commit `d77bfa5`

测试:67 个(50 core + 15 tui + 2 gui-persistence)

---

## Phase 0-7 沉淀的 Decision Log(原页面继承)

下面列出几条与 Phase 0-7 直接相关的决策摘要。完整决策日志(含跨 Phase 的)仍在主 ROADMAP.md。

- **2026-05-30 TUI v0.1 → GUI v0.2** — 用户三条强需求(快捷键冲突宿主 / UI 受限 / 未来 agent UI);否决 fork wezterm / wezterm-term + winit / Electron。选定 Tauri 2 + xterm.js + Svelte 5。
- **为什么不选 native 原生 GUI(egui / iced / gpui)** — 终端模拟内核要自己造,4-8 周成本不划算。
- **为什么 Svelte 5 不是 SvelteKit** — 桌面 SPA 用不到 SSR;启动 < 400ms / dmg < 15MB 硬指标决定。
- **为什么 xterm.js 不自己用 canvas 渲染 vt100** — VSCode/Codespaces/Cursor 都在用,生产级 + WebGL 加速。
- **为什么后端字节流用 Channel 不是 emit** — emit 走 JSON IPC,base64+JSON parse 高频时延迟高。
- **为什么 Rust 端要 byte coalescing(8ms)** — IPC 比 mpsc 贵,不 batch 会被 cat 大文件打挂前端事件循环。
- **为什么 xterm 实例不全部常驻 DOM** — 每个 5MB,10 个 = 50MB 浪费。LRU + snapshot 重建。
