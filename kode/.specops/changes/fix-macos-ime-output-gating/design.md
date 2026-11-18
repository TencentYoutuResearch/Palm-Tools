# Design

## 决策 1：在平台入口处短路，而不是在 gate 内猜测平台

`Terminal.svelte` 已由 `isWindowsUserAgent()` 得到 `windowsPlatform`。macOS/Linux
的 `writeTerminalBytes` 直接把原字节交给 ANSI adapter 和 xterm；只有 Windows
调用 `TerminalImeOutputGate.push()`。这样平台策略集中在调用点，`terminal_ime`
仍保持可单测的纯数据缓冲器。

## 决策 2：composition listeners 仅 Windows 注册

只有 `windowsPlatform && textarea` 时监听 `compositionstart` 和
`compositionend`。macOS 继续使用 xterm/WKWebView 原生 composition 流程，不暂存
PTY 输出，也不在 composition end 后重放整批字节。

## 决策 3：不用定时刷新掩盖问题

问题根因是平台条件错误，而不是必须周期重绘。增加 refresh/repaint 会掩盖事件
累积并带来闪烁，因此不采用。

## Verification

- `pnpm --dir apps/gui test:session-input`
- `pnpm --dir apps/gui check`
- macOS debug app：中文输入法连续英文、中文组词，同时让 TCodex 输出流式内容，
  确认文字对比度、字形和布局无需刷新即可稳定。
- Windows 回归：IME composition 期间输出延后，结束后按序恢复。
