---
schema_version: 2
id: fix-windows-tcodex-multiclick
kind: bug
document_class: work_item
work_type: bug
title: 修复 Windows TCodex 鼠标双击退出会话
status: in_progress
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
- 第一击先进入延迟队列；第二次点击即使 `detail=1` 也识别为双击，撤销第一击，
  执行本地选词且整个双击过程不向 PTY 转发。
- 第三次连续点击识别为三击并本地选行。
- 超时、位置明显变化或拖拽后重置点击链。
- 保持单击可操作 expandable TCodex 内容，保持拖拽选区不发送鼠标输入。

## Acceptance criteria

- [x] Windows/WebView2 重置 `detail` 时，同位置 500 ms 内的双击全过程不向
      TCodex 重放鼠标输入。
- [x] 连续第三击只做本地整行选择，不发送 PTY 输入。
- [x] 超过双击时间窗口或移动超过阈值后的点击仍分别转发。
- [x] 单击 expandable 内容、拖拽选区和 triple-click 既有行为不回退。
- [x] 单元测试覆盖 `detail=1 -> detail=1`、延迟单击、独立点击和清理路径。
- [ ] Windows debug 构建中双击运行中的 TCodex 会话，进程、turn 和 tab 均保持。

## Out of scope

- 改变 Ctrl+C 的 interrupt 或关闭确认语义。
- 替换 xterm.js 或修改 TCodex CLI 自身键位。
- 修改远程 command、session sync 或 Worker 状态机。

## Corrected root cause

The previous implementation replayed the first click immediately on mouseup. By
the time the second click confirmed a double-click, the first mouse report had
already reached TCodex. Suppressing only the second click is therefore not a
complete ownership boundary for multi-click gestures.

The corrected design buffers every single click until the multi-click window
has elapsed. A confirmed multi-click cancels the buffered click and remains a
local text selection, so TCodex receives no click reports for that gesture.

The acceptance criteria additionally require that both a first click and a
confirmed second or third click result in zero forwarded mouse input. A queued
single click must still be replayed exactly once when no matching follow-up
click arrives.

## Follow-up after installed-build validation

After installing the deferred-click build, the user still reproduced an
intermittent TCodex exit while clicking repeatedly. The TCodex log for the
session contained a normal startup and no error before the process disappeared;
three seconds later Kode removed the tab from `state.json`. This means Kode
cannot always predict that TCodex will treat a mouse report as a quit action.

The follow-up has two layers:

- For `tcodex`, stop forwarding primary mouse clicks to the TUI entirely.
  Clicking remains a Kode-local selection surface; word and line selection still
  work, while TCodex only receives keyboard input.
- When a running TCodex process exits with code 0, keep the tab as exited and
  show a recovery confirmation instead of silently deleting it. The user can
  restore the same native conversation or defer handling and keep the tab.

Kode cannot show a prompt inside TCodex before an external process exits.
Therefore the enforceable contract is no click-triggered exit plus a visible
recovery gate before Kode discards the session.

## Final transport-boundary correction

The installed safe-mouse build still allowed a probabilistic exit. That means
the front-end gesture classifier is not a sufficient trust boundary by itself:
event ordering, target redraw, or installation timing can still leave a path
where xterm produces a mouse report.

The final design moves the guarantee to the last Kode-owned boundary before PTY
input:

- Install terminal gesture ownership for every PTY session, then decide from the
  current tab backend at event time rather than only at mount time.
- For `tcodex`, strip all SGR, urxvt, and X10 mouse-report sequences in
  `term.onData` before `write_input` reaches the PTY.
- Keep all left-button selection handling local. Swallow native `click` and
  `dblclick` events inside a TCodex terminal.
- Retain the post-exit recovery confirmation as a fallback, not as the primary
  defense.

This preserves Kode-local text selection and keyboard interaction while making
it impossible for a click-generated mouse report to reach TCodex.

## Root fix at xterm mode activation

Filtering mouse reports after xterm generates them is still late in the input
pipeline. The final Windows defense prevents xterm from entering mouse-reporting
mode at all:

- Strip TCodex DECSET activation sequences for X10, VT200, button-event,
  any-event, UTF-8, SGR, and urxvt mouse modes before writing TCodex output into
  xterm.
- Handle DECSET sequences split across PTY chunks.
- Preserve unrelated DEC private modes and all normal terminal output.
- Keep the PTY input filter as a second defense in case a future TCodex/xterm
  path generates a report without activation.

With tracking mode never active, xterm keeps its native text selection path and
cannot generate mouse reports from repeated clicks.

Logs from the installed build exposed one remaining bypass: when Terminal
mounts, Kode replays `initialBytes` from the PTY subscription directly into
xterm instead of calling `writeTerminalBytes`. TCodex enables mouse reporting
during this startup window, so the initial replay can still activate xterm's
mouse mode before live output reaches the gate.

The initial replay must pass through the same Windows TCodex mouse-tracking gate
before the first bytes are written. Startup and live output must have identical
filtering semantics.

The current TCodex logs do not record terminal input or process shutdown. To
avoid further speculative fixes, an opt-in Windows/TCodex audit records only:

- timestamp and session id;
- exact bytes accepted by `write_input`, hex encoded;
- `PtyExited` exit code.

The audit is enabled only with `KODE_TCODEX_INPUT_AUDIT=1`, writes locally to
`%LOCALAPPDATA%\\kode\\tcodex-input-audit.jsonl`, and is disabled by default.
It is diagnostic evidence for identifying whether the final input is a mouse
report, keyboard sequence, or there is no input at all before exit.

The audit captured the actual failure:

```text
0d    Enter
03    Ctrl+C
1b5b4f
exit code 0
```

There were no mouse reports. TCodex exits after the first bare Ctrl+C while
idle, but Kode's consecutive-Ctrl+C guard forwarded the first Ctrl+C and only
held the second. The Windows TCodex policy must confirm the first bare Ctrl+C
when the session is not busy. While busy, the first Ctrl+C remains an interrupt
and the existing consecutive-Ctrl+C confirmation still applies.

The user then requested a stronger Windows UX rule: Ctrl+C belongs to the
clipboard layer and must not be interpreted as a session-ending command in
Kode. With a selection it copies that text; without a selection it is consumed
as a no-op. It must not reach the PTY or trigger close confirmation. Explicit
tab close remains available, and macOS behavior is unchanged.

## Platform boundary

The user confirmed that macOS behavior is currently correct and must not be
changed by this Windows bug fix. All new exit-prevention layers are therefore
Windows-only:

- PTY mouse-report stripping applies only when the WebView user agent is
  Windows and the current backend is TCodex.
- TCodex safe-mouse mode and native click/dblclick swallowing apply only on
  Windows.
- TCodex exit recovery confirmation applies only on Windows.
- macOS keeps the existing terminal click and selection behavior, including the
  existing delayed single-click replay.

Tests must verify the platform predicate and prove that safe-mouse behavior is
disabled when the Windows flag is false.

## Constitution conflicts

None. 变更只过滤终端鼠标输入，不改变 PTY ownership、backend 参数或 SpecOps run
隔离。
