/** Actual prepared LlmRuntime registration plus actual Hub ownership/accounting. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const consume = async stream => { for await (const _ of stream) {} }

test('controlled prepared calls retain the actual adapter registration and fence reuse and disposal', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('official-prepared'), ctx = new Context()
  let execution, run
  try {
    await ctx.plugin(LlmRuntime)
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'prepared', worker: { node_id: hub.node, session_id: 'worker' } })
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh' }])
    await profiles.bind('worker', 'official')
    await profiles.patchBinding('worker', { managedOperation: { id: op.id, attempt: 1, epoch: 1 } })
    const agent = { id: 'worker', ctx }
    ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
    ctx.provide('kodeOperationLeases', { acquire: (_agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: hub.node, session_id: agent.id }, { signal, leaseMs: 10000 }) })
    const calls = []
    class Fixture extends LlmAdapter {
      constructor(label) { super(); this.label = label }
      async *stream(options) {
        calls.push(this.label)
        assert.equal(options.signal.aborted, false)
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    const unregister = ctx.llm.registerAdapter(['fixture'], new Fixture('original'))
    execution = new OfficialExecution(ctx, profiles, hub.client)
    run = await execution.open(agent)
    const config = { provider: 'fixture', model: 'model' }
    const prepared = await run.prepareCall(config)
    assert.equal(prepared.config.model, 'model')
    assert.equal(Object.isFrozen(prepared), true)
    unregister()
    ctx.llm.registerAdapter(['fixture'], new Fixture('replacement'))
    const options = { ...prepared.config, sessionId: agent.id, tools: [], messages: [] }
    await consume(prepared.stream(options))
    assert.deepEqual(calls, ['original'])
    await assert.rejects(consume(prepared.stream(options)), /already dispatched/)
    await assert.rejects(consume(ctx.llm.stream(options)), /controlled execution/)
    const next = await run.prepareCall(config)
    await consume(next.stream({ ...options, ...next.config }))
    assert.deepEqual(calls, ['original', 'replacement'])
    const cancelled = new AbortController()
    const cancelledCall = await run.prepareCall(config, cancelled.signal)
    cancelled.abort(new Error('preparation cancelled'))
    await assert.rejects(consume(cancelledCall.stream(options)), /preparation cancelled/)
    const records = Object.values(profiles.binding(agent.id).officialCalls)
    assert.equal(records.length, 2, 'denied dispatches never create a billable call')
    for (const record of records) {
      assert.equal(record.done, true)
      assert.equal(record.acknowledged, record.events.length)
      const receipt = await hub.client.call(`/api/v1/messaging/official-calls/${record.request.call_id}`)
      assert.equal(receipt.request.operation_id, op.id)
      assert.equal(receipt.sequence, record.acknowledged)
    }
    const pending = await run.prepareCall(config)
    run.dispose()
    await assert.rejects(consume(pending.stream(options)), /ended|abort/i)
    await assert.rejects(run.prepareCall(config), /ended|abort/i)
    assert.deepEqual(calls, ['original', 'replacement'])
  } finally { run?.dispose(); await execution?.close(); await ctx.fiber.dispose(); await hub.close() }
})
