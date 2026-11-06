/** Observe native stdout consumption independently from process/group termination. */
export function observeCodexOutputDrain(stdout, { timeoutMs = 2000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    throw new Error('Invalid Codex output-drain deadline')
  }
  let resolve, timer, settled = false
  const result = new Promise(done => { resolve = done })
  const cleanup = () => {
    clearTimeout(timer)
    stdout?.off('end', ended)
    stdout?.off('error', failed)
    stdout?.off('close', closed)
  }
  const finish = (drained, reason) => {
    if (settled) return
    settled = true
    cleanup()
    resolve(Object.freeze({ drained, reason }))
  }
  const ended = () => finish(true, 'stdout_ended')
  const failed = () => finish(false, 'stdout_error')
  const closed = () => finish(Boolean(stdout.readableEnded), stdout.readableEnded ? 'stdout_ended' : 'stdout_closed_before_end')
  if (!stdout) finish(false, 'stdout_missing')
  else if (stdout.readableEnded) ended()
  else if (stdout.destroyed) closed()
  else {
    stdout.on('end', ended)
    stdout.on('error', failed)
    stdout.on('close', closed)
    // One deadline covers the entire observation, including the caller's close.
    // It is never extended by further bytes, cancellation or a repeated wait().
    timer = setTimeout(() => finish(false, 'drain_timeout'), timeoutMs)
  }
  return {
    wait: () => result,
    dispose: () => finish(false, 'observer_disposed'),
  }
}
