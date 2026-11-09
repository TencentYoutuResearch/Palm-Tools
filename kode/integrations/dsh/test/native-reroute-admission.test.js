import { SelectionOutbox } from '../src/selection-outbox.js'
/** Actual Hub lease + Codex fixture process. No provider inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { acquireOperationLease } from '../src/operation-lease.js'
import { executionEvidence } from '../src/execution-evidence.js'
const fixture = fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))
test('current Codex reroute is persisted at home and cannot report success', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, adapter
  try {
    hub = await isolatedHub('selection-reroute')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'selection', worker: { node_id: hub.node, session_id: 'worker' } })
    const operation = { id: op.id, attempt: 1, epoch: 1 }
    const log = join(hub.root, 'wire.jsonl'), file = join(hub.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_RPC_LOG: log, KODE_FIXTURE_SELECTION_REROUTE: '1' } }])
    await profiles.bind('worker', 'fixture'); await profiles.patchBinding('worker', { managedOperation: operation })
    const agent = { id: 'worker', session: { header: { cwd: hub.root }, append() {} }, ctx: { parallel: async () => {}, get: () => undefined, tools: { execute: async () => { throw new Error('No tools may run') } } } }
    const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: hub.node, session_id: 'worker' }, { signal }) } : undefined }
    const recorded = []
    adapter = new AgentRuntimeAdapter(ctx, profiles, { selectionOutbox: new SelectionOutbox(hub.client, profiles), recordNative: (_session, event) => recorded.push(structuredClone(event)) })
    let started = false
    const request = { sessionId: 'worker', provider: profileRoute('fixture'), model: 'fixture', reasoningEffort: 'high', tools: [], signal: AbortSignal.timeout(10000), onNativeTurnReady: () => { started = true }, messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'CURRENT_REROUTE' }] }] }
    await assert.rejects(async () => { for await (const _ of adapter.stream(request)) {} }, /rejected.*model\/effort/)
    // Rerouting is reported after turn/start; no pre-inference guarantee.
    assert.equal(started, true)
    const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.filter(row => row.method === 'turn/start').length, 1)
    const restored = await new AgentProfiles(file).open()
    const evidence = executionEvidence(restored.binding('worker')).selection
    assert.equal(evidence.admission, 'rejected'); assert.equal(evidence.model.status, 'mismatch')
    assert.equal(evidence.model.requested, 'fixture'); assert.equal(evidence.model.observed, 'other')
    assert.deepEqual(recorded.filter(row => row.event?.method === 'kode/selection_evidence').at(-1).event.params, evidence)
    assert.deepEqual(evidence.operation, operation); assert.deepEqual(evidence.inputIds, ['input'])
    assert.equal(evidence.profile_revision, restored.binding('worker').revision)
    assert.equal(restored.binding('worker').operationClosed, true)
    const audit = await hub.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    assert.equal(audit.events.filter(row => row.data.kind === 'selection_evidence' && row.data.rejected).length, 1)
    assert.ok(Object.values(restored.binding('worker').selectionOutbox).every(row => row.home_reconciled))
    assert.notEqual((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'reported')
    await adapter.close()
    adapter = new AgentRuntimeAdapter(ctx, restored, { recordNative() {} })
    await assert.rejects(async () => { for await (const _ of adapter.stream(request)) {} }, /closed|replay|completed|fenced/i)
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, rows.length, 'restart must not submit another prompt or initialize another executor')
  } finally { await adapter?.close(); await hub?.close() }
})
