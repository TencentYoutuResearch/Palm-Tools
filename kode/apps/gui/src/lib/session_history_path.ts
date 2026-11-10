/** Return true for paths that the native session-history command can query. */
export function isAbsoluteSessionCwd(value: string): boolean {
  const path = value.trim()
  if (!path) return false
  if (path.startsWith('/')) return true
  if (/^[A-Za-z]:[\\/]/.test(path)) return true
  // Standard UNC paths and Windows verbatim UNC paths.
  return /^\\\\(?:\?\\UNC\\|[^\\])/i.test(path)
}
