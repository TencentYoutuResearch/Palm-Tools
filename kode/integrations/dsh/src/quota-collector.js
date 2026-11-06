/** Trusted Host transport. Pin authority before executor startup; never rebind on a sample. */
export async function prepareQuotaCollector(client, host, profile, fenceRevision = 0, currentFence = () => fenceRevision) {
  if (!client || !host) return { publish: async () => ({ status: 'not_connected' }) }
  let binding
  try { binding = await client.call(`/api/v1/messaging/resource-binding?host=${encodeURIComponent(host)}&profile=${encodeURIComponent(profile)}`) }
  catch { return { publish: async () => ({ status: 'authority_unavailable' }) } }
  if (!binding.binding_current || binding.revision <= fenceRevision) return { publish: async () => ({ status: 'binding_unavailable' }) }
  let invalidated = false
  return { bindingRevision: binding.revision, publish: async observation => {
    if (observation.account_changed) {
      invalidated = true
      await client.call('/api/v1/messaging/resource-binding/invalidate', { host, profile, expected_revision: binding.revision })
      return { status: 'binding_invalidated' }
    }
    if (invalidated || currentFence() >= binding.revision) return { status: 'binding_invalidated' }
    const sample = quotaSample(binding, host, profile, observation)
    await client.call('/api/v1/messaging/quota-snapshots', sample)
    return { status: 'published', account_id: binding.account_id, account_epoch: binding.account_epoch, binding_revision: binding.revision }
  } }
}

/** Allowlisted provider observation DTO; excludes profile/env and raw provider payloads. */
export function quotaSample(binding, host, profile, observation) {
  return { host, profile, account_id: binding.account_id, account_epoch: binding.account_epoch, binding_revision: binding.revision,
      observed_at_ms: observation.observed_at_ms, truncated: observation.truncated === true,
      buckets: observation.buckets.map(bucket => ({ limit_id: bucket.limit_id, observed_at_ms: bucket.observed_at_ms, valid_until_ms: bucket.valid_until_ms,
        windows: bucket.windows.map(window => ({ window_id: window.window_id, used_percent: window.used_percent, resets_at_ms: window.resets_at_ms, window_minutes: window.window_minutes })) })) }
}
