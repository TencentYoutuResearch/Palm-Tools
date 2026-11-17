/** Read-only display projection over existing authorities. Never installs, enables or connects. */
const phases = new Set(['failed', 'pending', 'active', 'loading', 'unloading'])
const targets = new Set(['dsh', 'codex', 'claude', 'codebuddy', 'cursor'])
const bases = new Set(['skills_links_only', 'launch_argument_configured', 'installer_pending', 'installer_completed'])
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
function array(value, limit, label) {
  if (!Array.isArray(value) || value.length > limit) throw Error(`Invalid ${label}`)
  return value
}
function unique(rows, key, label) {
  if (new Set(rows.map(row => row[key])).size !== rows.length) throw Error(`Duplicate ${label}`)
  return rows
}
function inventoryRows(inventory) {
  return unique(array(inventory.entries, 5000, 'plugin inventory').map(row => {
    if (!row || !text(row.entryId, 1024) || !text(row.moduleName, 1024) || typeof row.enabled !== 'boolean'
      || row.fiberPhase !== null && !phases.has(row.fiberPhase)) throw Error('Invalid plugin entry')
    return { entry_id: row.entryId, module_name: row.moduleName, enabled: row.enabled, runtime_phase: row.fiberPhase }
  }), 'entry_id', 'plugin entry')
}
function sourceRows(hub) {
  return unique(array(hub.sources, 1000, 'sync sources').map(source => {
    if (!source || !text(source.id, 64) || !/^[a-z0-9][a-z0-9_-]*$/.test(source.id)) throw Error('Invalid sync source')
    const selected = array(source.targets, 5, 'sync targets')
    if (new Set(selected).size !== selected.length || selected.some(target => !targets.has(target))) throw Error('Invalid sync targets')
    const skills = array(source.skills ?? [], 5000, 'source skills')
    if (skills.some(name => !text(name, 1024))) throw Error('Invalid source skill')
    const links = array(source.links ?? [], 25000, 'source links')
    return { source_id: source.id, kind: 'synchronized_source', skill_count: skills.length, link_count: links.length,
      sync_state: source.error ? 'failed' : links.length ? 'links_recorded' : 'not_synced',
      updated_at_ms: Number.isSafeInteger(source.updatedAt) && source.updatedAt >= 0 ? source.updatedAt : null,
      targets: selected.map(target => {
        const status = source.nativeStatus?.[target]
        const basis = source.nativeEvidence?.[target]?.basis
        return { target, native_status: ['ready', 'skills-only', 'installed'].includes(status) ? status : typeof status === 'string' && status.startsWith('failed:') ? 'failed' : 'unknown',
          evidence_basis: bases.has(basis) ? basis : 'not_reported', runtime_verification: 'not_verified' }
      }) }
  }), 'source_id', 'sync source')
}
export function projectPluginCatalog({ inventory = null, agentHub = null, externalStatus = null } = {}) {
  const rows = inventory === null ? [] : inventoryRows(inventory)
  const kode = rows.filter(row => row.module_name.startsWith('@kode/'))
  const root = kode.find(row => row.module_name === '@kode/dsh')
  const externalKnown = externalStatus !== null
  if (externalKnown && (!['disabled', 'ready'].includes(externalStatus.state)
    || !Number.isSafeInteger(externalStatus.authorized_connections) || externalStatus.authorized_connections < 0)) throw Error('Invalid external connection status')
  const count = externalKnown ? externalStatus.authorized_connections : null
  return { version: 1, read_only: true, eligible_for_execution: false,
    authorities: { runtime: inventory === null ? 'unavailable' : 'dsh_plugin_inventory',
      synchronization: agentHub === null ? 'unavailable' : 'agent_hub_sources',
      connections: externalKnown ? 'external_resource_registry' : 'unavailable' },
    kode: { id: 'kode', name: 'Kode', kind: 'host_plugin_bundle', present: root !== undefined,
      enabled: root?.enabled ?? null, runtime_phase: root?.runtime_phase ?? null,
      module_count: kode.length, modules: kode },
    other_runtime_plugins: rows.filter(row => !row.module_name.startsWith('@kode/')),
    synchronized_sources: agentHub === null ? [] : sourceRows(agentHub),
    external_capabilities: ['tapd', 'gongfeng'].map(provider => ({ provider, owner: 'kode', kind: 'connection_capability',
      standalone_plugin_installed: rows.some(row => row.module_name === `@kode/${provider}`),
      connection_state: count === null ? 'unknown' : count === 0 ? 'not_connected' : 'not_projected',
      connectivity: 'not_verified', dispatch: 'disabled' })),
    connections: { state: externalKnown ? externalStatus.state : 'unknown', authorized_connections: count,
      provider_health: externalStatus?.provider_health === 'not_checked' ? 'not_checked' : 'not_projected' },
    limitations: ['runtime_inventory_is_not_installation_history', 'source_links_do_not_prove_agent_loading',
      'aggregate_connection_counts_do_not_identify_providers', 'visibility_does_not_authorize_execution'] }
}
