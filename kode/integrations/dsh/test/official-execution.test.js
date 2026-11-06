import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { acquireOperationLease } from '../src/operation-lease.js'
import { isolatedHub } from './support/isolated-hub.js'

for (const failureKind of ['throw', 'error-result']) test(`controlled execution fences tools and uncertain ${failureKind} failures`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub, execution, run
  try {
    hub = await isolatedHub('official-execution')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'execute', worker: { node_id: hub.node, session_id: 'worker' } })
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh' }])
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: { id: op.id, attempt: 1, epoch: 1 } })
    let dispatched = 0, toolCalls = 0, toolSignal
    const agent = { id: 'worker', ctx: { tools: { execute: async request => {
      toolCalls++
      toolSignal = request.signal
      if (request.arguments?.fail) {
        if (failureKind === 'throw') throw new Error('fixture uncertain side effect')
        return { isError: true, content: [{ type: 'text', text: 'fixture uncertain side effect' }] }
      }
      return 'result'
    } } } }
    let currentAgent = agent
    const ctx = { agents: { get: () => currentAgent }, get: () => ({ acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: hub.node, session_id: 'worker' }, { signal, leaseMs: 3000 }) }), llm: { async *stream() {
      dispatched++; yield { type: 'usage', usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 } }; yield { type: 'finish', reason: { kind: 'stop' } }
    } } }
    execution = new OfficialExecution(ctx, profiles, hub.client)
    run = await execution.open(agent, { tools: ['read'] })
    await assert.rejects(execution.open(agent), /already active/)
    await assert.rejects(run.execute({ agent, name: 'write' }), /not authorized/)
    await assert.rejects(run.execute({ agent: { ...agent }, name: 'read' }), /not authorized/)
    const consume = async options => { for await (const _ of run.stream(options)) {} }
    const options = { sessionId: 'worker', provider: 'fixture', model: 'model', tools: [{ name: 'read' }] }
    await assert.rejects(consume({ ...options, tools: [{ name: 'write' }] }), /unauthorized/)
    const stream = run.stream(options)
    await stream.next()
    await assert.rejects(run.finish(), /already in progress/)
    await assert.rejects(run.execute({ agent, name: 'read' }), /already in progress/)
    while (!(await stream.next()).done) {}
    assert.equal(dispatched, 1)
    assert.equal(await run.execute({ agent, name: 'read', callId: 'read-1', arguments: {} }), 'result')
    assert.equal(toolCalls, 1); assert.equal(toolSignal.aborted, false)
    assert.equal(profiles.binding('worker').officialTools['read-1'].status, 'returned')
    const getService = ctx.get
    ctx.get = name => name === 'kodeOfficialToolPolicies'
      ? { get: () => ({ validateArguments: args => args?.output === 'artifact' }) } : getService(name)
    const rejected = await run.execute({ agent, name: 'read', callId: 'invalid-args', arguments: { output: 'a narrative with spaces' } })
    assert.equal(rejected.isError, true)
    assert.equal(rejected.error.code, 'INVALID_TOOL_ARGUMENTS')
    assert.equal(toolCalls, 1)
    const rejectedEvidence = profiles.binding('worker').officialTools['invalid-args']
    assert.equal(rejectedEvidence.status, 'returned')
    assert.equal(rejectedEvidence.reason, 'arguments_rejected_before_dispatch')
    assert.equal(rejectedEvidence.home_reconciled, true)
    assert.equal(await run.execute({ agent, name: 'read', callId: 'corrected-args', arguments: { output: 'artifact' } }), 'result')
    assert.equal(toolCalls, 2)
    ctx.get = getService
    await assert.rejects(run.execute({ agent, name: 'read', callId: 'read-1' }), /already recorded/)
    assert.equal(toolCalls, 2)
    execution.artifacts.client = { call: async (path, body) => { await hub.client.call(path, body); throw new Error('lost artifact receipt') } }
    await execution.artifacts.record('worker', profiles.binding('worker').managedOperation, 'artifact-1', {
      kind: 'artifact', snapshot: { repository_id: 'fixture', base_revision: 'a'.repeat(40), tree_hash: 'b'.repeat(64), patch_hash: 'c'.repeat(64), artifact_hashes: {} },
    })
    await assert.rejects(run.finish(), /Artifact evidence requires home reconciliation/)
    assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'active')
    execution.artifacts.client = hub.client
    await execution.artifacts.tick()
    execution.artifacts.assertSettled('worker', profiles.binding('worker').managedOperation)
    await assert.rejects(run.execute({ agent, name: 'read', callId: 'read-2', arguments: { fail: true } }), failureKind === 'throw' ? /uncertain side effect/ : /requires reconciliation/)
    assert.equal(profiles.binding('worker').officialTools['read-2'].status, 'uncertain')
    await assert.rejects(run.finish(), /requires reconciliation/)
    await assert.rejects(run.execute({ agent, name: 'read', callId: 'read-3' }), /requires reconciliation/)
    assert.equal(toolCalls, 3)
    // Inject an unresolved process observation; disposing must not attest drain.
    execution.verificationRunners.unconfirmed.set('fixture-process', profiles.binding('worker').managedOperation)
    currentAgent = { ...agent }
    await assert.rejects(run.execute({ agent, name: 'read' }), /ownership changed/)
    currentAgent = agent
    await profiles.patchBinding('worker', { revision: 'changed' })
    await assert.rejects(run.execute({ agent, name: 'read' }), /ownership changed/)
    assert.equal(toolCalls, 3)
    execution.closeSession('worker')
    await assert.rejects(run.whenStopped(), /Verification process stop unconfirmed/)
    assert.equal(toolSignal.aborted, true)
    await assert.rejects(consume(options), /disposed|ended|aborted|ownership changed/)
    assert.equal(dispatched, 1)
    assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'active', 'disposing is not a completion report')
  } finally { run?.dispose(); await execution?.close(); await hub?.close() }
})
