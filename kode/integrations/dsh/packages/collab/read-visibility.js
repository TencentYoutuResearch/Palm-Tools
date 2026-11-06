/** Advance only a contiguous prefix presented in the active conversation viewport. */
export function observeConversationRead({ root, getState, markRead, document: doc = globalThis.document, window: win = globalThis.window }) {
  const seen = new Set(), tops = new Set()
  let stopped = false, busy = false
  const scan = async () => {
    if (stopped || busy || doc.visibilityState === 'hidden' || !doc.hasFocus() || !root.isConnected) return
    const state = getState()
    if (!state?.readState) return
    const bounds = root.getBoundingClientRect()
    const top = Math.max(0, bounds.top), bottom = Math.min(win.innerHeight, bounds.bottom)
    if (bottom <= top || bounds.width <= 0) return
    for (const node of root.querySelectorAll('[data-message-sequence]')) {
      const sequence = Number(node.dataset.messageSequence), box = node.getBoundingClientRect()
      if (box.width <= 0 || box.right <= 0 || box.left >= win.innerWidth) continue
      if (box.top >= top && box.top < bottom) tops.add(sequence)
      if (tops.has(sequence) && box.bottom > top && box.bottom <= bottom) seen.add(sequence)
    }
    let through = state.readState.through_sequence
    for (const item of state.items) {
      if (item.sequence <= through) continue
      if (!seen.has(item.sequence)) break
      through = item.sequence
    }
    if (through <= state.readState.through_sequence) return
    busy = true
    try { await markRead(through) } finally { busy = false }
  }
  // Sampling avoids acknowledging a transient mount or a single fast scroll frame.
  const timer = win.setInterval(() => { void scan() }, 1000)
  return () => { stopped = true; win.clearInterval(timer); seen.clear(); tops.clear() }
}
