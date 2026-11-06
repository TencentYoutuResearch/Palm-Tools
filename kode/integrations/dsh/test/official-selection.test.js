/** Actual LlmRuntime preparation + home selection-policy gate, without provider inference. */
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
for (const mode of ['match', 'wrong-model', 'inference', 'lost-receipt', 'unsupported-effort', 'missing-provider', 'disallowed-model', 'profile-during-lookup', 'profile-after-claim']) test(`official prepared selection enforces home policy: ${mode}`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('official-selection'), ctx = new Context()
  let execution, run
  try {
    await ctx.plugin(LlmRuntime)
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh', ...(mode === 'disallowed-model' ? { allowedModels: ['other'] } : {}) }])
    await profiles.bind('worker', 'official')
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const selection_policy = { profile_revision: profiles.binding('worker').revision, model: 'model', effort: 'high', scope: mode === 'inference' ? 'inference' : 'executor_configuration' }
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'selected', worker: { node_id: hub.node, session_id: 'worker' }, selection_policy })
    await profiles.patchBinding('worker', { managedOperation: { id: op.id, attempt: 1, epoch: 1 } })
    const agent = { id: 'worker', ctx, options: { provider: mode === 'missing-provider' ? 'absent' : 'fixture', model: mode === 'wrong-model' ? 'other' : 'model', reasoningEffort: 'high' } }
    ctx.provide('agents', { get: () => agent })
    ctx.provide('kodeOperationLeases', { acquire: (_agent, binding, signal, admission) => acquireOperationLease(worker, binding,
      { node_id: hub.node, session_id: agent.id }, { signal, leaseMs: 10000, beforeClaim: admission.beforeClaim }) })
    let calls = 0, drop = mode === 'lost-receipt'
    class Fixture extends LlmAdapter {
      async resolveModel(provider, model) {
        if (mode === 'profile-during-lookup') await profiles.update(state => { state.profiles[0].name = 'Changed configuration' })
        return { provider, id: model, name: model, reasoning: { efforts: mode === 'unsupported-effort' ? [{ id: 'low', name: 'Low' }] : [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } }
      }
      async *stream(options) {
        calls++; assert.equal(options.model, 'model'); assert.equal(options.reasoningEffort, 'high')
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Fixture())
    const client = { call: async (path, ...args) => { const result = await hub.client.call(path, ...args); if (drop && path.endsWith('/selection-evidence')) throw new Error('fixture receipt lost'); return result } }
    execution = new OfficialExecution(ctx, profiles, client)
    if (['wrong-model', 'inference', 'unsupported-effort', 'missing-provider', 'disallowed-model', 'profile-during-lookup'].includes(mode)) {
      await assert.rejects(execution.open(agent), /selection policy|reasoning effort|provider|profile|allowedModels/i)
      assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'prepared')
      assert.equal(profiles.binding(agent.id).selectionAdmission.status, 'rejected')
      assert.equal(calls, 0); return
    }
    run = await execution.open(agent)
    assert.equal(profiles.binding(agent.id).selectionAdmission.configuration.inference_verified, false)
    if (mode === 'profile-after-claim') {
      const prepared = await run.prepareCall({ ...agent.options })
      await profiles.update(state => { state.profiles[0].name = 'Changed configuration' })
      await assert.rejects(consume(prepared.stream({ ...agent.options, sessionId: agent.id, tools: [], messages: [] })), /profile changed/)
      await assert.rejects(run.prepareCall({ ...agent.options }), /profile changed/)
      assert.equal(calls, 0)
      return
    }

    const config = { ...agent.options }, options = { ...config, sessionId: agent.id, tools: [], messages: [{ id: 'input', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'Fixture' }] }] }
    await assert.rejects(consume(run.stream(options)), /requires a prepared call/)
    await assert.rejects(run.prepareCall({ ...config, reasoningEffort: 'low' }), /selection policy/)
    await assert.rejects(run.prepareCall(config, undefined, controls => ({ ...controls, reasoningEffort: 'low' })), /selection policy/)
    const tampered = await run.prepareCall(config)
    await assert.rejects(consume(tampered.stream({ ...options, model: 'other' })), /selection policy/)
    assert.equal(calls, 0)
    const prepared = await run.prepareCall(config)
    if (drop) {
      await assert.rejects(consume(prepared.stream(options)), /reconciliation/)
      assert.equal(calls, 0)
      assert.equal(Object.keys(profiles.binding(agent.id).officialCalls ?? {}).length, 0)
      drop = false; await execution.selection.tick()
      execution.selection.assertSettled(agent.id, profiles.binding(agent.id).managedOperation, selection_policy)
      assert.equal(calls, 0, 'evidence retry never retries inference')
    } else {
      await consume(prepared.stream(options)); assert.equal(calls, 1)
      await run.finish()
      assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'reported')
    }
    const audit = await hub.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    const evidence = audit.events.filter(row => row.data.kind === 'selection_evidence')
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].data.evidence.scope, 'executor_configuration')
    assert.equal(evidence[0].data.evidence.model.observed, 'model')
    assert.equal(evidence[0].data.evidence.effort.observed, 'high')
  } finally { run?.dispose(); await execution?.close(); await ctx.fiber.dispose(); await hub.close() }
})
