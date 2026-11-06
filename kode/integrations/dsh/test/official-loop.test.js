/** Actual AgentLoop, LlmRuntime, ToolRuntime, session registries and isolated Hub. No inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createRequire } from 'node:module'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { isolatedHub } from './support/isolated-hub.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { acquireOperationLease } from '../src/operation-lease.js'

const persistent = process.env.KODE_TEST_OFFICIAL_PERSISTENCE === '1'
for (const failPost of (persistent ? [false] : [false, true])) test(`actual controlled official loop retains tool finalization (failure=${failPost})`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('official-loop'), ctx = new Context()
  let execution, run, host, owned
  try {
    await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
    if (persistent) await ctx.plugin(await import('@deepseek-ai/dsh-session-persistence-jsonl'), { root: join(hub.root, 'sessions'), compression: 'zstd' })
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const op = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'loop', worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true })
    const root = await realpath(hub.root)
    const scope = { team_id: 'team', revision: 1, target: { host: hub.node, workspace: 'fixture', root }, capabilities: ['read'], tools: ['fixture_tool'], network: false, budget_ids: [] }
    await hub.client.call('/api/v1/messaging/team-grants', { expected_revision: 0, policy: { id: 'grant', team_id: 'team', enabled: true, expires_at: Date.now() + 60000, targets: [scope.target], capabilities: scope.capabilities, tools: scope.tools, network: false, budget_ids: [] } })
    await hub.client.call(`/api/v1/messaging/operations/${op.id}/grant`, { expected_revision: op.revision, binding: { grant_id: 'grant', attempt: 1, epoch: 1, scope } })
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'fixture', path: root }] })
    const profiles = await new AgentProfiles(join(hub.root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh' }])
    await profiles.bind('worker', 'official')
    await profiles.patchBinding('worker', { managedOperation: { id: op.id, attempt: 1, epoch: 1 } })
    ctx.provide('kodeOperationLeases', { acquire: (agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: hub.node, session_id: agent.id, grant_enforcement: true }, { signal, leaseMs: 10000 }) })
    const trace = [], events = [], errors = []
    ctx.on('agent/error', event => errors.push(event.error.message))
    ctx.on('session/event', (_session, event) => events.push(event))
    ctx.on('tools/pre-execute', async (request, next) => { trace.push(`pre:${request.callId}`); return next() })
    ctx.on('tools/post-execute', async (request, result, next) => {
      trace.push(`post:${request.callId}`)
      if (failPost) throw new Error('fixture post failure')
      return next()
    })
    ctx.tools.register({ name: 'fixture_tool', description: 'Fixture', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, request) => { trace.push(`body:${request.callId}`); return 'tool result' },
    })
    let calls = 0, lastMessages
    class Fixture extends LlmAdapter {
      async *stream(options) {
        lastMessages = options.messages
        calls++
        if (calls === 1) {
          for (let index = 0; index < 2; index++) {
            yield { type: 'block-start', index, blockType: 'tool-call' }
            yield { type: 'block-end', index, block: { type: 'tool-call', id: `call-${index}`, name: 'fixture_tool', arguments: '{}' } }
          }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } }
        }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        yield { type: 'finish', reason: { kind: calls === 1 ? 'tool-calls' : 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['fixture'], new Fixture())
    execution = new OfficialExecution(ctx, profiles, hub.client, { host: hub.node })
    const ordinary = { agent: { id: 'ordinary' }, dispose: async () => {} }
    ctx.agents.setFactory({ createAgent: async () => ordinary })
    const policies = new OfficialToolPolicies()
    ctx.provide('kodeOfficialToolPolicies', policies)
    host = new OfficialLoopHost(ctx, execution)
    const createOptions = { sessionId: 'worker', agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: root } }
    if (!persistent) {
    await assert.rejects(host.create(createOptions, { tools: ['fixture_tool'] }), /trusted policy/)
    assert.equal(ctx.agents.get('worker'), undefined, 'failed grant admission releases the Agent')
    assert.equal(ctx.sessions.get('worker'), undefined, 'failed admission releases the live session')
    const cancelled = new AbortController()
    await assert.rejects(host.create({ ...createOptions, signal: cancelled.signal,
      setup: () => { cancelled.abort(new Error('fixture creation cancelled')) },
    }, { tools: ['fixture_tool'] }), /fixture creation cancelled/)
    assert.equal(ctx.agents.get('worker'), undefined)
    assert.equal(ctx.sessions.get('worker'), undefined)
    }
    const dispatch = { command_id: 'create-worker', session_id: 'worker', operation: { id: op.id, attempt: 1, epoch: 1 },
      profile_revision: profiles.binding('worker').revision, provider: 'fixture', model: 'model', cwd: root, tools: ['fixture_tool'] }
    if (!persistent) {
      const stale = { ...dispatch, command_id: 'changed-admission', session_id: 'raced' }
      await profiles.bind('raced', 'official')
      await profiles.patchBinding('raced', { managedOperation: dispatch.operation })
      await assert.rejects(host.dispatches.dispatch(stale, { setup: async () => {
        await profiles.patchBinding('raced', { managedOperation: { ...dispatch.operation, epoch: 2 } })
      } }), /admission changed/)
      assert.equal(host.dispatches.get('raced', stale.command_id).state, 'uncertain')
      assert.equal(ctx.agents.get('raced'), undefined)
      assert.equal(ctx.sessions.get('raced'), undefined)
      assert.equal(ctx.agents.get('worker'), undefined)
      assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'prepared')
    }
    let setups = 0
    const setup = (agentCtx, agent) => { setups++; agentCtx.effect(() => policies.register('fixture_tool', {
      capabilities: ['read'], network: false, implementation: ctx.tools.get('fixture_tool', agent), authorize: async () => true,
    })) }
    const receipts = await Promise.all([host.dispatches.dispatch(dispatch, { setup }), host.dispatches.dispatch(dispatch, { setup })])
    assert.deepEqual(receipts[0], receipts[1]); assert.equal(receipts[0].state, 'created'); assert.equal(setups, 1)
    assert.equal(calls, 0, 'dispatch creation does not invoke inference')
    assert.deepEqual(await host.dispatches.dispatch(dispatch, { setup }), receipts[0])
    await assert.rejects(host.dispatches.dispatch({ ...dispatch, model: 'other' }, { setup }), /identity conflict/)
    owned = host.handles.get('worker')
    const { agent } = owned; run = owned.run
    assert.equal(await ctx.agents.create({ sessionId: 'ordinary' }), ordinary, 'default factory remains installed')
    await assert.rejects(host.create({ sessionId: 'worker' }), /already owned/)
    agent.followup({ id: 'request', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'Run fixture tools' }] })
    await agent.whenIdle()
    assert.ok(trace.length, JSON.stringify(errors))
    if (failPost) {
      assert.deepEqual(trace, ['pre:call-0', 'body:call-0', 'post:call-0'])
      assert.equal(calls, 1)
      assert.equal(profiles.binding(agent.id).officialTools['call-0'].status, 'uncertain')
      assert.equal(profiles.binding(agent.id).officialTools['call-0'].home_reconciled, true)
      assert.ok(errors.some(message => /reconciliation/.test(message)))
      await assert.rejects(run.finish(), /reconciliation/)
    } else {
      assert.deepEqual(trace, ['pre:call-0', 'body:call-0', 'post:call-0', 'pre:call-1', 'body:call-1', 'post:call-1'])
      assert.equal(calls, 2)
      assert.deepEqual(errors, [])
      assert.equal(Object.values(profiles.binding(agent.id).officialCalls).filter(row => row.done).length, 2)
      assert.equal(events.filter(event => event.type === 'tool/result').length, 2)
      for (const row of Object.values(profiles.binding(agent.id).officialTools)) {
        assert.equal(row.status, 'returned'); assert.equal(row.home_reconciled, true)
      }
      await run.finish()
      assert.equal((await hub.client.call(`/api/v1/messaging/operations/${op.id}`)).state, 'reported')
      if (persistent) {
        await owned.dispose(); await host.close()
        const next = await hub.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'resume', worker: { node_id: hub.node, session_id: 'worker' }, grant_required: true })
        await hub.client.call(`/api/v1/messaging/operations/${next.id}/grant`, { expected_revision: next.revision, binding: { grant_id: 'grant', attempt: 1, epoch: 1, scope } })
        await profiles.patchBinding('worker', { operationClosed: false, managedOperation: { id: next.id, attempt: 1, epoch: 1 } })
        host = new OfficialLoopHost(ctx, execution)
        const detach = ctx.on('agent/created', ({ agent: resumed, source }) => {
          if (source !== 'resume') return
          assert.equal(execution.authorizesLease(resumed, profiles.binding(resumed.id).managedOperation), true)
          resumed.followup({ id: 'resume-request', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'Continue from saved history' }] })
        })
        try {
          owned = await host.resume({ resumeSessionId: 'worker', agentOptions: { provider: 'fixture', model: 'model' }, setup: (agentCtx, resumed) => {
            agentCtx.effect(() => policies.register('fixture_tool', { capabilities: ['read'], network: false,
              implementation: ctx.tools.get('fixture_tool', resumed), authorize: async () => true }))
          } }, { tools: ['fixture_tool'] })
        } finally { detach() }
        run = owned.run
        await owned.agent.whenIdle()
        assert.equal(calls, 3, JSON.stringify(errors))
        assert.equal(lastMessages.filter(message => message.role === 'tool').length, 2, 'prior tool results restored from disk')
        assert.ok(lastMessages.some(message => message.id === 'request'))
        assert.ok(lastMessages.some(message => message.id === 'resume-request'))
        assert.equal(trace.filter(item => item.startsWith('body:')).length, 2, 'resume does not replay prior tool effects')
        await run.finish()
        assert.equal((await hub.client.call(`/api/v1/messaging/operations/${next.id}`)).state, 'reported')
      }
    }
    if (failPost) await host.close()
    else await owned.dispose()
    await owned.dispose() // Both owner release and Host shutdown remain idempotent.
    assert.equal(ctx.agents.get('worker'), undefined)
    assert.equal(ctx.sessions.get('worker'), undefined)
    assert.deepEqual(await host.dispatches.dispatch(dispatch), receipts[0], 'receipt replay after disposal never recreates an Agent')
    assert.equal(ctx.agents.get('worker'), undefined)
    assert.equal(policies.get('fixture_tool'), undefined)
    await host.close()
    assert.equal(await ctx.agents.create({ sessionId: 'ordinary' }), ordinary)
    await assert.rejects(host.create({ sessionId: 'worker' }), /Host closed/)
  } finally { await host?.close(); run?.dispose(); await execution?.close(); await ctx.fiber.dispose(); await hub.close() }
})
