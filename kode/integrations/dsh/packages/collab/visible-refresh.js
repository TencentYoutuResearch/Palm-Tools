/** One bounded read at a time, only while its mounted surface is visible. */
export function visibleRefresh({ refresh, document: doc = globalThis.document, delay = 3000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let disposed = false, running = false, timer = null, wake = false, controller
  const visible = () => doc.visibilityState !== 'hidden'
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null }
  const tick = async () => {
    clear()
    if (disposed || !visible()) return
    if (running) { wake = true; return }
    running = true; wake = false; controller = new AbortController()
    let next = delay
    try { const requested = await refresh(controller.signal); if (Number.isFinite(requested)) next = Math.max(250, Math.min(30000, requested)) }
    catch { next = 10000 }
    finally {
      running = false
      if (!disposed && visible()) { timer = setTimer(tick, wake ? 0 : next); wake = false }
    }
  }
  const changed = () => { clear(); if (!visible()) controller?.abort(); if (visible()) void tick() }
  doc.addEventListener('visibilitychange', changed)
  void tick()
  return () => { disposed = true; controller?.abort(); clear(); doc.removeEventListener('visibilitychange', changed) }
}
