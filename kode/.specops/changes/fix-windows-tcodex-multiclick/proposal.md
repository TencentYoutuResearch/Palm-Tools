---
schema_version: 2
id: fix-windows-tcodex-multiclick
kind: bug
document_class: work_item
work_type: bug
title: 修复 Windows TCodex 鼠标双击退出会话
status: proposed
verifies:
  - typescript
paths:
  - apps/gui/src/lib/codex_mouse_selection.ts
  - apps/gui/tests/codex_mouse_selection.test.ts
  - apps/gui/src/lib/Terminal.svelte
---

# 修复 Windows TCodex 鼠标双击退出会话

## Motivation

Windows Worker 的 TCodex 会话启用 terminal mouse reporting 后，用户在会话内容
上双击会退出会话。现有 click-versus-drag 适配依赖 `MouseEvent.detail`；在
WebView2/TUI canvas 重绘导致事件 target 变化时，第二次 down 仍可能报告
`detail=1`，于是第二次单击被转发给 TCodex，形成意外双击输入。

## Scope

- 在 Codex/TCodex 鼠标适配中保留浏览器 `detail`，并增加同一位置、短时间内的
  点击链兜底。
- 第二次点击即使 `detail=1` 也识别为双击，执行本地选词且不向 PTY 转发。
- 第三次连续点击识别为三击并本地选行。
- 超时、位置明显变化或拖拽后重置点击链。
- 保持单击可操作 expandable TCodex 内容，保持拖拽选区不发送鼠标输入。

## Acceptance criteria

- [ ] Windows/WebView2 重置 `detail` 时，同位置 500 ms 内第二击仍不被重放给
      TCodex。
- [ ] 连续第三击只做本地整行选择，不发送 PTY 输入。
- [ ] 超过双击时间窗口或移动超过阈值后的点击仍分别转发。
- [ ] 单击 expandable 内容、拖拽选区和 triple-click 既有行为不回退。
- [ ] 单元测试覆盖 `detail=1 -> detail=1` 的 Windows 事件序列。
- [ ] Windows debug 构建中双击运行中的 TCodex 会话，进程、turn 和 tab 均保持。

## Out of scope

- 改变 Ctrl+C 的 interrupt 或关闭确认语义。
- 替换 xterm.js 或修改 TCodex CLI 自身键位。
- 修改远程 command、session sync 或 Worker 状态机。

## Constitution conflicts

None. 变更只过滤终端鼠标输入，不改变 PTY ownership、backend 参数或 SpecOps run
隔离。
