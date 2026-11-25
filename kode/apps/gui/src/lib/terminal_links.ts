export type TerminalLinkEvent = {
  metaKey: boolean
  ctrlKey: boolean
}

export function terminalLinkActivationEnabled(
  event: TerminalLinkEvent | null | undefined,
  windowsPlatform: boolean,
): boolean {
  if (!event) return false
  return windowsPlatform || event.metaKey
}
