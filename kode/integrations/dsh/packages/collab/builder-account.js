import { canonical } from './builder-accept-command.js'
export const builderAccountKey = draft => JSON.stringify(['builder-account', draft.home_hub, draft.id])
export async function selectedBuilderResource(draft, request, signal) {
  const selected = await request(`/api/kode/builder/selection?draft_id=${encodeURIComponent(draft.id)}`, { signal })
  if (selected.home_hub !== draft.home_hub || selected.draft_id !== draft.id || selected.record?.draft_revision !== draft.revision) throw Error('Selection unavailable')
  let after = '', count = 0
  do {
    const page = await request(`/api/kode/resource-coverage?limit=100&after=${encodeURIComponent(after)}`, { signal })
    if (page.host !== draft.home_hub || page.scope !== 'host_execution_resources' || !Array.isArray(page.items) || page.items.length > 100 || (count += page.items.length) > 2000) throw Error('Invalid coverage')
    let cursor = after
    for (const row of page.items) { if (row.host !== draft.home_hub || typeof row.cursor !== 'string' || row.cursor <= cursor) throw Error('Invalid resource'); cursor = row.cursor }
    if (page.next_cursor !== null && (!page.items.length || page.next_cursor !== cursor)) throw Error('Invalid continuation')
    const resource = page.items.find(row => row.resource_kind === 'execution_profile' && row.profile_id === selected.record.selection.profile_id)
    if (resource) return { selection: selected.record, resource }
    after = page.next_cursor
  } while (after !== null)
  throw Error('Selected resource missing')
}
export async function confirmBuilderAccount({ storage, draft, command, selection, request, signal }) {
  const key = builderAccountKey(draft)
  const pending = await storage.reserve(key, { state: 'prepared', home_hub: draft.home_hub, request_id: command.request_id, command, selection })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== draft.home_hub || pending.command?.draft_id !== draft.id) throw Error('Wrong account scope')
  const result = await request(pending.command, { signal })
  const { draft_id, ...sent } = pending.command
  const binding = result.binding
  if (result.home_hub !== draft.home_hub || result.draft_id !== draft_id || canonical(result.request) !== canonical(sent)
    || canonical(result.selection) !== canonical(pending.selection.selection) || result.quota_status !== 'not_checked' || result.execution_started !== false || result.activation_performed !== false
    || result.account_created !== sent.create_account || binding?.host !== draft.home_hub || binding.profile !== pending.selection.selection.profile_id
    || binding.account_id !== sent.account_id || binding.account_epoch !== sent.account_epoch || binding.revision !== sent.expected_binding_revision + 1) throw Error('Invalid account receipt')
  await storage.save(key, { ...pending, state: 'accepted', receipt: result })
  return result
}
export async function requestBuilderAccount(command, { signal } = {}) {
  const response = await fetch('/api/kode/builder/account', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) throw Error('Account not confirmed')
  return response.json()
}
