/** Two real loopback Hubs plus spawned native protocol fixture, no paid inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const enabled = Boolean(process.env.KODE_TEST_BACKEND_URL)

for (const failure of ['cancel', 'pause', 'crash']) test(`remote native runtime stops after home Hub ${failure} and never replays its turn`, { skip: !enabled, timeout: 30000 }, async () => {
  let home, remote, adapter
  try {
    home = await isolatedHub('fixture-home')
    remote = await isolatedHub('fixture-worker')
    await pairHubs(home, remote)
    const id = 'worker'
    const registered = await remote.client.call('/api/v1/messaging/sessions', { session_id: id, title: 'Remote lease fixture', runtime: 'external' })
    const workerClient = remote.client.forSession(registered.owner_token)
    const operation = await home.client.call('/api/v1/messaging/operations', { owner_session: 'fixture-owner', request_key: 'remote-execution', worker: { node_id: remote.node, session_id: id } })
    const profiles = await new AgentProfiles(join(remote.root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))] }])
    await profiles.bind(id, 'fixture')
    const binding = { id: operation.id, attempt: operation.attempt, epoch: operation.epoch, home_node: home.node }
    await profiles.patchBinding(id, { managedOperation: binding, operationClosed: false })
    const events = []
    const agent = { id, session: { header: { cwd: remote.root }, append() {} }, ctx: { parallel: async () => {}, get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only', workspaceRoot: remote.root }) } : undefined, tools: { execute: async () => { throw new Error('unexpected tool') } } } }
    const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: (_agent, binding, signal) => acquireOperationLease(workerClient, binding, { node_id: remote.node, session_id: id }, { signal, leaseMs: 5000 }) } : undefined }
    adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: (_, event) => events.push(event) })
    let fault, readyAt, stoppedAt
    const options = { sessionId: id, provider: profileRoute('fixture'), model: 'fixture', signal: AbortSignal.timeout(20000), messages: [{ id: 'remote-input', role: 'user', content: [{ type: 'text', text: 'WAIT' }] }], onNativeTurnReady: () => {
      if (fault) return
      readyAt = performance.now()
      fault = (async () => {
        if (failure === 'pause') home.pause()
        else if (failure === 'crash') await home.stop('SIGKILL')
        else {
          const current = await home.client.call(`/api/v1/messaging/operations/${operation.id}`)
          await home.client.call(`/api/v1/messaging/operations/${operation.id}`, { attempt: current.attempt, epoch: current.epoch, expected_revision: current.revision, action: { kind: 'cancel' } })
        }
      })()
      fault.catch(() => {})
    } }
    await assert.rejects(async () => { for await (const _ of adapter.stream(options)) {} }, /lease|Operation|home Hub|operation/i)
    stoppedAt = performance.now()
    assert.ok(fault, 'the native turn actually started before fault injection')
    await fault
    assert.ok(stoppedAt - readyAt < 10000, 'bounded local expiry/cleanup must beat caller timeout')
    assert.equal(profiles.binding(id).operationClosed, true)
    assert.equal(profiles.binding(id).lastOutcome, 'uncertain')
    assert.ok(events.some(e => e.event.method === 'kode/process_stop' && e.event.params.leader_exited))
    await assert.rejects(async () => { for await (const _ of adapter.stream({ ...options, onNativeTurnReady: undefined })) {} }, /fenced/)
    if (failure === 'pause') home.resume()
    if (failure === 'crash') await home.start()
    let current = await home.client.call(`/api/v1/messaging/operations/${operation.id}`)
    // The worker's conservative deadline starts before the remote claim arrives.
    // Home may retain its later lease briefly; this does not authorize a restart.
    const convergeBy = performance.now() + 2500
    while (failure !== 'cancel' && current.state === 'active' && performance.now() < convergeBy) {
      await new Promise(resolve => setTimeout(resolve, 100))
      current = await home.client.call(`/api/v1/messaging/operations/${operation.id}`)
    }
    assert.equal(current.state, failure === 'cancel' ? 'cancelling' : 'uncertain')
    if (failure !== 'cancel') assert.ok(current.epoch > operation.epoch)
    await assert.rejects(remote.client.call(`/api/v1/messaging/operations/${operation.id}`), error => error.status === 404)
  } finally { await adapter?.close(); await home?.close(); await remote?.close() }
})
