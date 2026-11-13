---
schema_version: 2
id: fix-windows-tcodex-multiclick
kind: bug
document_class: work_item
work_type: bug
title: Windows TCodex 多击点击链设计
status: in_progress
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

## Corrected deferred-click design

The first-click replay is deferred until the multi-click decision window has
closed. The sequence is:

1. A primary-button mouseup without drag queues one synthetic click.
2. A matching second or third mousedown cancels that queue before processing the
   local word or line selection.
3. If no matching click arrives, the queued click is replayed once after the
   decision window, preserving single-click TUI interaction.
4. A new independent click flushes any still-queued older click before queueing
   itself.
5. Drag, timeout, position mismatch, and disposal clear or flush the queue
   deterministically.

The multi-click decision window remains 500 ms to match the Windows default.
The single-click replay gets a small scheduling margin so timer/event ordering
at the boundary cannot leak the first click before a second click is classified.

Tests must assert that:

- a normal single click is replayed exactly once after the queue delay;
- a `detail=2` click and a WebView `detail=1,1` double-click forward zero clicks;
- a triple-click forwards zero clicks and selects the line locally;
- timeout and position mismatch preserve two independent single clicks;
- drag and disposal leave no queued click behind.

## TCodex safe-mouse and exit recovery

TCodex mouse ownership is stricter than Codex ownership. The terminal adapter
accepts an explicit `forwardSingleClicks` option:

- Codex keeps the existing delayed single-click behavior for expandable TUI
  controls.
- TCodex installs the same drag and multi-click selection handling but sets
  `forwardSingleClicks=false`. No primary-button click is replayed into xterm's
  mouse-reporting path.
- Double-click selects a word locally, triple-click selects the line locally,
  and drag selects a range locally.

The session lifecycle adds a second safety net. A pure predicate owns the
decision:

```text
offer recovery when:
  process exit code is 0
  and the open tab backend is tcodex
```

When true, Kode marks the tab exited, keeps it mounted, and opens a confirmation
dialog with `Restore` and `Later`. Restore invokes the existing resume path with
the same native session id. Later dismisses the dialog and keeps the exited tab
visible; the user can still close it explicitly.

Tests must cover:

- TCodex safe mode forwards zero clicks for a short single click;
- local double-click and drag selection still work in safe mode;
- recovery is offered only for `tcodex` exit code 0 with an open tab;
- other backends and nonzero exits retain their existing lifecycle behavior.

## Transport-level TCodex mouse filter

The TCodex guarantee is enforced at the PTY write boundary:

```text
term.onData(data)
  -> if current tab backend is tcodex
  -> strip terminal mouse reports
  -> drop empty result
  -> existing Ctrl+C guard
  -> write_input
```

Supported report forms:

- SGR: `ESC [ < ... M/m`
- urxvt: `ESC [ b ; x ; y M`
- X10: `ESC [ M` plus three payload bytes

The filter is pure and tested with mixed keyboard/report chunks. Keyboard escape
sequences and ordinary text must survive unchanged.

The front-end gesture adapter is installed for every PTY session and resolves
the backend key on each event. For TCodex it also swallows browser `click` and
`dblclick` after the local selection operation, preventing other terminal-area
listeners from treating a multi-click as a non-terminal command.

The exit recovery dialog remains intentionally after process exit because Kode
cannot call into the TCodex TUI to ask permission. It prevents silent loss but is
not represented as a pre-exit prompt.

## Windows-only gating

Platform gating is evaluated in the desktop WebView:

```text
windows = /Windows/i.test(navigator.userAgent)
```

`windows` controls three independent layers:

1. `Terminal.svelte` only strips mouse reports for Windows + TCodex.
2. The mouse adapter receives `safeMouseMode=windows`; safe mode disables
   TCodex click forwarding and browser multi-click propagation only when true.
3. Session exit recovery requires Windows + TCodex + exit code 0 + an open tab.

Before those layers, Windows TCodex output passes through a stateful
`TerminalMouseTrackingGate`. It removes only DECSET `h` activations for modes
`9`, `1000`, `1002`, `1003`, `1005`, `1006`, and `1015`. Mixed sequences retain
non-mouse modes, for example `?1;1002;1006h` becomes `?1h`. Partial CSI
sequences are carried across PTY chunks.

The gate is the primary root fix: xterm never exposes a mouse-reporting path for
TCodex on Windows. The input filter and local gesture adapter remain defense in
depth.

Terminal startup has two output paths:

```text
initial subscription replay -> initialBytes
live/hidden output          -> writeTerminalBytes
```

Both must run the gate. The initial replay originally transformed only theme
bytes, which allowed startup DECSET activation to bypass the mode gate. The fix
applies the mouse-tracking transform to `initialBytes` before theme conversion
and `term.write`.

## Opt-in exit audit

The TCodex INFO logs and structured SQLite logs do not expose the final PTY
input or the `PtyExited` code used by Kode. Add an audit behind
`KODE_TCODEX_INPUT_AUDIT=1`:

```text
write_input -> accepted bytes -> local hex JSONL
PtyExited   -> id + code      -> local JSONL
```

Only Windows TCodex sessions are recorded. The audit is synchronous and local,
does not alter input, and is skipped unless the environment flag is enabled.
The file is rotated before it exceeds a bounded size.

## TCodex idle Ctrl+C policy

The audit proves the exit input is `0x03` rather than a mouse report. Input
routing therefore branches before the existing consecutive-Ctrl+C guard:

```text
Windows + tcodex + data == 0x03
  status busy -> existing interrupt/guard path
  otherwise   -> show close confirmation; do not write 0x03
```

Selection-aware Ctrl+C copy remains earlier in the keydown capture path, so a
non-empty selection is still copied without opening this dialog.

Windows clipboard handling is therefore unconditional for Ctrl+C:

```text
Ctrl+C with selection    -> copy selection
Ctrl+C without selection -> consume; no clipboard write
Ctrl+Shift+C             -> copy selection
```

The keydown capture path consumes the event before xterm `onData`, so neither
the PTY nor the consecutive-Ctrl+C guard sees a keyboard Ctrl+C. The TCodex idle
guard remains as defense for synthetic or non-keyboard ETX input.

When `safeMouseMode=false`, Codex and TCodex retain their previous click replay
and browser event behavior. This is the macOS path.

测试注入可控时钟，必须覆盖：

- normal `detail=2` / `detail=3`；
- WebView target 重绘造成 `detail=1,1`；
- Windows 延迟窗口内第二击到达时，第一击也不得重放；
- Windows 只发生单击时，延迟窗口结束后仍须重放一次；
- 超时后的两个独立单击；
- 位移后的两个独立单击；
- drag 后点击链重置。
