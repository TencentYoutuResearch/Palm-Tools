export const fundingKey = draft => JSON.stringify(['builder-funding', draft.home_hub, draft.id])
const fields = ['request_id', 'draft_revision', 'selection_revision', 'unit', 'limit', 'starts_at', 'ends_at', 'input_per_million', 'cached_per_million', 'output_per_million']
const tools = ['kode_builder_read_draft', 'kode_builder_preflight', 'kode_builder_inspect_workspace', 'kode_builder_prepare_questions', 'kode_builder_save_draft', 'kode_builder_catalog', 'kode_builder_policy_details'].sort()
export async function confirmFunding({ storage, draft, command, selection, request, signal, uuid = () => crypto.randomUUID() }) {
  const key = fundingKey(draft)
  const pending = await storage.reserve(key, { request_id: uuid(), state: 'prepared', home_hub: draft.home_hub, command: { ...command, draft_id: draft.id }, selection })
  if (signal?.aborted) throw Error('Disposed')
  if (pending.home_hub !== draft.home_hub || pending.command?.draft_id !== draft.id) throw Error('Wrong funding scope')
  const sent = { ...pending.command, request_id: pending.request_id }
  const result = await request(sent, { signal })
  const grant = result.grant?.policy, budget = result.budget, price = result.price, workspace = pending.selection.selection.workspace
  if (result.home_hub !== draft.home_hub || result.draft_id !== draft.id || result.label !== '团队预算' || result.purpose !== 'builder_creation'
    || result.execution_started !== false || result.activation_performed !== false || fields.some(key => result.request?.[key] !== sent[key])
    || result.selection?.revision !== sent.selection_revision || result.selection?.draft_revision !== sent.draft_revision
    || JSON.stringify(result.selection.selection) !== JSON.stringify(pending.selection.selection)
    || !budget || budget.limit !== sent.limit || budget.unit !== sent.unit || budget.starts_at !== sent.starts_at || budget.ends_at !== sent.ends_at || budget.spent !== 0 || budget.reserved !== 0
    || !price || price.model !== pending.selection.selection.model || price.unit !== sent.unit || price.model_policy !== 'requested_model'
    || ['input_per_million', 'cached_per_million', 'output_per_million'].some(key => price[key] !== sent[key])
    || !grant || grant.network !== false || grant.enabled !== true || grant.expires_at !== sent.ends_at || grant.team_id !== budget.scope_id || budget.scope !== 'team'
    || JSON.stringify([...grant.capabilities].sort()) !== JSON.stringify(['builder_draft_write', 'read'])
    || JSON.stringify([...grant.tools].sort()) !== JSON.stringify(tools) || JSON.stringify(grant.budget_ids) !== JSON.stringify([budget.id])
    || grant.targets?.length !== 1 || grant.targets[0].host !== workspace.host_id || grant.targets[0].workspace !== workspace.workspace_id || grant.targets[0].root !== workspace.root_ref) throw Error('Invalid funding receipt')
  await storage.save(key, { ...pending, state: 'accepted' })
  return result
}
export async function requestBuilderFunding(command, { signal } = {}) {
  const controller = new AbortController(), abort = () => controller.abort()
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 15000)
  try {
    const response = await fetch('/api/kode/builder/funding', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
    if (!response.ok) throw Error('Funding not confirmed')
    return await response.json()
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
