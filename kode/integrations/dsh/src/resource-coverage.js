/** Owner inventory of registered Host profiles, including idle/retired bindings. No provider calls. */
import { profileRevision } from './agent-profiles.js'
import { nativeUsageCapability } from './native-session.js'
const grantCapability = official => ({ status: official ? 'conditional' : 'unsupported', reason: official ? 'requires_controlled_entry_and_trusted_tool_policies' : 'native_internal_tools_not_fully_enforced', automatic_team_admission: false })

export async function resourceCoverage(service, client, host, { after = '', limit = 25 } = {}) {
  if (typeof after !== 'string' || after.length > 1024 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid coverage page')
  const targets = new Map()
  const add = (profile, configured, binding) => {
    const revision = profileRevision(profile), key = JSON.stringify([profile.id, revision])
    let target = targets.get(key)
    if (!target) { target = { key, profile, revision, configured: false, bindings: [] }; targets.set(key, target) }
    target.configured ||= configured
    if (binding) target.bindings.push(binding)
  }
  for (const profile of service.profiles.list()) add(profile, true)
  for (const [session, binding] of Object.entries(service.profiles.bindings)) add(binding.profile, false, { ...binding, coverageSession: session })
  let officialDirectory = { status: 'unavailable', items: [] }
  try { officialDirectory = service.officialResourceDirectory?.() ?? officialDirectory } catch { /* Explicit unavailable status; no provider error detail. */ }
  for (const provider of officialDirectory.items) {
    const key = JSON.stringify(['official_loop', provider.provider_id, null])
    targets.set(key, { key, provider })
  }
  const selected = [...targets.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).filter(row => row.key > after).slice(0, limit + 1)
  const more = selected.length > limit
  selected.length = Math.min(selected.length, limit)
  const items = []
  for (const target of selected) {
    if (target.provider) {
      const provider = target.provider
      items.push({ cursor: target.key, host, resource_kind: 'official_loop_provider', provider_id: provider.provider_id,
        grant_capability: grantCapability(true), name: provider.name, route_registered: provider.registered, runtime_available: provider.registered,
        quota_source: null, quota_status: 'source_not_connected', account: null, limits: [],
        model_catalog_status: 'not_collected', models: [], usage_capability: { supported: false, reason: 'official_loop_metering_not_integrated' },
        eligible_for_dispatch: false, eligibility_reason: 'inventory_is_not_admission', budget_status: 'requires_assignment_context' })
      continue
    }
    const { profile, bindings } = target
    const usage = nativeUsageCapability(profile)
    const row = { cursor: target.key, host, resource_kind: 'execution_profile', profile_id: profile.id, profile_revision: target.revision, name: profile.name, executor_type: profile.type,
      grant_capability: grantCapability(profile.type === 'dsh'), configured: target.configured, bound_sessions: bindings.length, runtime_available: service.hasRuntime(profile.type),
      quota_source: usage.supported ? 'codex_app_server' : null, usage_capability: usage,
      quota_status: usage.supported ? 'not_connected' : 'source_unsupported', account: null, limits: [],
      remote_authorities: [...new Set(bindings.map(binding => binding.managedOperation?.home_node).filter(Boolean))].sort(),
      eligible_for_dispatch: false, eligibility_reason: 'inventory_is_not_admission', budget_status: 'requires_assignment_context' }
    if (client && host) {
      try {
        const query = `host=${encodeURIComponent(host)}&profile=${encodeURIComponent(profile.id)}`
        const [binding, quota] = await Promise.all([
          client.call(`/api/v1/messaging/resource-binding?${query}`),
          client.call(`/api/v1/messaging/quota-snapshots?${query}`),
        ])
        projectQuota(row, binding, quota, usage.supported)
      } catch { row.quota_status = 'authority_unavailable' }
      // Monetary facts have different scopes/units; never merge them into Codex windows.
      row.provider_monetary = { status: 'unavailable', sources: [] }
      try {
        const facts = await client.call(`/api/v1/messaging/monetary-quota?host=${encodeURIComponent(host)}&profile=${encodeURIComponent(profile.id)}`)
        if (facts.host === host && facts.profile === profile.id && Array.isArray(facts.sources)) {
          row.provider_monetary = { status: facts.sources.length ? 'observed' : 'not_connected', ...facts }
        }
      } catch { /* Old Hub or offline authority; do not invalidate independent window evidence. */ }
    }
    const remoteBindings = bindings.filter(binding => binding.managedOperation?.home_node)
    row.remote_attempts = []
    row.remote_attempts_truncated = remoteBindings.length > 16
    for (const entry of remoteBindings.slice(0, 16)) {
      const operation = entry.managedOperation
      const remote = { home_node: operation.home_node, operation_id: operation.id, attempt: operation.attempt,
        session_id: entry.coverageSession, quota_status: 'authority_unavailable', account: null, limits: [], eligible_for_dispatch: false }
      if (client) try {
        const context = await client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, {
          operation_id: operation.id, worker_session: entry.coverageSession, command: null,
          accounting: { attempt: operation.attempt, action: { kind: 'resource_context' } },
        })
        if (context.policy?.host !== host || context.policy?.profile !== profile.id || context.binding?.host !== host || context.binding?.profile !== profile.id) throw new Error('Resource scope mismatch')
        if (!context.quota) remote.quota_status = 'snapshot_unsupported'
        else {
          projectQuota(remote, context.binding, context.quota, usage.supported)
          remote.assignment_binding_current = context.binding.binding_current === true && context.binding.revision === context.policy.binding_revision && context.binding.account_id === context.policy.account_id && context.binding.account_epoch === context.policy.account_epoch
        }
      } catch { remote.quota_status = 'authority_unavailable' }
      row.remote_attempts.push(remote)
    }
    items.push(row)
  }
  return { monetary_collectors: service.monetaryCollectors?.list() ?? [], scope: 'host_execution_resources', official_directory_status: officialDirectory.status, host, total: targets.size, items, next_cursor: more ? items.at(-1).cursor : null,
    limitations: ['remote_details_require_registered_assignment', 'official_loop_model_and_account_coverage_incomplete', 'inventory_does_not_authorize_execution'] }
}

