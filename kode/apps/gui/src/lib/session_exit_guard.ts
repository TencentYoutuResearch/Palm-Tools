const TCODEX_BACKEND = 'tcodex'

export function isTcodexBackendKey(backendKey: string): boolean {
  const normalized = backendKey.trim().toLowerCase()
  return normalized === TCODEX_BACKEND || normalized.endsWith(`:${TCODEX_BACKEND}`)
}

export function shouldOfferTcodexExitRecovery(
  tab: { backendKey: string } | undefined,
  code: number | null,
): boolean {
  return code === 0 && Boolean(tab && isTcodexBackendKey(tab.backendKey))
}
