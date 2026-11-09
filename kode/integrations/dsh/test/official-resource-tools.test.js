/** Actual scoped tool registration and home-Hub resource reads, without model inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createRequire } from 'node:module'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { mountOfficialResourceTools, OFFICIAL_RESOURCE_TOOLS } from '../src/official-resource-tools.js'
import { acquireOperationLease } from '../src/operation-lease.js'

test('resource tools isolate two official Agents and preserve authoritative ranking and unknown quota', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('resource-tools'), ctx = new Context()
  let execution, host
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    const globalTool = name => ({ name, description: 'Ordinary session tool', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => name,
    })
    ctx.tools.register(globalTool('ordinary_before'))
    const modelCalls = new Map(), errors = []
    ctx.on('agent/error', event => errors.push(event.error.message))
    class Fixture extends LlmAdapter {
      async *stream(options) {
        assert.deepEqual(options.tools.map(tool => tool.name).sort(), [...OFFICIAL_RESOURCE_TOOLS].sort())
        const count = (modelCalls.get(options.sessionId) ?? 0) + 1
        modelCalls.set(options.sessionId, count)
        if (count < 3) {
          const name = OFFICIAL_RESOURCE_TOOLS[count - 1]
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `loop-${count}`, name, arguments: count === 1 ? '{}' : '{"task_tag":"coding"}' } }
        } else {
          assert.equal(options.messages.filter(message => message.role === 'tool').length, 2)
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Resource recommendation remains pending execution checks.' } }
        }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: count < 3 ? 'tool-calls' : 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Fixture())
    const root = await realpath(hub.root), clients = new Map()
    const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open(['a', 'b', 'resource-a', 'resource-b'].map(id => ({ id, name: id, type: 'dsh' })))
    const service = { profiles, hasRuntime: () => true }
    let rankReads = 0
    const toolClient = { call: (path, ...args) => { if (path.endsWith('/resources/rank')) rankReads++; return hub.client.call(path, ...args) } }
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'fixture', path: root }] })
    ctx.provide('kodeOfficialToolPolicies', new OfficialToolPolicies())
    ctx.provide('kodeOperationLeases', { acquire: (agent, binding, signal, admission) => acquireOperationLease(clients.get(agent.id), binding,
      { node_id: hub.node, session_id: agent.id, grant_enforcement: true }, { signal, leaseMs: 10000, beforeClaim: admission.beforeClaim }) })
    execution = new OfficialExecution(ctx, profiles, hub.client, { host: hub.node })
    host = new OfficialLoopHost(ctx, execution)
    const handles = [], configurations = []
    for (const id of ['a', 'b']) {
      const resource = `resource-${id}`
      const registration = await call('sessions', { session_id: id, title: id, runtime: 'external' })
      clients.set(id, hub.client.forSession(registration.owner_token))
      await call('resource-accounts', { id: resource, expected_epoch: 0, enabled: true })
      await call('resource-bindings', { host: hub.node, profile: resource, account_id: resource, account_epoch: 1, expected_revision: 0 })
      const at = Date.now()
      await call('capability-profiles', { id: resource, expected_revision: 0, host: hub.node, profile: resource, model: 'model', assessments: {
        quality: { evaluation: { kind: 'task_fit', tag: 'coding', score: 85 }, source: 'user', confidence: 0.9, evidence: [], pinned: false, updated_at: at, valid_until: at + 60000 },
      } })
      await profiles.bind(id, id)
      const op = await call('operations', { owner_session: 'owner', request_key: id, worker: { node_id: hub.node, session_id: id }, grant_required: true, selection_policy: { profile_revision: profiles.binding(id).revision, model: 'model', effort: null, scope: 'executor_configuration' } })
      const scope = { team_id: id, revision: 1, target: { host: hub.node, workspace: 'fixture', root }, capabilities: ['read'], tools: [...OFFICIAL_RESOURCE_TOOLS], network: false, budget_ids: [] }
      await call('team-grants', { expected_revision: 0, policy: { id, team_id: id, enabled: true, expires_at: at + 60000, targets: [scope.target], capabilities: scope.capabilities, tools: scope.tools, network: false, budget_ids: [] } })
      await call(`operations/${op.id}/grant`, { expected_revision: op.revision, binding: { grant_id: id, attempt: 1, epoch: 1, scope } })
      await profiles.patchBinding(id, { managedOperation: { id: op.id, attempt: 1, epoch: 1 } })
      const policy = { profiles: [resource], ranking: { minimum_quality: 70, minimum_confidence: 0.5, weights: { quality: 1, cost: 1, latency: 0 }, candidates: [{ capability_id: resource, capability_revision: 1, model: 'model', resource: {
        host: hub.node, profile: resource, account_id: resource, account_epoch: 1, binding_revision: 1, limit_ids: ['primary'], unknown_quota: 'team_budget',
      } }] } }
      configurations.push(policy)
      handles.push(await host.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: root },
        setup: (agentCtx, agent) => { agentCtx.effect(() => mountOfficialResourceTools(agentCtx, agent, service, toolClient, hub.node, policy)) },
      }, { tools: [...OFFICIAL_RESOURCE_TOOLS] }))
    }
    ctx.tools.register(globalTool('ordinary_after'))
    assert.ok(ctx.tools.get('ordinary_before')); assert.ok(ctx.tools.get('ordinary_after'))
    const ordinary = await ctx.tools.execute({ name: 'ordinary_after', arguments: {}, callId: 'ordinary', signal: new AbortController().signal })
    assert.equal(ordinary.isError, false); assert.equal(ordinary.content[0].text, 'ordinary_after')
    assert.equal(ctx.tools.get(OFFICIAL_RESOURCE_TOOLS[0]), undefined, 'tools are not globally exposed')
    // Mutating the caller's config cannot widen an already installed tool.
    configurations[0].profiles.push('resource-b')
    configurations[0].ranking.candidates.push(configurations[1].ranking.candidates[0])
    for (const [index, owned] of handles.entries()) {
      const request = (name, args, id) => ({ agent: owned.agent, name, arguments: args, callId: id })
      const coverage = await owned.run.execute(request(OFFICIAL_RESOURCE_TOOLS[0], {}, 'coverage'))
      const data = JSON.parse(coverage.content[0].text)
      assert.deepEqual(data.items.map(row => row.profile_id), [`resource-${owned.agent.id}`])
      assert.equal(data.eligible_for_dispatch, false)
      assert.equal(data.items[0].provider_monetary.status, 'not_connected')
      const ranked = JSON.parse((await owned.run.execute(request(OFFICIAL_RESOURCE_TOOLS[1], { task_tag: 'coding' }, 'rank'))).content[0].text)
      assert.deepEqual(ranked.candidates.map(row => row.profile), [`resource-${owned.agent.id}`])
      assert.equal(ranked.eligible_for_dispatch, false)
      assert.equal(ranked.candidates[0].quota.requires_team_budget, true)
      owned.agent.followup({ id: `input-${owned.agent.id}`, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'Inspect resources and recommend candidates.' }] })
      await owned.agent.whenIdle()
      assert.deepEqual(errors, [])
      assert.equal(modelCalls.get(owned.agent.id), 3)
      assert.equal(profiles.binding(owned.agent.id).officialTools['loop-2'].home_reconciled, true)
      assert.deepEqual(ctx.tools.schemas(owned.agent).map(row => row.name).sort(), [...OFFICIAL_RESOURCE_TOOLS].sort())
      if (index === 0) {
        const before = rankReads
        await assert.rejects(owned.run.execute(request(OFFICIAL_RESOURCE_TOOLS[1], { task_tag: 'coding', minimum_quality: 0 }, 'widen')), /arguments exceed grant/)
        assert.equal(rankReads, before, 'model input cannot change owner quality floor')
        await owned.dispose()
      }
    }
    assert.ok(ctx.tools.get(OFFICIAL_RESOURCE_TOOLS[0], handles[1].agent), 'disposing one Agent retains the other scope')
    await handles[1].run.finish()
  } finally { await host?.close(); await execution?.close(); await ctx.fiber.dispose(); await hub.close() }
})
