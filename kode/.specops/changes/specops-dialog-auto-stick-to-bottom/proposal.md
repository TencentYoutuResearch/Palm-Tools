---
schema_version: 1
id: specops-dialog-auto-stick-to-bottom
kind: change
title: SpecOps 对话框默认贴底、用户上滑才停止自动滚动
status: completed
verifies:
  - specops
paths:
  - apps/specops/src/server/public/app.js
  - apps/specops/src/server/public/index.html
  - apps/specops/src/server/public/styles.css
---

# SpecOps 对话框默认贴底、用户上滑才停止自动滚动

## Motivation

用户原话:

> specops对话框默认自动保持在底部，如果滑动才不滚动到底部，跟聊天对话框一样的需求

当前 `apps/specops/src/server/public/app.js` 的实现是:每次 `session.updated` SSE 事件触发 `renderTranscriptCompact(session)` 重建整个 transcript DOM 后,在末尾**无条件**执行 `transcript.scrollTop = transcript.scrollHeight`(`app.js:589`);clarify 视图的 `appendClarifyMessage` 在追加气泡后也无条件执行 `clarifyTranscript.scrollTop = clarifyTranscript.scrollHeight`(`app.js:1432`)。

问题:用户向上滚动查看历史时,新一轮 SSE 更新会把视图强行拽回底部,打断阅读。这与主流聊天对话框(Slack/iMessage/ChatGPT 等)的行为不一致 —— 后者默认贴底,但一旦用户主动上滑就进入「自由阅读」状态,只有用户再次手动贴底(滚回底部或点按钮)才恢复自动贴底。

## Scope

- **in scope**:
  - `#session-transcript` 容器:`renderTranscriptCompact` 末尾的强制贴底改为「仅当用户当前在底部时才贴底」
  - `#clarify-transcript` 容器:`appendClarifyMessage` 末尾的强制贴底同上处理
  - 在 DOM 重建/追加**之前**捕获「是否在底部」状态,重建**之后**按该状态决定是否 `scrollTop = scrollHeight`(注意 `renderTranscriptCompact` 用 `replaceChildren()` 全量重建,会重置 `scrollTop`,所以必须先读后写)
  - 监听 `scroll` 事件维护 `stickToBottom` 标志,用户上滑(距底部 > 阈值)置 false,用户滚回底部(距底部 ≤ 阈值)置 true
  - 切换不同 session 时(`renderTranscriptCompact` 被当作首次渲染调用),`stickToBottom` 重置为 true —— 新会话默认贴底
- **out of scope**:
  - 见下方 `## Out of scope`

## Acceptance criteria

1. 用户在 `#session-transcript` 底部时,新消息到达后视图自动滚到底部(行为与现状一致)。
2. 用户向上滚动查看历史时,新消息到达后视图**不**自动跳到底部,保持在用户当前阅读位置。
3. 用户手动滚回底部后,后续新消息恢复自动贴底。
4. 切换到另一个 session 时,`stickToBottom` 默认为 true,首屏即贴底。
5. `#clarify-transcript` 同样满足 1-3 三条行为。
6. 阈值(判断「在底部」的容差,建议 24px)定义为常量,便于后续微调。
7. `pnpm test`(apps/specops)仍然通过;若有针对 `renderTranscriptCompact` / `appendClarifyMessage` 的现有测试,需新增或调整以覆盖 stick-to-bottom 分支。

## Out of scope

- 不引入「跳转到底部」的悬浮按钮 UI(可作为后续 enhancement,本次不做)。
- 不改动 `.run-panel-body`(`styles.css:1069`)的滚动行为 —— 该容器是外层会话面板滚动,跟 transcript 内部贴底是两回事。
- 不改动 xterm.js 终端渲染路径(本对话框是 HTML/Svelte-less 原生 DOM + marked.umd.js,不涉及 xterm)。
- 不改 SSE 事件协议、不改 transcript 数据结构、不改 backend Rust 代码。
- 不重构 `renderTranscriptCompact` 的全量重建策略(用 `replaceChildren()`)—— 仅在重建前后处理滚动状态。

## Constitution conflicts

无。本变更不触及 constitution 中的任何 invariant:
- 不涉及 PTY 子进程生命周期(pty-lifecycle.md)
- 不涉及 backend 默认参数(positional 参数禁令)
- 不涉及 SpecOps Run 隔离(worktree / base commit)
- GUI 终端渲染独立于 SpecOps console 渲染(project-overview.md)—— 本变更只动 SpecOps 自己的 web UI,不碰 GUI

## Design notes

详见 `design.md`。
