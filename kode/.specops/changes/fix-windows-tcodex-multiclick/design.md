---
schema_version: 2
id: fix-windows-tcodex-multiclick
kind: bug
document_class: work_item
work_type: bug
title: Windows TCodex 多击点击链设计
status: proposed
verifies:
  - typescript
paths:
  - apps/gui/src/lib/codex_mouse_selection.ts
  - apps/gui/tests/codex_mouse_selection.test.ts
---

# Windows TCodex 多击点击链设计

点击分类同时使用 native detail 和本地点击链：

```text
effective_detail =
  max(event.detail, previous_click.detail + 1)
  when same position within 500 ms
```

第一击保留现有单击转发；第二击开始只做 xterm 本地选词，第三击及以上只做本地
选行。位置阈值使用 4 CSS px，拖拽或 blur 会清空点击链。点击链记录完成 click
的时间而不是 down 时间，避免长按被误判为多击。

Windows 下不能立即转发第一击：WebView2 在 TUI 重绘后可能丢失点击链，且第一击
已经足以触发 TCodex 的状态变化。因此第一击延迟到多击窗口结束再重放；窗口内
出现第二击时取消待发送的第一击，双击只做本地选词，不向 PTY 发送任何鼠标事件。
非 Windows 平台保持零延迟，避免引入不必要的单击延迟。

测试注入可控时钟，必须覆盖：

- normal `detail=2` / `detail=3`；
- WebView target 重绘造成 `detail=1,1`；
- Windows 延迟窗口内第二击到达时，第一击也不得重放；
- Windows 只发生单击时，延迟窗口结束后仍须重放一次；
- 超时后的两个独立单击；
- 位移后的两个独立单击；
- drag 后点击链重置。
