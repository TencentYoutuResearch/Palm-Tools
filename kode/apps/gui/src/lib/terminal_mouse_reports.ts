const SGR_MOUSE_REPORT = /\x1b\[<[0-9;]+[Mm]/g
const URXVT_MOUSE_REPORT = /\x1b\[[0-9]+;[0-9]+;[0-9]+M/g
const X10_MOUSE_REPORT = /\x1b\[M[\s\S]{3}/g

/**
 * Remove terminal mouse reports while preserving keyboard input and escape
 * sequences. xterm may use any of the common protocols depending on the TUI.
 */
export function stripTerminalMouseReports(data: string): string {
  return data
    .replace(SGR_MOUSE_REPORT, '')
    .replace(URXVT_MOUSE_REPORT, '')
    .replace(X10_MOUSE_REPORT, '')
}
