# Design

## Root cause

The Codex TUI renders its transcript in the alternate screen buffer. It sends
`CSI ? 1049 h` (alternate screen), `CSI ? 1003 ; 1006 h` (any-motion SGR mouse
reporting), and expects to receive SGR wheel reports to scroll.

`TerminalMouseTrackingGate` was introduced to stop accidental Windows TCodex
exits by removing mouse-tracking activation from PTY output. It currently strips
modes `9`, `1000`, `1002`, `1003`, `1005`, `1006`, and `1015`. Stripping `1003`
and `1006` leaves xterm without mouse reporting, so its no-scrollback wheel
fallback emits cursor keys. The Codex TUI maps those keys to prompt history.

`stripTerminalMouseReports` then also removes every SGR report, including wheel,
so even a correctly enabled terminal could not forward a scroll.

## Change

1. In `terminal_mouse_tracking.ts`, strip only the legacy or non-SGR modes
   `9`, `1005`, and `1015`. Button and motion modes `1000`, `1002`, `1003`, and
   SGR `1006` pass through so xterm stays on SGR reporting.

2. In `terminal_mouse_reports.ts`, preserve SGR wheel reports (`button 64` for
   up and `button 65` for down). All other SGR, urxvt, and X10 reports remain
   stripped, keeping clicks and drags away from the PTY.

The existing Ctrl+C guard, local gesture adapter, and accidental-exit recovery
remain unchanged.

## Verification

- Extend the tracking-gate tests for preserved SGR modes and split chunks.
- Extend the report-filter tests for preserved wheel reports.
- Run the terminal-mouse suite, the session-input suite, and the full GUI check.
- Validate on a live Windows TCodex session that wheel scrolls and clicks do
  not reach the PTY.
