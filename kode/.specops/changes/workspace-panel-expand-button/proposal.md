---
schema_version: 1
id: workspace-panel-expand-button
kind: feature
title: Workspace 面板添加展开按钮 + 中间区域独立滑动
status: completed
verifies:
  - rust
paths:
  - apps/gui/src/lib/WorkspacePanel.svelte
  - apps/gui/src/App.svelte
---

# Workspace 面板添加展开按钮 + 中间区域独立滑动

## Motivation

当前 WorkspacePanel（右侧 session 面板）没有展开/放大按钮，用户无法临时将面板放大以查看更多内容。面板宽度固定（默认 420px，可通过拖拽调整），预览区域（preview-pane）虽然已有 `overflow: auto`，但整个面板的布局和 App.svelte 的 grid 列宽耦合，展开后会影响整个界面布局。

用户需要：
1. **一个显式的展开/放大按钮**，点击后 workspace 面板占据更大空间（甚至全屏），方便查看文件内容、diff 或 markdown 渲染结果。
2. **中间区域独立滑动**，展开/放大时中间的预览内容可以独立滚动，不影响左侧 sidebar 和整个界面的布局。

用户原话：「Specops的右边session，没有点击，展开放大的按钮呢。中间独立滑动，不要影响整个界面。」

## Scope

- 在 WorkspacePanel 的 nav-top 区域添加一个「展开/放大」按钮（icon：`maximize-2` 或类似 lucide icon）
- 点击后 workspace 面板切换到「展开态」：
  - 面板宽度扩展至占据大部分视口宽度（例如 min(calc(100vw - 60px), 1200px)）
  - sidebar 和终端区域暂时缩小或隐藏
- 再次点击恢复原始尺寸
- 确保展开态下中间预览区域（preview-pane）保持 `overflow: auto` 独立滑动
- 展开态应有平滑过渡动画
- 仅影响 `apps/gui/src/lib/WorkspacePanel.svelte` 和 `apps/gui/src/App.svelte`

## Acceptance criteria

- [ ] WorkspacePanel nav-top 区域有一个可点击的展开按钮，图标为 `maximize-2`
- [ ] 点击按钮后面板平滑展开至大宽度，动画时长 ≤ 200ms
- [ ] 展开态下中间预览区域（preview-pane）可独立上下滑动，不带动整个 grid 滚动
- [ ] 再次点击按钮面板恢复原始宽度
- [ ] 展开/恢复过程不触发页面闪烁或布局抖动
- [ ] 拖拽调整面板宽度功能在展开/恢复后仍正常工作
- [ ] 在亮色和暗色主题下按钮视觉效果一致

## Out of scope

- 不涉及左侧 sidebar 的自动隐藏/显示
- 不涉及终端区域的布局调整（终端保留原位置）
- 不涉及 SpecOps engine 或 CLI
- 不涉及键盘快捷键绑定（仅按钮点击）
- 不涉及面板内容的功能改动（files/git 面板逻辑不变）

## Constitution conflicts

无。本 proposal 不涉及 PTY 生命周期、backend 默认参数、或 SpecOps run 隔离 — constitution 中声明的三个 invariant 均不受影响。
