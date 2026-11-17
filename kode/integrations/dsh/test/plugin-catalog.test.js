import test from 'node:test'
import assert from 'node:assert/strict'
import { projectPluginCatalog } from '../src/plugin-catalog.js'
const entry = (moduleName, id = moduleName) => ({ entryId: id, moduleName, enabled: true, fiberPhase: 'active' })
const fixture = () => ({ inventory: { entries: [entry('@kode/dsh'), entry('@kode/dsh-collab'), entry('@deepseek-ai/dsh-mcp-resources')] },
 agentHub: { sources: [{ id: 'probe', targets: ['dsh', 'codex', 'claude', 'codebuddy', 'cursor'], skills: ['probe'], links: [{}], nativeStatus: { codex: 'installed', claude: 'ready' }, nativeEvidence: { codex: { basis: 'installer_completed', runtime_verified: true } } }] },
 externalStatus: { state: 'disabled', authorized_connections: 0, provider_health: 'not_checked' } })
test('runtime Kode bundle, synchronization and unconnected capabilities remain distinct facts', () => {
 const input = fixture(), before = structuredClone(input), result = projectPluginCatalog(input)
 assert.deepEqual(input, before)
 assert.equal(result.kode.present, true); assert.equal(result.kode.module_count, 2); assert.equal(result.kode.runtime_phase, 'active')
 assert.equal(result.other_runtime_plugins.length, 1); assert.equal(result.synchronized_sources[0].targets[1].native_status, 'installed')
 assert.equal(result.synchronized_sources[0].targets[1].runtime_verification, 'not_verified')
 for (const row of result.external_capabilities) { assert.equal(row.connection_state, 'not_connected'); assert.equal(row.standalone_plugin_installed, false) }
 assert.equal(result.read_only, true); assert.equal(result.eligible_for_execution, false)
})
test('missing authorities and aggregate connections never fabricate per-provider connection success', () => {
 assert.equal(projectPluginCatalog().connections.state, 'unknown')
 const input = fixture(); input.externalStatus = { state: 'ready', authorized_connections: 2 }
 for (const row of projectPluginCatalog(input).external_capabilities) assert.equal(row.connection_state, 'not_projected')
 input.inventory.entries.shift(); const result = projectPluginCatalog(input)
 assert.equal(result.kode.present, false); assert.equal(result.kode.enabled, null)
})
test('projection strips configuration, locations, raw diagnostics, credentials and source instruction bodies', () => {
 const input = fixture(); input.inventory.entries[0].config = { secret: 'PRIVATE' }; input.inventory.entries[0].meta = { description: 'PRIVATE' }
 Object.assign(input.agentHub.sources[0], { location: 'PRIVATE', error: 'PRIVATE', links: [{ path: 'PRIVATE', to: 'PRIVATE' }], plugins: { codex: [{ path: 'PRIVATE' }] }, nativeStatus: { codex: 'failed: PRIVATE' } })
 input.externalStatus.reason = 'PRIVATE'
 const result = projectPluginCatalog(input)
 assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.equal(result.synchronized_sources[0].sync_state, 'failed')
})
test('malformed identities, states, duplicates and oversized lists fail closed', () => {
 for (const change of [x => x.inventory.entries.push(x.inventory.entries[0]), x => x.inventory.entries[0].fiberPhase = 'connected', x => x.inventory.entries[0].enabled = 'true', x => x.agentHub.sources.push(x.agentHub.sources[0]), x => x.agentHub.sources[0].targets.push('foreign'), x => x.externalStatus.authorized_connections = -1, x => x.inventory.entries = Array(5001).fill(entry('x'))]) {
  const input = fixture(); change(input); assert.throws(() => projectPluginCatalog(input))
 }
})
