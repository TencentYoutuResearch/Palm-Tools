import React from 'react'
import { Icon } from './icons.js'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { messagePreview } from './message-preview.js'
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
export function MessageWindow({ renderAvatar, items, team, heightCache, scrollRef, onScroll, followLatest = false, children }) {
  const heights = useRef(heightCache ?? new Map()), nodes = useRef(new Map()), observer = useRef(), frame = useRef(null)
  const following = useRef(false), followingEnabled = useRef(false), pinning = useRef(false)
  const [away, setAway] = useState(false)
  const [expanded, setExpanded] = useState({})
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
      if (root && followLatest) {
        if (pinning.current && following.current) root.scrollTop = root.scrollHeight
        else following.current = root.scrollHeight - root.clientHeight - root.scrollTop <= 48
        setAway(!following.current)
      }
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
      if (followLatest && following.current) root.scrollTop = root.scrollHeight
      else if (correction) root.scrollTop += correction
      if (changed) { measurementRevision.current++; schedule() }
    })
    observer.current.observe(root)
    for (const node of nodes.current.values()) observer.current.observe(node)
    schedule()
    return () => { observer.current?.disconnect(); observer.current = undefined; if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null }
  }, [scrollRef, followLatest])
  // Parent may restore scrollTop after the first layout without emitting a scroll event.
  useLayoutEffect(() => {
    const root = scrollRef.current
    // Mount/restoration owns the initial reading position; only later appends follow.
    if (root && followLatest && followingEnabled.current && following.current) root.scrollTop = root.scrollHeight
    followingEnabled.current = followLatest
    schedule()
  }, [items, followLatest, viewport.revision, away])
  const model = messageWindow(items, heights.current, viewport.top, viewport.height, 600, offsets)
  const bind = id => node => {
    const old = nodes.current.get(id)
    if (old === node) return
    if (old) observer.current?.unobserve(old)
    if (node) { nodes.current.set(id, node); observer.current?.observe(node) } else nodes.current.delete(id)
  }
  return h(React.Fragment, null, h('div', { className: 'kode-collab-messages', ref: scrollRef, onWheel: () => { pinning.current = false }, onPointerDown: () => { pinning.current = false }, onTouchStart: () => { pinning.current = false }, onKeyDown: () => { pinning.current = false }, onScroll: event => { if (followLatest && !pinning.current) following.current = event.currentTarget.scrollHeight - event.currentTarget.clientHeight - event.currentTarget.scrollTop <= 48; schedule(); onScroll?.(event) }, style: { overflowAnchor: 'none' } },
    h('div',{className:'kode-collab-reading-column'},
    h('div', { key: 'before', 'aria-hidden': true, style: { height: model.before } }),
    ...items.slice(model.start, model.end).map(message => { const preview = messagePreview(message.content, message.actor?.kind); return h('article', { key: message.id, ref: bind(message.id), className: 'kode-collab-message', 'data-message-id': message.id, 'data-author': message.actor?.kind, 'data-message-sequence': message.sequence },
      h('span', { className: 'kode-collab-message-avatar', 'aria-hidden': true }, renderAvatar ? renderAvatar(message) : h(Icon, {name:message.actor?.kind === 'human'?'user':'agent',size:18})),
      h('div', { className: 'kode-collab-message-body' },
      h('strong', null, message.actor?.kind === 'human' ? '你' : message.actor?.kind === 'superagent' ? team.spec?.name || 'Superagent' : '系统'),
      message.prior_run_id && h('small', null, '关联原任务：', message.prior_run_id),
      h('div', { className: 'kode-collab-message-content' }, preview && !expanded[message.id]
        ? h(React.Fragment, null, h('small', { className: 'kode-collab-excerpt-label' }, '原文预览'), h('p', { className: 'kode-collab-excerpt' }, preview.excerpt))
        : message.actor?.kind === 'human' ? message.content : h(MarkdownText, { text: message.content })),
      preview && h('button', { type: 'button', className: 'kode-collab-text-link', 'aria-expanded': !!expanded[message.id], onClick: () => setExpanded(value => ({ ...value, [message.id]: !value[message.id] })) }, expanded[message.id] ? '收起完整原文' : `展开完整原文（${preview.length} 字）`)))}),
    h('div', { key: 'after', 'aria-hidden': true, style: { height: model.after } }), children)),
    followLatest && away && h('div', { className: 'kode-collab-message-navigation' },
      h('button', { type: 'button', className: 'kode-collab-button', onClick: () => {
        following.current = true; pinning.current = true
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        setAway(false); schedule()
      } }, '回到最新消息')))
}
