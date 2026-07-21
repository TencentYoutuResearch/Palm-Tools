# Tasks

- [ ] **App.svelte: 添加展开状态变量**
  - 添加 `workspacePanelExpanded: boolean = $state(false)` 状态
  - 在 `.root` 上添加 `inspector-expanded` CSS class
  - 定义展开态 CSS: `.root.inspector-expanded { --inspector-w: min(calc(100vw - 60px), 1200px); }`
  - 注意展开态下禁用列宽过渡（类似 `.inspector-resizing`），或保持过渡但缩短时长

- [ ] **WorkspacePanel.svelte: 添加展开按钮**
  - 在 nav-top-actions 区域添加按钮（refresh 和 close 按钮之间或旁边）
  - 使用 lucide `maximize-2` icon（展开态时切换为 `minimize-2`）
  - 按钮点击触发展开/恢复
  - 按钮需要接受一个 `onExpandToggle` 回调 prop，或者通过 context/event 向上通信
  - 按钮样式：参考 `.tool-btn` 风格，展开态时 `.active` 高亮

- [ ] **App.svelte: 传递展开回调给 WorkspacePanel**
  - 在 `App.svelte` 中定义 `toggleInspectorExpand` 函数
  - 通过 prop 传递给 `<WorkspacePanel>`: `onExpandToggle={toggleInspectorExpand}`
  - 函数内切换 `workspacePanelExpanded` 状态

- [ ] **WorkspacePanel.svelte: 确保中间区域独立滑动**
  - 验证 `.preview-pane` 的 `overflow: auto` 在展开态下仍生效
  - 验证 `.preview-text` 和 `.md-body` 的 `overflow: auto` 正常
  - 如果展开后出现外层容器滚动（整个面板滚动），修复为仅预览区滚动

- [ ] **视觉验证**
  - 亮色/暗色主题下按钮显示正常
  - 展开/恢复动画顺滑
  - 展开态下中间内容可独立滚动，不带动 sidebar 或终端区域
  - 关闭面板后重新打开，展开状态重置为未展开
  - 拖拽调整宽度后展开/恢复，宽度恢复正确

- [ ] **回归测试**
  - `cargo test -- --test-threads=1` 全部通过
  - `pnpm test`（SpecOps engine 测试）全部通过
