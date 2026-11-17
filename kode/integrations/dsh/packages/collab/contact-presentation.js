/** Render real last-message data; a partial loaded page must not replace a newer directory preview. */
export function contactPreview(team, history) {
  const latest = history?.items?.at(-1)
  const stored = team.contact?.preview
  const message = latest && (!Number.isSafeInteger(stored?.sequence) || latest.sequence >= stored.sequence)
    ? { content: latest.content, actor: latest.actor?.kind, created_at: latest.created_at } : stored
  if (typeof message?.content !== 'string' || !message.content.trim()) return '还没有消息'
  return (message.actor === 'human' ? '你：' : '') + Array.from(message.content.replace(/\s+/g, ' ').trim()).slice(0,160).join('')
}
export function contactTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isFinite(new Date(value).getTime())) return ''
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
