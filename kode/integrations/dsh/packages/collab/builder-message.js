export const builderMessageKey = (draft, created) => JSON.stringify(['builder-message', draft.home_hub, draft.id, created.request.operation.id])
export async function sendBuilderMessage({ storage, draft, created, content, request, signal, uuid = () => crypto.randomUUID() }) {
  const operation = created.request.operation, key = builderMessageKey(draft, created)
  const pending = await storage.reserve(key, { request_id: uuid(), state: 'prepared', home_hub: draft.home_hub,
    command: { operation_id: operation.id, draft_id: draft.id, attempt: operation.attempt, epoch: operation.epoch, content } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== draft.home_hub || pending.command?.operation_id !== operation.id || pending.command.draft_id !== draft.id) throw Error('Wrong Builder message scope')
  const command = { ...pending.command, request_id: pending.request_id }, result = await request(command, { signal })
  if (result.receipt?.operation_id !== operation.id || result.receipt.home_hub !== draft.home_hub || result.receipt.worker?.session_id !== created.request.session_id
    || result.receipt.worker?.node_id !== draft.home_hub || result.receipt.actor?.kind !== 'human' || result.receipt.state !== 'queued' || typeof result.receipt.message_id !== 'string'
    || ['request_id', 'draft_id', 'attempt', 'epoch', 'content'].some(key => result.request?.[key] !== command[key])) throw Error('Invalid Builder message receipt')
  await storage.save(key, { ...pending, state: 'accepted' })
  return result
}
export async function requestBuilderMessage(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/input', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Builder input not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
