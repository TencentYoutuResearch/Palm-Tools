import { quotaSample } from './quota-collector.js'
/** Trusted Host only. Caller persists account-change fences before publishing/recreating. */
export async function prepareRemoteQuotaCollector(client, host, profile, session, operation, fenceRevision = 0, currentFence = () => fenceRevision) {
  if (!client || !operation?.home_node) return { publish: async () => ({ status: 'not_connected' }) }
  const call = action => client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, {
    operation_id: operation.id, worker_session: session, command: null, accounting: { attempt: operation.attempt, action },
  })
  let context
  try { context = await call({ kind: 'resource_context' }) }
  catch { return { publish: async () => ({ status: 'authority_unavailable' }) } }
  const { binding, policy } = context
  if (!binding?.binding_current || policy?.host !== host || policy?.profile !== profile ||
      binding.host !== host || binding.profile !== profile || binding.revision !== policy.binding_revision ||
      binding.account_id !== policy.account_id || binding.account_epoch !== policy.account_epoch ||
      binding.revision <= fenceRevision) return { publish: async () => ({ status: 'binding_unavailable' }) }
  let invalidated = false
  return { bindingRevision: binding.revision, home_node: operation.home_node, publish: async observation => {
    if (observation.account_changed) {
      invalidated = true
      await call({ kind: 'invalidate_quota' })
      return { status: 'binding_invalidated' }
    }
    if (invalidated || currentFence() >= binding.revision) return { status: 'binding_invalidated' }
    await call({ kind: 'quota', sample: quotaSample(binding, host, profile, observation) })
    return { status: 'published', account_id: binding.account_id, account_epoch: binding.account_epoch, binding_revision: binding.revision }
  } }
}
