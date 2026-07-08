# 设计说明

## 现状

状态栏在 `apps/gui/src/App.svelte`:

- 标记:`<footer class="status">`(约 1204-1325 行),分 `.status-left` 与 `.status-right`。
- 容器样式 `.status`(2508-2521):`display: flex; align-items: center; justify-content: space-between;`。
- 子容器 `.status-left, .status-right`(2522-2528):`display: flex; align-items: center; gap`。

容器层面已经有 `align-items: center`,但仍出现垂直不居中,根因在子元素层面:

1. **非 flex 子项按基线对齐**
   - `.mem-badge-wrap`(2630-2633)是 `display: inline-block`,作为 flex 项时其内部基线/盒高与
     兄弟项不一致。
   - `.dev-info`(2602-2605)是普通 inline 文本。

2. **字号 / line-height 不一致导致行盒高度不同**
   - `.cwd-path` `font-size: 11px`(2569)
   - `.cached` `font-size: 10px`(2583)
   - `.mem-badge` `font-size: 10.5px; line-height: 1.4`(2619-2621)
   - 主文字 `--fs-xs`(2513)
   不同字号 + 不同 line-height,使各元素的「视觉中心」并不重合,即便外层 `align-items: center`
   把行盒中心对齐了,内部文字基线仍偏。

3. **小尺寸图形元素与文字中心错位**
   - `.status-dot`、`.remote-dot`(6px,2550-2556)、`.ctx-bar-mini`(高 4px,2588-2595)
     这些极小元素与相邻文字的视觉中心需要显式拉齐。

## 方案方向(实现阶段决定细节)

核心思路:**让状态栏内所有子元素都以「视觉中心」对齐**,而不仅仅是行盒中心。

- 把仍是 `inline-block` 的容器(如 `.mem-badge-wrap`)改为 `inline-flex; align-items: center;`,
  确保它们作为 flex 项时本身也居中、内部也居中。
- 对字号偏小的文本元素(`.cwd-path` / `.cached` / `.mem-badge` / `.dev-info`)统一一个
  与状态栏一致的 `line-height`(例如 `line-height: 1`)或显式 `align-self: center`,
  消除因 line-height 不同造成的中心偏移。
- 对小尺寸图形元素加 `flex-shrink: 0` 并确保其参与 flex 居中(必要时 `align-self: center`)。
- 验证以 flex 容器统一控制对齐后,`font-variant-numeric`、tabular-nums、间距等不受影响。

## 约束与回归点

- 保留 `apps/gui/src/App.svelte:2526-2527` 的注释约束:`.status-left/.status-right` 不能加
  `overflow: hidden`,否则会裁掉 `.dot-attention` 的 box-shadow 脉冲;父级 `.status` 仍承担兜底
  防溢出。
- 仅改 CSS / 必要的内联布局类,不改字段、文案、数据流。
- 仅触碰 GUI(`apps/gui/src/App.svelte`),不涉及 TUI `src/ui/` 的状态栏。

## Constitution alignment

已读 `.specops/constitution.md`。本变更只调整 GUI 状态栏样式,不触碰 PTY 生命周期、backend
默认参数、SpecOps run 隔离等任何 invariant;也不涉及 GUI 终端渲染与 SpecOps console 渲染的耦合
(原则:两者实现保持独立)。无 constitution 冲突。
