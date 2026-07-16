# 设计说明

## 问题诊断

### Z-index 层级冲突

当前 `Resizer` 组件的 CSS：

```css
.resizer {
  position: absolute;
  top: 0;       /* ← 从容器顶部开始，覆盖 header 区域 */
  bottom: 0;
  width: 6px;
  z-index: 4;   /* ← 高于 header（默认 z-index: auto） */
}
```

header 的 `data-tauri-drag-region` 和 `onmousedown={onWindowDragMouseDown}` 期望在 header 区域内捕获鼠标事件来触发 `appWindow.startDragging()`。但 Resizer 的 `setPointerCapture` 优先级更高：一旦 pointerdown 命中 Resizer，Tauri 的窗口拖拽就永远不会被触发。

### 为什么只有展开时出现问题

- **左侧栏**：左 Resizer 定位在 `left: ~260px` 处，header 的 title 文字在 flex 布局中居中于 ~150px-400px 范围，仅有 6px 宽度的 Resizer 与 title 文字的交互区域重叠极小（用户不会注意到）
- **右侧栏**：右 Resizer 定位在 `right: ~320px` 处，header 右侧的按钮区域（Resume、Close）恰好位于 280px-450px 范围，Resizer 与用户常用点击区域高度重叠
- 当右侧栏**折叠**时 `--col-right: 0px`，右 Resizer 移到 `right: 0px`，基本超出可见区域

## 修复方案

### 方案选择：限定 Resizer 高度

将 Resizer 限制在 content 区域，不覆盖 header：

```css
.resizer {
  position: absolute;
  top: var(--header-height, 44px);  /* ← 从 header 下方开始 */
  bottom: 0;
  width: 6px;
  z-index: 4;
}
```

**选择理由**：

1. **语义正确**：Resizer 调整的是两侧面板的列宽，与 header 无关
2. **最小改动**：仅一行 CSS 修改
3. **向后兼容**：header 高度固定为 44px（由 `.chat-head` / `.iwiki-head` 的 `min-height: 44px` 定义），使用 CSS 变量可适应未来可能的 header 高度变化
4. **不破坏现有交互**：Resizer 的 pointerdown/move/up 逻辑和 `setPointerCapture` 保持原样，只是有效工作区域从整个模块高度缩为 content 区域

### ChatHeader 数据矛盾修复

```svelte
<!-- 修改前（第 74 行） -->
<div class="head-right" data-tauri-drag-region>
```

```svelte
<!-- 修改后 -->
<div class="head-right">
```

移除 `data-tauri-drag-region`，因为 CSS 已经通过 `-webkit-app-region: no-drag` 明确声明该区域不可拖拽。两者共存会在 Tauri v2 的事件系统中产生歧义。

### IwikiHeader 对齐

IwikiHeader 的 `.head-right` 目前使用 `-webkit-app-region: drag` + `pointer-events: none`，与 ChatHeader 的 `no-drag` 方案不一致。改为与 ChatHeader 一致：

```css
.head-right {
  -webkit-app-region: no-drag;
  /* 移除 pointer-events: none（目前 IwikiHeader 的 head-right 内无交互按钮，但保持一致性） */
}
```

## 未采用方案

- **方案 B: Resizer 的 `pointer-events: none`** — 会完全禁用 Resizer 交互，不可行
- **方案 C: 降低 Resizer 的 z-index** — Resizer 会被面板内容遮挡，拖拽手感变差
- **方案 D: 将 Resizer 移入 panel-mid 内部** — 结构变化大，且 Resizer 需要跨面板边界工作
