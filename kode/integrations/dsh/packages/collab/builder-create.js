export const createDraftKey = home => JSON.stringify(['builder-create', home])
export async function createBuilderDraft({ storage, home, purpose, request, signal, uuid = () => crypto.randomUUID() }) {
  const key = createDraftKey(home)
  const pending = await storage.reserve(key, { request_id: uuid(), state: 'prepared', home_hub: home, command: { draft_id: uuid(), purpose } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== home) throw Error('Wrong home')
  const receipt = await request({ ...pending.command, request_id: pending.request_id }, { signal })
  if (receipt.home_hub !== home || receipt.id !== pending.command.draft_id || receipt.request_id !== pending.request_id || receipt.revision !== 1
    || receipt.eligible_for_execution !== false || receipt.interview?.purpose !== pending.command.purpose) throw Error('Invalid draft receipt')
  await storage.save(key, { ...pending, state: 'accepted' })
  return receipt
}
export async function requestCreateDraft(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/create-draft', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Draft not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
