export const MAX_MONITOR_ATTACHMENTS = 6
const REFERENCE_PREFIX = 'Attached file: '

export function composeMonitorMessage(text: string, paths: readonly string[]): string {
  const body = text.trim()
  if (paths.length === 0) return body
  const references = paths.map((path) => `${REFERENCE_PREFIX}${path}`).join('\n')
  return body ? `${body}\n\n${references}` : references
}

/** Align with mobile's /input contract: one logical message ends with LF. */
export function normalizeMonitorMessage(text: string): string {
  const body = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
  return body ? `${body}\n` : ''
}

export function monitorAttachmentName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

export function insertMonitorNewline(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): { text: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, text.length))
  const end = Math.max(start, Math.min(selectionEnd, text.length))
  return {
    text: `${text.slice(0, start)}\n${text.slice(end)}`,
    cursor: start + 1,
  }
}
