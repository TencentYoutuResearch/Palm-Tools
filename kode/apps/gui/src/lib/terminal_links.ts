export type TerminalLinkModifiers = {
  metaKey: boolean
  ctrlKey: boolean
}

export function terminalLinkModifierPressed(
  event: TerminalLinkModifiers | null | undefined,
  windowsPlatform: boolean,
): boolean {
  if (!event) return false
  return event.metaKey || (windowsPlatform && event.ctrlKey)
}
