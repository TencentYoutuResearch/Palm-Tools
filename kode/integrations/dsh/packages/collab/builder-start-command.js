/** One explicitly confirmed startup per draft. Terminal slots cannot be replaced by a fresh plan. */
export const builderStartKey = draft => JSON.stringify(['builder-start', draft.home_hub, draft.id])
export function verifyBuilderCreation(receipt, command, home) {
  const row = receipt?.request, operation = command.start.operation
  if (receipt?.state !== 'created' || !row || row.command_id !== command.command_id || row.session_id !== operation.worker.session_id
    || row.provider !== command.provider || row.model !== operation.selection_policy.model || row.effort !== (operation.selection_policy.effort ?? null)
    || row.profile_revision !== operation.selection_policy.profile_revision || row.cwd !== operation.grant_scope.target.root
    || row.builder?.draft_id !== command.start.draft_id || row.builder?.team_id !== command.team_id
    || typeof row.operation?.id !== 'string' || !Number.isSafeInteger(row.operation.attempt) || row.operation.attempt < 1 || !Number.isSafeInteger(row.operation.epoch) || row.operation.epoch < 1
    || (row.operation.home_node !== undefined && row.operation.home_node !== home)
    || !Array.isArray(row.tools) || JSON.stringify([...row.tools].sort()) !== JSON.stringify([...operation.grant_scope.tools].sort())) throw Error('Builder creation not confirmed')
}
export async function confirmBuilderStart({ storage, draft, command, request, signal }) {
  const key = builderStartKey(draft)
  const pending = await storage.reserve(key, { request_id: command.command_id, state: 'prepared', home_hub: draft.home_hub, command })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== draft.home_hub || pending.command?.start?.draft_id !== draft.id || pending.command.start.operation.worker.node_id !== draft.home_hub) throw Error('Wrong Builder start scope')
  if (pending.state === 'created') { verifyBuilderCreation(pending.receipt, pending.command, draft.home_hub); return pending.receipt }
  const receipt = await request(pending.command, { signal })
  verifyBuilderCreation(receipt, pending.command, draft.home_hub)
  await storage.save(key, { ...pending, state: 'created', receipt })
  return receipt
}
export async function requestBuilderStart(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/start', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Builder start not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
