---
schema_version: 1
id: fix-gui-status-bar-vertical-center
kind: bug
title: 修复 GUI 底部状态栏元素垂直居中
status: proposed
verifies: []
paths:
  - apps/gui/src/App.svelte
---

# 修复 GUI 底部状态栏元素垂直居中

> 原始请求(逐字引用):
> kode gui下面的status上所有元素都需要垂直居中

## Motivation

kode GUI 底部的状态栏(`apps/gui/src/App.svelte` 的 `<footer class="status">`,
样式见同文件 `.status` / `.status-left` / `.status-right` 等规则)中,各个元素没有
在同一条垂直中线上对齐,视觉上参差不齐。

虽然容器层 `.status`(`apps/gui/src/App.svelte:2515-2516`)和子容器
`.status-left, .status-right`(`apps/gui/src/App.svelte:2522-2525`)都已经写了
`display: flex; align-items: center;`,但状态栏内的个别元素仍然无法和兄弟元素在垂直方向
对齐,原因包括:

- 部分子项是 `inline-block` 而非 flex 项,基线对齐而非中心对齐:
  - `.mem-badge-wrap`(`apps/gui/src/App.svelte:2630-2633`,`display: inline-block`)
  - `.dev-info`(`apps/gui/src/App.svelte:2602-2605`,默认 inline 文本)
- 字号 / `line-height` 不一致导致行盒高度不同、视觉中心错位:
  - `.cwd-path` 用 `font-size: 11px`(`:2569`)
  - `.cached` 用 `font-size: 10px`(`:2583`)
  - `.mem-badge` 用 `font-size: 10.5px; line-height: 1.4`(`:2619-2621`)
  - 主状态文字用 `--fs-xs`(`.status` `:2513`)
- mini context bar `.ctx-bar-mini`(高 4px,`:2588-2595`)、状态圆点 `.status-dot`、
  `.remote-dot`(6px,`:2550-2556`)这类小尺寸图形元素与文字基线不在同一中心。

因为存在 `·` 分隔符、图标、圆点、进度条、不同字号文字混排,仅靠现有的
`align-items: center` 不足以让所有元素在视觉上垂直居中。

## Scope

- 仅修改 `apps/gui/src/App.svelte` 中状态栏相关的样式/标记,使
  `<footer class="status">` 内 `.status-left` 与 `.status-right` 的**所有**子元素
  (含文字、`·` 分隔符、状态圆点、mini context bar、token/cost 文本、memory 徽章、
  remote 指示器、cwd 路径、dev-info 等)在垂直方向居中对齐。
- 统一会破坏垂直中心的因素:确保所有子项参与 flex 居中(必要时把 `inline-block`
  改为 `inline-flex` 并加 `align-items: center`),对齐不同字号元素的视觉中心
  (如使用一致的 `line-height` 或 `align-self: center`)。
- 保持原有功能、颜色、间距、hover/点击交互、`.dot-attention` 脉冲不被裁剪等现状不变,
  只调整垂直对齐。

## Acceptance criteria

- 在 GUI 中,状态栏左右两侧的每一个元素(文字、`·`、状态圆点、mini context bar、
  token/cost、memory 徽章、remote 指示器、cwd 路径、dev-info)目视上都垂直居中,
  没有明显的上/下偏移或基线错位。
- 在以下情况下都保持居中:有/无活动 session、有/无 context 百分比、有/无 token 与 cost、
  memory 有 pending 与无 pending(badge 与 dim badge 两种)、有/无 remote endpoint、
  showDevInfo 开/关。
- 不引入新的溢出或裁剪问题;`.dot-attention` 的 box-shadow 脉冲仍不被父级裁掉
  (`apps/gui/src/App.svelte:2526-2527` 的约束保持成立)。
- 改动范围仅限 `apps/gui/src/App.svelte`,不触碰其它源文件。

## Out of scope

- 不改状态栏显示的内容、字段、文案或数据来源。
- 不改状态栏的颜色主题、整体高度、左右分区结构或 `justify-content: space-between` 布局。
- 不涉及 TUI(`src/ui/`)的状态栏,只针对 GUI。
- 不做与垂直居中无关的重构或视觉调整。
