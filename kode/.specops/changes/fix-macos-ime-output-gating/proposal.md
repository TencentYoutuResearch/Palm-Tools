---
schema_version: 2
id: fix-macos-ime-output-gating
kind: bug
document_class: work_item
work_type: bug
title: 隔离 Windows IME 优化，修复 macOS 会话透明文字与渲染异常
status: proposed
verifies:
  - rust
paths:
  - apps/gui/src/lib/Terminal.svelte
  - apps/gui/src/lib/terminal_ime.ts
  - apps/gui/tests/terminal_ime.test.ts
---

# 隔离 Windows IME 优化，修复 macOS 会话透明文字与渲染异常

## Motivation

为 Windows IME 弹框跳动新增的 `TerminalImeOutputGate` 当前在所有平台注册
`compositionstart/end`，并在组词期间暂停整个 PTY 输出。该机制用于规避
Windows IME 跟随 xterm 光标重绘的问题，但 WKWebView/macOS IME 有自己的组合
事件管线。macOS 在组词时被暂停输出后，可能呈现透明文字、旧帧或局部乱码，直到
切换/刷新触发重绘。

## Scope

- Windows IME output gating 和 composition listeners 只在 Windows 启用。
- macOS/Linux 的 PTY 输出直接进入 xterm，不等待 composition end。
- Windows 现有按序回放、容量上限和中断清理行为保持不变。
- 增加平台策略回归测试，防止未来再次把 Windows workaround 扩散到 WKWebView。

## Acceptance criteria

- [ ] macOS 在中文组词期间收到的 PTY 输出立即按序写入 xterm。
- [ ] macOS 不注册 Windows 专用 IME output-gate composition listeners。
- [ ] Windows 继续在组词期间暂存输出，并在 composition end 后按序回放。
- [ ] 上游输出不丢失、不重复、不乱序，容量上限行为保持不变。
- [ ] macOS 连续输入、中文组词和后台输出同时发生时，不需要刷新页面即可看到
      正确前景色与完整终端内容。
- [ ] 该修复不改变 TCodex mouse workaround、Ctrl+C policy 或剪贴板行为。

## Out of scope

- 重写 xterm.js 或切换 WebGL renderer。
- 修改 macOS IME 候选框定位。
- 调整 Linux IME 功能。
- 引入全局强制重绘或定时 repaint 作为遮罩式修复。

## Constitution conflicts

None. 变更只恢复平台边界，不改变 PTY 生命周期、输出字节协议或 SpecOps 渲染。
