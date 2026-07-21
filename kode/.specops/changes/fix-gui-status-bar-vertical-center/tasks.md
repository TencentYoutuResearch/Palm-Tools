# Tasks

- [ ] 复核 `apps/gui/src/App.svelte` 中 `<footer class="status">` 标记(约 1204-1325 行)与状态栏样式(约 2507-2646 行),列出所有不在垂直中心的子元素
- [ ] 确保 `.status-left` / `.status-right` 的每个直接子项都是参与居中的 flex 项(把 `.mem-badge-wrap` 等 `inline-block` 改为 `inline-flex; align-items: center`)
- [ ] 统一不同字号元素的视觉中心(`.cwd-path` 11px、`.cached` 10px、`.mem-badge` 10.5px/line-height 1.4 等),用一致 line-height 或 `align-self: center` 对齐
- [ ] 让小尺寸图形元素(`.status-dot`、`.remote-dot`、`.ctx-bar-mini`、图标)与相邻文字垂直中心对齐
- [ ] 确认 `·` 分隔符 `.dot-sep` 与两侧文字垂直居中
- [ ] 在 GUI 中目视验证各种状态组合(见 proposal Acceptance criteria)下均垂直居中
- [ ] 确认 `.dot-attention` 脉冲未被裁剪、无新溢出
- [ ] 改动仅限 `apps/gui/src/App.svelte`
