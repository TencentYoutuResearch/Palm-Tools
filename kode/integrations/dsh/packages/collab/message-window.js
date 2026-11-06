import React from 'react'
const h = React.createElement
const { useRef, useState, useLayoutEffect, useMemo } = React

/** Prefix heights allow arbitrary message sizes without rendering the entire history. */
export function messageOffsets(items, heights) {
  const offsets = [0]
  for (const item of items) offsets.push(offsets.at(-1) + (heights.get(item.id) ?? 120))
  return offsets
}
export function messageWindow(items, heights, top, viewport, overscan = 600, offsets = messageOffsets(items, heights)) {
  const find = position => {
    let lo = 0, hi = items.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (offsets[mid + 1] <= position) lo = mid + 1; else hi = mid }
    return lo
  }
  const start = find(Math.max(0, top - overscan)), end = Math.min(items.length, find(top + Math.max(1, viewport) + overscan) + 1)
  return { start, end, before: offsets[start], after: offsets.at(-1) - offsets[end], offsets }
}

/** Stable keyed visible articles; ResizeObserver preserves the anchor when earlier heights change. */
export function MessageWindow({ items, team, heightCache, scrollRef, onScroll, children }) {
  const heights = useRef(heightCache ?? new Map()), nodes = useRef(new Map()), observer = useRef(), frame = useRef(null)
  const measurementRevision = useRef(0)
  const [viewport, setViewport] = useState({ top: 0, height: 600, revision: 0 })
  const offsets = useMemo(() => messageOffsets(items, heights.current), [items, viewport.revision])
  const indices = useMemo(() => new Map(items.map((item, i) => [item.id, i])), [items])
  const current = useRef(); current.current = { offsets, indices }
  const schedule = () => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const root = scrollRef.current
      if (root) setViewport({ top: root.scrollTop, height: root.clientHeight, revision: measurementRevision.current })
    })
  }
  useLayoutEffect(() => {
    const root = scrollRef.current
    if (!root) return
    observer.current = new ResizeObserver(entries => {
      const state = current.current
      let correction = 0, changed = false
      for (const entry of entries) {
        const id = entry.target.dataset.messageId
        if (!id) { schedule(); continue }
        const size = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height
        // Include the unchanged article's 28px bottom margin in the virtual extent.
        const height = Math.max(1, size + 28), old = heights.current.get(id) ?? 120
        if (Math.abs(height - old) < 0.5) continue
        if (state.offsets[state.indices.get(id) + 1] <= root.scrollTop) correction += height - old
        heights.current.set(id, height); changed = true
      }
      if (correction) root.scrollTop += correction
      if (changed) { measurementRevision.current++; schedule() }
    })
    observer.current.observe(root)
    for (const node of nodes.current.values()) observer.current.observe(node)
    schedule()
    return () => { observer.current?.disconnect(); observer.current = undefined; if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null }
  }, [scrollRef])
  // Parent may restore scrollTop after the first layout without emitting a scroll event.
  useLayoutEffect(schedule, [items.length])
  const model = messageWindow(items, heights.current, viewport.top, viewport.height, 600, offsets)
  const bind = id => node => {
    const old = nodes.current.get(id)
    if (old === node) return
    if (old) observer.current?.unobserve(old)
    if (node) { nodes.current.set(id, node); observer.current?.observe(node) } else nodes.current.delete(id)
  }
  return h('div', { className: 'kode-collab-messages', ref: scrollRef, onScroll: event => { schedule(); onScroll?.(event) }, style: { overflowAnchor: 'none' } },
    h('div', { key: 'before', 'aria-hidden': true, style: { height: model.before } }),
    ...items.slice(model.start, model.end).map(message => h('article', { key: message.id, ref: bind(message.id), className: 'kode-collab-message', 'data-message-id': message.id, 'data-author': message.actor?.kind, 'data-message-sequence': message.sequence },
      h('strong', null, message.actor?.kind === 'human' ? '你' : message.actor?.kind === 'superagent' ? team.spec?.name || 'Superagent' : '系统'),
      message.prior_run_id && h('small', null, '关联原任务：', message.prior_run_id),
      h('div', { className: 'kode-collab-message-content' }, message.content))),
    h('div', { key: 'after', 'aria-hidden': true, style: { height: model.after } }), children)
}
