export const runCancelKey = run => JSON.stringify(['run-cancel', run.home_hub, run.team_id, run.id])
export async function cancelRun({ storage, run, request, signal, uuid = () => crypto.randomUUID() }) {
  const key = runCancelKey(run)
  const pending = await storage.reserve(key, { request_id: uuid(), home_hub: run.home_hub, team_id: run.team_id, state: 'prepared', command: { run_id: run.id, action: 'request_cancel', expected_revision: run.revision, reason: '用户在 IM 请求取消任务' } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== run.home_hub || pending.team_id !== run.team_id || pending.command.run_id !== run.id) throw Error('Wrong run')
  const result = await request({ ...pending.command, request_id: pending.request_id }, { signal })
  if (result.id !== run.id || result.home_hub !== run.home_hub || result.team_id !== run.team_id || result.cancellation?.request_id !== pending.request_id
    || result.revision !== pending.command.expected_revision + 1 || result.state !== 'cancelling' || result.completion_authorized !== false) throw Error('Invalid cancellation receipt')
  await storage.save(key, { ...pending, state: 'accepted' })
  return result
}
export async function requestRunCancel(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/work-run', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Cancellation not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
