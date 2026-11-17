/** Display-only excerpt. The complete source remains available, unchanged. */
export function messagePreview(content, actor) {
  if (actor === 'human' || typeof content !== 'string' || (content.length <= 600 && content.split('\n').length <= 8)) return null
  const paragraph = content.trimStart().split(/\n\s*\n/)[0]
  const excerpt = paragraph.length > 280 ? paragraph.slice(0, 280) + '…' : paragraph
  return { excerpt, length: content.length }
}
