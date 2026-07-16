---
schema_version: 2
id: fix-specops-text-selection
kind: bug
document_class: work_item
work_type: bugfix
title: SpecOps 仅文档内容可选中，UI 装饰不可选中
status: cancelled
verifies:
  - specops
paths:
  - apps/specops/frontend/src/app.css
  - apps/specops/frontend/src/components/iwiki/SpecPageView.svelte
  - apps/specops/frontend/src/components/shared/Markdown.svelte
targets:
  - specops/ux
---

# SpecOps 仅文档内容可选中，UI 装饰不可选中

## Motivation

> 用户请求: "specops很多地方可以被选择，我只需要文档部分才可以被选择，spec状态或者chat session这些都不需要被选中"

当前 SpecOps 控制台没有全局的 `user-select` 策略，浏览器默认行为导致以下 UI 装饰意外可选中:

- **SpecPageView**: 页面头部（路径/标题）、状态流（state-strip）、追踪器网格（trackers）、workflow card、required-action 面板、Discussion 侧边栏（activity）、选中卡片（selection-card）、composer、context-menu
- **侧边栏**: DocTree 树节点、SessionList session 条目
- **Rail**: 导航栏图标和文字
- **Chat UI**: AgentGroup 分组头、Composer 输入区周围标签
- **StatusBar**: 底部状态栏

这些区域与文档正文混在一起可选中，导致用户试图复制文档内容时容易误选 UI 文字，并触发意外的选中高亮。

当前仅 4 处显式设置了 `user-select: none`，且都是为了支持 macOS 窗口拖拽（`-webkit-app-region: drag`）而非有意禁止选中:
- `Rail.svelte` `.rail-top`
- `IwikiHeader.svelte` `.iwiki-head`
- `ChatHeader.svelte` `.chat-head`
- `HistoryCommit.svelte` `.ln`（diff 行号）

## Scope

在 `apps/specops/frontend/src/app.css` 的全局层面对 `body` 或 `.root` 设置 `user-select: none`，然后在文档内容区域显式设置 `user-select: text` 恢复选中能力:

- `SpecPageView.svelte` `.spec-block > .markdown` — spec 文档块正文
- `Markdown.svelte` `.markdown` — chat 消息中渲染的 markdown 内容

此方案的 blast radius 集中在 3 个文件以内，不影响任何 JS 逻辑或内容渲染。

## Acceptance criteria

- [ ] SpecPageView 中的文档块正文（.spec-block > .markdown）可正常选中
- [ ] Chat 消息中渲染的 markdown 内容可正常选中
- [ ] SpecPageView 的页面头、状态流、tracker 网格、workflow card、required-action 不可选中
- [ ] DocTree 树节点不可选中
- [ ] SessionList session 条目不可选中
- [ ] Rail 导航栏不可选中
- [ ] ChatHeader / IwikiHeader 不可选中（已有 user-select:none，确认保持）
- [ ] StatusBar 不可选中
- [ ] Context-menu 不可选中
- [ ] 现有 diff 行号选中行为不受影响

## Out of scope

- 不修改 SpecPageView 的选中追踪逻辑 (`updateSelection()` / `selectionchange` 事件）——只修改 CSS 层面的可选中性
- 不修改 `apps/specops` 以外的 GUI 或 TUI 代码
- 不修改任何后端或 bridge 协议
