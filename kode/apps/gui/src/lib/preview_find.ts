/** Search visible preview text, preserving markup, source line numbers, and SVG labels. */
export function findPreviewRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: { node: Text; start: number; end: number }[] = []
  let text = ''
  let previousBlock: Element | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const parent = node.parentElement
    if (!parent || parent.closest('.line-numbers, script, style, title, desc, [aria-hidden="true"], [hidden]')) continue
    const block = parent.closest('p, pre, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, text, .preview-text:not(.hljs) > span')
    if (nodes.length && block !== previousBlock) text += '\n'
    previousBlock = block
    const start = text.length
    text += node.data
    nodes.push({ node, start, end: text.length })
  }
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const ranges: Range[] = []
  let firstNode = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index!
    const end = start + match[0].length
    while (firstNode < nodes.length && nodes[firstNode].end <= start) firstNode++
    const first = nodes[firstNode]
    if (!first) break
    let lastNode = firstNode
    while (lastNode < nodes.length && nodes[lastNode].end < end) lastNode++
    const last = nodes[lastNode]
    if (!last) break
    const range = document.createRange()
    range.setStart(first.node, start - first.start)
    range.setEnd(last.node, end - last.start)
    ranges.push(range)
  }
  return ranges
}

export function revealPreviewRange(range: Range, root: HTMLElement) {
  let parent = range.startContainer.parentElement
  while (parent && root.contains(parent)) {
    if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) {
      const rect = range.getBoundingClientRect()
      const bounds = parent.getBoundingClientRect()
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) parent.scrollTop += rect.top - bounds.top - parent.clientHeight / 2
      if (rect.left < bounds.left || rect.right > bounds.right) parent.scrollLeft += rect.left - bounds.left - parent.clientWidth / 2
    }
    if (parent === root) break
    parent = parent.parentElement
  }
}
