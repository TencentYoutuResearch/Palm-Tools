export const workflowSetupKey = draft => JSON.stringify(['builder-workflow', draft.home_hub, draft.id])
export function verifyWorkflowRegistration(result, pending) {
  const command = pending.command, proposal = pending.proposal
  if (!result || result.draft_id !== command.draft_id || result.draft_revision !== command.expected_revision || result.request_id !== command.request_id || result.state !== 'registered' || result.activation_performed !== false || result.eligible_for_execution !== false
    || [['workflow', 'workflow'], ['project', 'project'], ['delivery_policy', 'delivery']].some(([key, source]) => result[key]?.id !== proposal[source].id || result[key].version !== proposal[source].version || !/^[a-f0-9]{64}$/.test(result[key].hash))) throw Error('Invalid workflow registration receipt')
  return result
}
export function verifyWorkflowScope(pending, draft) {
  if (!pending || !['prepared', 'registered'].includes(pending.state) || pending.home_hub !== draft.home_hub || pending.command?.draft_id !== draft.id
    || !Number.isSafeInteger(pending.command.expected_revision) || pending.command.expected_revision < 1 || pending.command.expected_revision > draft.revision
    || typeof pending.request_id !== 'string' || !pending.request_id || !pending.proposal) throw Error('Wrong workflow scope')
  if (pending.state === 'registered') verifyWorkflowRegistration(pending.receipt, { ...pending, command: { ...pending.command, request_id: pending.request_id } })
  return pending
}
export function hasUpdatedWorkflow(draft, pending) {
  return pending?.state === 'registered' && draft.revision > pending.command.expected_revision && draft.interview.proposed_workflow
    && JSON.stringify(draft.interview.proposed_workflow) !== JSON.stringify(pending.proposal)
}
export async function readWorkflowCommand(storage, draft) {
  let pending = await storage.read(workflowSetupKey(draft))
  // Preserve current-revision commands written by the earlier development UI.
  if (!pending) {
    const legacy = await storage.read(JSON.stringify(['builder-workflow', draft.home_hub, draft.id, draft.revision]))
    if (legacy) pending = await storage.reserve(workflowSetupKey(draft), verifyWorkflowScope(legacy, draft))
  }
  return pending ? verifyWorkflowScope(pending, draft) : null
}
export async function confirmWorkflowRegistration({ draft, storage, request, signal, replaceRegistered = false, uuid = () => crypto.randomUUID() }) {
  const key = workflowSetupKey(draft)
  const pending = await storage.reserve(key, { state: 'prepared', home_hub: draft.home_hub, request_id: uuid(), proposal: draft.interview.proposed_workflow, command: { draft_id: draft.id, expected_revision: draft.revision } }, current => {
    verifyWorkflowScope(current, draft)
    return replaceRegistered && hasUpdatedWorkflow(draft, current)
  })
  if (signal?.aborted) throw Error('Disposed')
  verifyWorkflowScope(pending, draft)
  const command = { ...pending.command, request_id: pending.request_id }
  const result = pending.state === 'registered' ? pending.receipt : await request(command, { signal })
  verifyWorkflowRegistration(result, { ...pending, command })
  if (pending.state !== 'registered') await storage.save(key, { ...pending, state: 'registered', receipt: result })
  return result
}
export async function requestWorkflowRegistration(command, { signal } = {}) {
  const response = await fetch('/api/kode/builder/configure-workflow', { method: 'POST', credentials: 'same-origin', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) })
  if (!response.ok) throw Error('Workflow registration not confirmed')
  return response.json()
}
