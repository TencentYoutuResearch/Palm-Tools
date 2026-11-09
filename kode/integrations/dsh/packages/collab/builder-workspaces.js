/** Durable identity for one explicit workspace patch; unresolved patches are never replaced. */
export const workspaceKey = draft => JSON.stringify(['builder-workspaces', draft.home_hub, draft.id])
export async function submitWorkspaces({ storage, draft, workspace_refs, request, uuid = () => crypto.randomUUID(), signal }) {
  const key = workspaceKey(draft)
  const pending = await storage.reserve(key, { request_id: uuid(), state: 'prepared', home_hub: draft.home_hub,
    command: { draft_id: draft.id, expected_revision: draft.revision, workspace_refs } })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== draft.home_hub || pending.command?.draft_id !== draft.id) throw Error('Wrong draft')
  const command = { ...pending.command, request_id: pending.request_id }
  const receipt = await request(command, { signal })
  if (receipt.id !== draft.id || receipt.home_hub !== draft.home_hub || receipt.revision !== command.expected_revision + 1
    || JSON.stringify(receipt.interview?.workspace_refs?.map(row => [row.host_id, row.workspace_id, row.root_ref])) !== JSON.stringify(command.workspace_refs.map(row => [row.host_id, row.workspace_id, row.root_ref]))) throw Error('Invalid workspace receipt')
  await storage.save(key, { ...pending, state: 'accepted' })
  return receipt
}
export async function requestBuilderWorkspaces(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/workspaces', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Answers not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