export function registerResourceCoverage(ctx, service, client, host) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/resource-coverage', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    try {
      const query = new URL(req.url, 'http://localhost').searchParams
      return send(200, await resourceCoverage(service, client, host, { after: query.get('after') ?? '', limit: query.has('limit') ? Number(query.get('limit')) : 25 }))
    } catch { return send(400, { error: 'Resource coverage query failed' }) }
  } })
}

function projectQuota(row, binding, quota, supported) {
  row.account = binding.account_id ? { id: binding.account_id, epoch: binding.account_epoch, binding_revision: binding.revision, current: binding.binding_current === true } : null
  row.limits = (quota.buckets ?? []).map(bucket => ({ limit_id: bucket.limit_id, observed_at_ms: bucket.observed_at_ms,
    windows: bucket.windows.map(({ window, freshness }) => ({ window_id: window.window_id, used_percent: window.used_percent, resets_at_ms: window.resets_at_ms, window_minutes: window.window_minutes, freshness })) }))
  const snapshotMismatch = quota.binding_revision !== undefined && (quota.binding_revision !== binding.revision || quota.account_id !== binding.account_id || quota.account_epoch !== binding.account_epoch)
  if (snapshotMismatch) row.limits = []
  row.exhausted = !snapshotMismatch && (quota.exhaustion_evidence?.windows?.length ?? 0) > 0
  row.truncated = quota.truncated === true || quota.exhaustion_evidence?.truncated === true
  const freshness = row.limits.flatMap(bucket => bucket.windows.map(window => window.freshness))
  row.quota_status = !row.account ? 'account_unbound' : !row.account.current || snapshotMismatch || quota.status === 'binding_changed' ? 'binding_unavailable'
    : row.exhausted ? 'exhausted' : !supported ? 'source_unsupported'
    : row.truncated ? 'partial' : !freshness.length ? 'not_connected'
    : freshness.every(state => state === 'reported') ? 'reported'
    : freshness.includes('stale') ? 'stale' : freshness.includes('reset_passed') ? 'reset_passed' : 'partial'
}
