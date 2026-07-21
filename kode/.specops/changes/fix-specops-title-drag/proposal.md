---
schema_version: 2
id: fix-specops-title-drag
kind: bug
document_class: work_item
work_type: bugfix
title: SpecOps 会话和右侧栏展开后 title 区域无法拖动窗口
status: completed
verifies:
  - specops
paths:
  - apps/specops/frontend/src/components/Resizer.svelte
  - apps/specops/frontend/src/components/chat/ChatHeader.svelte
  - apps/specops/frontend/src/components/iwiki/IwikiHeader.svelte
targets:
  - specops/frontend/layout
  - specops/frontend/resizer
---

# SpecOps 会话和右侧栏展开后 title 区域无法拖动窗口

## Motivation

在 SpecOps Web Console 中，当会话模块（ChatModule）或文档模块（IwikiModule）的右侧栏展开后，顶部 title 区域（ChatHeader / IwikiHeader）无法通过拖拽来移动 Tauri 窗口。用户期望能够拖拽 title 区域移动窗口，但该区域被 `Resizer` 组件的绝对定位和指针事件捕获所阻断。

用户原始请求：「specops里面session和右侧栏展开后 title部分无法拖动」

**根因分析**：

`Resizer.svelte` 使用了 `position: absolute; top: 0; bottom: 0; z-index: 4`，使其覆盖 `.module` 容器的**整条高度**（包括 44px 的 header 高度）。当右侧栏展开（`--col-right > 0`）时：

- 右侧 Resizer 定位在 `right: var(--col-right, 0px)`，恰好落在右侧栏左边缘与中间面板的交界处
- 左侧 Resizer 定位在 `left: var(--col-left, 260px)`，落在左侧栏右边缘与中间面板的交界处
- 两个 Resizer 的 pointerdown 事件处理器会调用 `setPointerCapture`，将后续所有 pointermove/pointerup 事件重定向到 Resizer 自身
- 因此落在 header 区域内但被 Resizer 覆盖的像素上，Tauri 的 `data-tauri-drag-region` 和 `onWindowDragMouseDown` 均无法收到事件，拖拽失效

Resizer 只有 6px 宽，但足以在 header 左/右边缘抠出两条垂直的「无法拖拽」盲带。左侧栏展开时影响不大（Resizer 在 260px 处，基本不在居中的 title 文字范围），但右侧栏展开时 Resizer 紧贴 `head-right` 区域，与用户自然的拖拽点击位置重叠。

**次要问题**：`ChatHeader.svelte` 第 74 行的 `.head-right` 同时设置了 `data-tauri-drag-region`（HTML 属性）和 `-webkit-app-region: no-drag`（CSS），两者语义矛盾，在 Tauri v2 中可能产生不确定行为。

## Scope

- 修复 `Resizer.svelte` 使其不再覆盖 header 区域（从 `top: 44px` 开始，而非 `top: 0`）
- 修复 `ChatHeader.svelte` 中 `.head-right` 的 `data-tauri-drag-region` 与 `-webkit-app-region: no-drag` 矛盾
- 确保 ChatModule 和 IwikiModule 中 title 区域在所有列宽（左侧栏展开/折叠、右侧栏展开/折叠）下均可拖拽
- 保持 Resizer 的拖拽调整列宽功能正常工作

## Acceptance criteria

- [ ] ChatModule 中右侧栏展开时，ChatHeader title 区域可正常拖拽窗口
- [ ] ChatModule 中左侧栏展开时，ChatHeader title 区域可正常拖拽窗口
- [ ] IwikiModule 中右侧栏展开时，IwikiHeader title 区域可正常拖拽窗口
- [ ] IwikiModule 中左侧栏展开时，IwikiHeader title 区域可正常拖拽窗口
- [ ] Resizer 的列宽调整功能不受影响（200px-420px 左侧、240px-480px/520px 右侧均可正常拖拽）
- [ ] ChatHeader 和 IwikiHeader 的按钮（Resume、Close、StatusBadge）点击交互正常
- [ ] `pnpm check` 和 `pnpm test` 通过

## Out of scope

- 不涉及 backend/Rust 代码修改
- 不涉及 SpecOps Run / worktree 逻辑
- 不涉及 TUI 组件
- 不涉及窗口最大化/最小化按钮（macOS 交通灯）的交互
- 不新增 Resizer 功能或交互模式
