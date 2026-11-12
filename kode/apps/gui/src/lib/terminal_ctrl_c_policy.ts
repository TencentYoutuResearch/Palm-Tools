function isTcodex(backendKey: string): boolean {
  const normalized = backendKey.trim().toLowerCase()
  return normalized === 'tcodex' || normalized.endsWith(':tcodex')
}

export function shouldConfirmTcodexCtrlC(
  data: string,
  windows: boolean,
  backendKey: string,
  status: string | undefined,
): boolean {
  return windows
    && data === '\x03'
    && isTcodex(backendKey)
    && status !== 'busy'
}
