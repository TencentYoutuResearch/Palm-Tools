/** Idle deadline, not a wall-clock or cumulative output budget. */
export function progressWatchdog(timeoutMs) {
  const controller = new AbortController()
  let timer, disposed = false, lastProgressAt = Date.now()
  const progress = () => {
    if (disposed || controller.signal.aborted) return
    lastProgressAt = Date.now()
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(Object.assign(new Error('Managed CLI made no progress before its idle deadline'),
      { name: 'TimeoutError', code: 'managed_cli_idle_timeout' })), timeoutMs)
    timer.unref?.()
  }
  progress()
  return { signal: controller.signal, progress, get lastProgressAt() { return lastProgressAt }, idleTimeoutMs: timeoutMs, dispose() { disposed = true; clearTimeout(timer) } }
}
