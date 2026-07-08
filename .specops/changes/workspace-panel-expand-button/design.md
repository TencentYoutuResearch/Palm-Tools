---
schema_version: 1
id: workspace-panel-expand-button
kind: feature
title: Workspace 面板展开按钮设计
status: proposed
verifies:
  - rust
paths:
  - apps/gui/src/lib/WorkspacePanel.svelte
  - apps/gui/src/App.svelte
---

# Workspace 面板展开按钮设计

## 现状

App.svelte 使用 CSS grid 三列布局：

```
grid-template-columns: var(--sidebar-w, 260px) minmax(0, 1fr) var(--inspector-w, 0px);
```

- `--inspector-w` 由 inline style 控制，默认 420px（`inspector-open` class 时）
- 展开/收起由 `workspacePanelOpen` boolean 控制，有 180ms 过渡
- 拖拽调整宽度由 `inspectorWidth` 状态 + pointer events 实现，拖拽中 `transition: none`

WorkspacePanel.svelte 内部：

```
.panel-body {
  grid-template-columns: minmax(0, 1fr) 246px;  /* 预览区 | 导航区 */
}
```

- `.preview-pane` 有 `overflow: hidden`，但内部 `.preview-text` / `.md-body` 有 `overflow: auto`，所以预览内容已可独立滑动
- `.nav-pane` 的 `.list-pane` 也有 `overflow: auto`

## 设计决策

### 1. 展开方式：CSS grid 列宽切换（vs overlay 浮层）

选择 **grid 列宽切换**，原因：
- 与现有 open/close 机制一致，复用相同的过渡动画模式
- overlay 浮层会覆盖终端区域，阻挡用户查看 PTY 输出
- grid 方式让 sidebar 和终端区域自然缩小，用户仍可感知整体布局

### 2. 展开宽度：`min(calc(100vw - 60px), 1200px)`

- 留 60px 给左侧 sidebar（即使它很小，用户仍能看到 tab 指示器）
- 上限 1200px 防止超大屏幕上面板过宽（预览区行过长影响阅读）
- 展开后 sidebar 和终端区域按 grid `minmax(0, 1fr)` 自动收缩

### 3. 状态位置：App.svelte 层面

展开状态放在 App.svelte 而非 WorkspacePanel 内部，因为：
- 展开影响的是 `.root` grid 布局，不属于 WorkspacePanel 内部状态
- 如果未来需要从其他地方（如命令面板）触发展开/恢复，状态在 App.svelte 更容易共享

### 4. 通信方式：prop 回调

WorkspacePanel 通过 `onExpandToggle` prop 通知 App.svelte，而非使用 Svelte context 或 event dispatch：
- 显式 prop 让数据流清晰可追踪
- 当前 WorkspacePanel 已有 `onClose` prop，遵循相同模式

### 5. 独立滑动保障

当前 `.preview-pane` 使用 `flex-direction: column` 配合 `overflow: hidden`（外层）+ `overflow: auto`（内层），展开后宽度增大不会影响这一行为。展开态下需确认：

- `.preview-pane` 外层不出现 `overflow: auto`（否则整个面板会滚动，拖拽 nav-top 也会滚走）
- `.preview-text` / `.md-body` 的 `overflow: auto` 正确触发独立滚动条

## 关键风险

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 展开后 panel-body 内层溢出导致外层滚动 | 整个面板可滚动，nav-top 消失 | 添加 `.preview-pane { overflow: hidden }` 确认；`.panel-body { min-height: 0 }` 已存在 |
| 拖拽宽度后展开再恢复，宽度值不一致 | 用户体验困惑 | 恢复时使用 `inspectorWidth` 原始值，而非硬编码 420px |
| 展开态下 panel-body 两栏比例失调 | 预览区过大 | 保持 `grid-template-columns: minmax(0, 1fr) 246px` 比例不变 |
