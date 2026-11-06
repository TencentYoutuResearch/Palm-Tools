/** Real ACP process + real lease and home evidence; no inference provider. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { SelectionOutbox } from '../src/selection-outbox.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const fixture = fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))
for (const mode of ['success', 'lost', 'wrong-request', 'unsupported-scope', 'remote-success', 'remote-unsupported']) test(`managed ACP selection policy: ${mode}`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const lost = mode === 'lost', early = ['wrong-request', 'unsupported-scope', 'remote-unsupported'].includes(mode)
  let hub, remote, adapter, outbox
  try {
    hub = await isolatedHub('selection-success')
    if (mode.startsWith('remote-')) { remote = await isolatedHub('selection-executor'); await pairHubs(hub, remote) }
    const execution = remote ?? hub
    const registration = await execution.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = execution.client.forSession(registration.owner_token)
    const log = join(execution.root, 'wire.jsonl'), file = join(execution.root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'fixture', name: 'Fixture', type: 'custom', executable: process.execPath, args: [fixture], env: { KODE_ACP_FIXTURE_LOG: log } }])
    await profiles.bind('worker', 'fixture')
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'selection', selection_policy: { profile_revision: profiles.binding('worker').revision, model: 'fixture-large', effort: 'high', scope: ['unsupported-scope', 'remote-unsupported'].includes(mode) ? 'inference' : 'executor_configuration' }, worker: { node_id: execution.node, session_id: 'worker' } })
    if (remote) await assert.rejects(worker.call(`/api/v1/messaging/operation-relay/${hub.node}`, { operation_id: op.id, worker_session: 'worker', command: { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } } }), /policy acknowledgement required/)
    const operation = { id: op.id, attempt: 1, epoch: 1, ...(remote ? { home_node: hub.node } : {}) }
    await profiles.patchBinding('worker', { managedOperation: operation })
    const agent = { id: 'worker', session: { header: { cwd: execution.root }, append() {} }, ctx: { parallel: async () => {}, get: () => undefined, tools: { execute: async () => { throw new Error('No tools') } } } }
    const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal, admission = {}) => acquireOperationLease(worker, binding, { node_id: execution.node, session_id: 'worker' }, { signal, beforeClaim: admission.beforeClaim }) } : undefined }
    outbox = new SelectionOutbox(lost ? { call: async (...args) => { await hub.client.call(...args); throw new Error('lost receipt') } } : execution.client, profiles)
    adapter = new AgentRuntimeAdapter(ctx, profiles, { selectionOutbox: outbox, recordNative() {} })
    const run = async () => { for await (const _ of adapter.stream({ sessionId: 'worker', provider: profileRoute('fixture'), model: mode === 'wrong-request' ? 'fixture-fast' : 'fixture-large', reasoningEffort: 'high', tools: [], signal: AbortSignal.timeout(10000), messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'Fixture success' }] }] })) {} }
    if (early) await assert.rejects(run(), /selection policy|home policy/)
    else if (lost) await assert.rejects(run(), /reconciliation/)
    else await run()
    const wire = await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT' && early) return ''; throw error })
    const rows = wire.trim() ? wire.trim().split('\n').map(JSON.parse) : []
    if (early) { assert.equal(rows.length, 0); assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'prepared'); assert.equal(profiles.binding('worker').selectionAdmission.status, 'rejected'); return }
    assert.equal(rows.filter(row => row.method === 'session/prompt').length, lost ? 0 : 1)
    const home = await hub.client.call(`/api/v1/messaging/operations/${op.id}`)
    if (lost) assert.notEqual(home.state, 'reported')
    else assert.equal(home.state, 'reported')
    const audit = await hub.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    const selection = audit.events.filter(row => row.data.kind === 'selection_evidence')
    assert.equal(selection.length, 1); assert.equal(selection[0].data.rejected, false)
    assert.equal(selection[0].data.evidence.model.observed, 'fixture-large')
    assert.equal(selection[0].data.evidence.effort.observed, 'high')
    if (!lost) assert.ok(selection[0].seq < audit.events.find(row => row.data.kind === 'report').seq)
    else {
      await adapter.close(); await outbox.close()
      const restored = await new AgentProfiles(file).open()
      outbox = new SelectionOutbox(hub.client, restored); await outbox.tick(); outbox.assertSettled('worker', operation)
      assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, rows.length)
      assert.notEqual((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'reported')
    }
  } finally { await adapter?.close(); await outbox?.close(); await remote?.close(); await hub?.close() }
})
