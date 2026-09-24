/**
 * xterm accepts a CSS font-family list. Stored presets are usually one family,
 * while platform defaults can already be a complete fallback stack.
 */
export function terminalFontFamilyStack(primary: string, fallback: string): string {
  const value = primary.trim()
  if (!value) return fallback
  if (value.includes(',')) return value
  const quoted = value === 'monospace'
    ? value
    : `"${value.replaceAll('"', '\\"')}"`
  return `${quoted}, ${fallback}`
}
