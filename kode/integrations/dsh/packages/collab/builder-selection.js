export const selectionKey = draft => JSON.stringify(['builder-selection', draft.home_hub, draft.id])
const tuple = value => [value.profile_id, value.provider, value.model, value.effort, value.workspace?.host_id, value.workspace?.workspace_id, value.workspace?.root_ref]
export async function submitSelection({ storage, draft, revision, selection, request, signal, uuid = () => crypto.randomUUID() }) {
  const key = selectionKey(draft)
  const pending = await storage.reserve(key, { request_id: uuid(), state: 'prepared', home_hub: draft.home_hub,
    command: { draft_id: draft.id, draft_revision: draft.revision, expected_revision: revision, selection } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== draft.home_hub || pending.command?.draft_id !== draft.id) throw Error('Wrong selection scope')
  const command = { ...pending.command, request_id: pending.request_id }
  const result = await request(command, { signal })
  if (result.home_hub !== draft.home_hub || result.draft_id !== draft.id || result.request_id !== pending.request_id
    || result.draft_revision !== command.draft_revision || result.revision !== command.expected_revision + 1 || result.eligible_for_execution !== false
    || JSON.stringify(tuple(result.selection)) !== JSON.stringify(tuple(command.selection))) throw Error('Invalid selection receipt')
  await storage.save(key, { ...pending, state: 'accepted' })
  return result
}
export async function requestBuilderSelection(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/selection', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Selection not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
