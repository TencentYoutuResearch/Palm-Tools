export function isWindowsUserAgent(userAgent: string): boolean {
  return /Windows/i.test(userAgent)
}
