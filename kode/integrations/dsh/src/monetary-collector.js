/** Pin home-Hub authority before polling. Never retarget a result after account rotation. */
export async function prepareMonetaryCollector(client, host, profile, collector) {
  const query = `host=${encodeURIComponent(host)}&profile=${encodeURIComponent(profile)}`
  const binding = await client.call(`/api/v1/messaging/resource-binding?${query}`)
  if (!binding.binding_current) throw new Error('Monetary collector requires a current account binding')
  return boundMonetaryCollector(binding, host, profile, collector, observation => client.call('/api/v1/messaging/monetary-quota', observation))
}

function boundMonetaryCollector(binding, host, profile, collector, publish) {
  let pending = null, running = null
  const flush = async () => {
    await publish(pending)
    pending = null
  }
  return { poll(signal) {
    if (running) return running
    running = (async () => {
      if (pending) { await flush(); return { status: 'publication_recovered' } }
      const result = await collector.poll(signal)
      if (result.status === 'backoff') return result
      pending = { host, profile, account_id: binding.account_id, account_epoch: binding.account_epoch,
        binding_revision: binding.revision, source: collector.source, observed_at_ms: result.sample?.observed_at_ms ?? result.observed_at_ms,
        status: result.status, sample: result.sample ?? null }
      await flush()
      return result
    })().finally(() => { running = null })
    return running
  } }
}

/** Remote Host authority is restricted to its assigned attempt and configured source. */
export async function prepareRemoteMonetaryCollector(client, host, profile, session, operation, collector) {
  if (!operation?.home_node) throw new Error('Remote monetary collector requires a home Hub')
  const call = action => client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, {
    operation_id: operation.id, worker_session: session, command: null, accounting: { attempt: operation.attempt, action },
  })
  const { binding, policy } = await call({ kind: 'monetary_context' })
  if (!binding?.binding_current || policy?.host !== host || policy?.profile !== profile
      || binding.host !== host || binding.profile !== profile || binding.revision !== policy.binding_revision
      || binding.account_id !== policy.account_id || binding.account_epoch !== policy.account_epoch
      || !policy.monetary?.some(requirement => requirement.source === collector.source)) {
    throw new Error('Remote monetary collector binding or source unavailable')
  }
  return boundMonetaryCollector(binding, host, profile, collector, observation => call({ kind: 'monetary_quota', observation }))
}
