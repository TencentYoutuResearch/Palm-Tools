---
schema_version: 1
id: fix-specops-toolcard-expand-reset
kind: bug
title: SpecOps 对话里 tool card 展开不到 1 秒就恢复折叠，且 function call 内容格式需要支持二次解析
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/server/public/app.js
  - apps/specops/src/server/public/styles.css
  - apps/specops/src/domain/session-monitor.ts
---

# SpecOps 对话里 tool card 展开不到 1 秒就恢复折叠，且 function call 内容格式需要支持二次解析

## 用户原话

> specops对话functioncall或者其他内容展开1s不到就恢复了，然后看看里面的格式是否可以二次解析下

## 现象

在 SpecOps 会话面板（`#session-transcript`）里点击某个 function call（tool card）的 head 想展开查看 `preview` 内容，展开后不到 1 秒就被自动恢复成折叠态。会话正在跑（active run 流式写入 transcript）时尤其明显——基本点不开。

附带诉求：tool card 里的 `preview` / `summary` 文本目前是预格式化字符串（pre 形式直接 `textContent` 写入），用户希望"看看里面的格式是否可以二次解析下"——即对结构化内容（JSON、key:value、命令行参数等）做二次解析后用更可读的方式渲染。

## 根因

### 1. 展开状态丢失

展开/折叠状态只活在 DOM 节点的 `previewWrap.hidden` 属性上，没有任何地方持久化。

- `apps/specops/src/server/public/app.js:478-481` —— click handler 直接翻转 `previewWrap.hidden` 和 chev 文本，未写回任何状态。
- `app.js:501-504` `renderTranscriptCompact()` 每次都 `transcript.replaceChildren()` 全量重建 DOM。
- `app.js:1671-1674` `session.updated` SSE handler 在有 `activeSession` 时无条件调 `openSession(activeSession.id)` → `showSessionCompact()` → `renderTranscriptCompact()`，于是整个 transcript DOM 被清空重建，所有 `.chat-tool-card` 的展开状态一起丢。
- active run 期间，`session-monitor.ts:105` 每追加一条 transcript entry 就 `publish('session.transcript_appended', ...)`，服务端 `server/index.ts` 把它转成 `session.updated` 事件推送（详见 `app.js:1671` 的 SSE 监听）。流式 tool_use/tool_result 几乎每秒都触发，所以"点开 1 秒内就被压回去"。

### 2. preview 内容未做二次解析

- `app.js:472-474` 创建 `<pre class="chat-tool-preview">` 后直接 `previewWrap.textContent = entry.preview`，原始字符串整段塞进去。
- `session-monitor.ts:96-98` 把 bridge 解析出的 `summary` / `preview` 原样写进 `TranscriptEntry`，没有对内容做格式归一化。
- 不同 tool 的 `preview` 内容形态差异很大：有的本身是合法 JSON（如 `Read` 的 `{ path, limit, offset }`），有的是 key:value 多行（如 `Bash` 的命令 + 输出片段），有的是 `Edit` 的 old/new diff 片段。统一用 `<pre>` + 纯文本展示，长内容很难一眼读懂。

## Motivation

- **可用性**：会话流式写入时根本点不开 tool card，违背了"卡片可折叠展示细节"的初衷，用户只能等会话跑完才能查看 function call 细节，体验明显劣化。
- **可读性**：`preview` 里有大量结构化文本，当前一律 `<pre>` 纯文本展示，失去了二次解析提升可读性的机会；对长输出、JSON 输入参数、文件路径这类内容做轻量结构化渲染能显著降低阅读成本。

## Scope

- 修复展开状态丢失：让 `renderTranscriptCompact()` 重建 DOM 后保留（或重新应用）用户已展开的 tool card 状态。
- 改进 `preview` 渲染：对常见结构化内容（JSON、key:value、明显是命令/路径的单行）做轻量二次解析，结构化展示；纯文本回退到现有 `<pre>` 形式。
- 仅触碰 SpecOps 前端 `apps/specops/src/server/public/` 下的 `app.js` / `styles.css`，以及必要时的 `session-monitor.ts`（如把解析提前到服务端）。

## Acceptance criteria

- [ ] active run 流式写入 transcript 期间，点击展开任意一个 tool card，松开后该 card 保持展开态，不会被下一次 `session.updated` 事件折叠回去。
- [ ] 同时展开多个 tool card，重建 DOM 后所有曾展开的 card 仍然展开。
- [ ] 手动折叠一个此前展开的 card，重建 DOM 后保持折叠态（即状态由用户最近一次操作决定，不是"默认展开"）。
- [ ] `preview` 内容为合法 JSON 时，以缩进 + 语法高亮（或至少 key 着色）形式展示；非 JSON 内容回退为等宽 `<pre>` 文本，不破坏原内容。
- [ ] `preview` 内容为多行 key:value 形式时，按行渲染并对 key 做轻量着色。
- [ ] 任意二次解析路径都不会因为异常输入抛错——解析失败必须 fallback 到纯文本，绝不让整条 transcript 渲染崩溃。
- [ ] `pnpm test`（apps/specops）通过；如新增解析函数则补单元测试覆盖 JSON / key:value / 纯文本三种典型输入。
- [ ] 不改动 transcript 传输协议或 `TranscriptEntry` 字段 shape（保持向后兼容，解析只在渲染层做）。

## Out of scope

- 不改造 `renderTranscriptCompact()` 为 diff/patch 增量渲染（改动面太大、风险高，本 bug 用"状态恢复 + 二次解析"即可解决；diff 渲染留作未来工作）。
- 不引入 markdown / syntax-highlight 重型依赖（如需高亮用轻量自实现或已有的 `marked.umd.js`，不新增 npm 依赖）。
- 不改 SSE 事件协议、不改 `session.updated` 触发频率（流式刷新频率是预期行为，问题在于前端吞掉用户状态而非刷新太快）。
- 不动 GUI（`apps/gui`）的终端渲染——SpecOps 控制台 UI 与 GUI 终端渲染相互独立（见 constitution）。
- 不动 `tool_use` / `tool_result` 的 dedupe 逻辑（`session-monitor.ts:72-101` 已按 `tool_call_id` 去重，行为正确）。

## Constitution conflicts

无。本变更不触碰 PTY lifecycle、backend 默认参数、SpecOps run 隔离等任何已声明 invariant。渲染层改动只发生在 SpecOps 前端，不与 GUI 终端渲染耦合（符合 project-overview.md 中"GUI terminal rendering is independent from SpecOps console rendering"）。

## 实现方向参考（供 design.md 细化）

1. **状态恢复方案（推荐）**：维护一个模块级 `Set<tool_call_id>` 记录当前展开的 card，`appendToolCard()` 创建 card 后查 Set 决定 `previewWrap.hidden` 初值；click handler 翻转时同步写/删 Set。card 被移除（session 切换）时清空 Set。该方案最小改动、不破坏现有 `replaceChildren()` 全量重建路径。
2. **二次解析方案**：新增 `renderToolPreview(preview: string): Node` 函数，依次尝试：JSON.parse → 渲染为 `<pre>` + 缩进 + key 着色；多行 key:value → 每行拆成 `<span class="kv-key">` + `<span class="kv-val">`；纯文本 fallback。所有路径 try/catch，失败回落到 `textContent = preview`。
3. **可选优化**：长 preview 加最大高度 + 内部滚动，避免单个 tool card 撑爆整个 transcript 视口。
