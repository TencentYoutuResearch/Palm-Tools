import { SelectionOutbox } from '../src/selection-outbox.js'
/** Actual Hub lease + ACP fixture process. No provider inference. */
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
const fixture = fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))
for (const [field, missing] of [['model', false], ['effort', false], ['effort', true]]) test(`ACP ${field} ${missing ? 'missing confirmation' : 'mismatch'} is durable and cannot complete its operation or prompt`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, adapter
  try {
    hub = await isolatedHub(`selection-${field}`)
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'selection', worker: { node_id: hub.node, session_id: 'worker' } })
    const operation = { id: op.id, attempt: 1, epoch: 1 }
    const log = join(hub.root, 'wire.jsonl'), file = join(hub.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'fixture', name: 'Fixture', type: 'custom', executable: process.execPath, args: [fixture], env: { KODE_ACP_FIXTURE_LOG: log, ...(missing ? { KODE_ACP_FIXTURE_OMIT_CONFIRMATION: field } : { KODE_ACP_FIXTURE_MISMATCH: field }) } }])
    await profiles.bind('worker', 'fixture'); await profiles.patchBinding('worker', { managedOperation: operation })
    const agent = { id: 'worker', session: { header: { cwd: hub.root }, append() {} }, ctx: { parallel: async () => {}, get: () => undefined, tools: { execute: async () => { throw new Error('No tools may run') } } } }
    const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: hub.node, session_id: 'worker' }, { signal }) } : undefined }
    const recorded = []
    adapter = new AgentRuntimeAdapter(ctx, profiles, { selectionOutbox: new SelectionOutbox(hub.client, profiles), recordNative: (_session, event) => recorded.push(structuredClone(event)) })
    let started = false
    const request = { sessionId: 'worker', provider: profileRoute('fixture'), model: 'fixture-large', reasoningEffort: 'high', tools: [], signal: AbortSignal.timeout(10000), onNativeTurnReady: () => { started = true }, messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'Must never reach inference' }] }] }
    await assert.rejects(async () => { for await (const _ of adapter.stream(request)) {} }, /rejected.*model\/effort/)
    assert.equal(started, false)
    const rows = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(!rows.some(row => row.method === 'session/prompt'))
    const restored = await new AgentProfiles(file).open()
    const evidence = executionEvidence(restored.binding('worker')).selection
    assert.equal(evidence.admission, 'rejected'); assert.equal(evidence[field].status, missing ? 'unverifiable' : 'mismatch')
    assert.equal(evidence[field].requested, field === 'model' ? 'fixture-large' : 'high')
    assert.equal(evidence[field].observed, missing ? null : field === 'model' ? 'fixture-fast' : 'medium')
    assert.deepEqual(recorded.find(row => row.event?.method === 'kode/selection_evidence').event.params, evidence)
    assert.deepEqual(evidence.operation, operation); assert.deepEqual(evidence.inputIds, ['input'])
    assert.equal(evidence.profile_revision, restored.binding('worker').revision)
    assert.equal(restored.binding('worker').operationClosed, true)
    const audit = await hub.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    assert.equal(audit.events.filter(row => row.data.kind === 'selection_evidence' && row.data.rejected).length, 1)
    assert.equal(Object.values(restored.binding('worker').selectionOutbox)[0].home_reconciled, true)
    assert.notEqual((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'reported')
    await adapter.close()
    adapter = new AgentRuntimeAdapter(ctx, restored, { recordNative() {} })
    await assert.rejects(async () => { for await (const _ of adapter.stream(request)) {} }, /closed|replay|completed|fenced/i)
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, rows.length, 'restart must not submit another prompt or initialize another executor')
  } finally { await adapter?.close(); await hub?.close() }
})
