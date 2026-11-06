/** Owned child process; only fixture-generated authentication files are read. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createRequire } from 'node:module'
const loopRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))
const { default: Tools } = await import(loopRequire.resolve('@deepseek-ai/dsh-tools'))
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { readFile, writeFile, appendFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { BackendClient } from '../src/backend-client.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialExecution } from '../src/official-execution.js'
import { OfficialLoopHost } from '../src/official-loop-host.js'
import { OfficialToolPolicies } from '../src/official-grant-guard.js'
import { acquireOperationLease } from '../src/operation-lease.js'
const [mode, directory, url, tokenFile, node, operationId] = process.argv.slice(2)
const root = await realpath(directory), ctx = new Context()
const starting = ['start', 'dispatch-intent', 'dispatch-created', 'dispatch-effect'].includes(mode)
const client = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
let execution, host, stage = 'plugins'
try {
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(Tools); await ctx.plugin(LlmRuntime)
  await ctx.plugin(persistence, { root: join(root, 'sessions'), compression: 'zstd' })
  stage = 'registration'
  const workerTokenFile = join(root, 'fixture-worker.token')
  if (starting) {
    const registration = await client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    await writeFile(workerTokenFile, registration.owner_token, { mode: 0o600 })
  }
  const worker = client.forSession((await readFile(workerTokenFile, 'utf8')).trim())
  stage = 'profiles'
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'official', name: 'Official', type: 'dsh' }])
  if (starting) {
    await profiles.bind('worker', 'official')
    await profiles.patchBinding('worker', { managedOperation: { id: operationId, attempt: 1, epoch: 1 } })
  }
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'fixture', path: root }] })
  ctx.provide('kodeOperationLeases', { acquire: (agent, binding, signal) => acquireOperationLease(worker, binding, { node_id: node, session_id: agent.id, grant_enforcement: true }, { signal, leaseMs: 10000 }) })
  let calls = 0, effects = 0
  class Fixture extends LlmAdapter {
    async *stream() {
      calls++
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'partial', name: 'fixture_effect', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Fixture())
  ctx.tools.register({ name: 'fixture_effect', description: 'Controlled partial fixture effect', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, request) => {
      effects++
      await appendFile(join(root, 'effects.txt'), 'effect\n')
      await ctx.sessions.flush(request.agent.session)
      process.send({ type: 'effect', calls, effects })
      await new Promise(() => {}) // Parent kills this process after the durable side effect.
    },
  })
  const policies = new OfficialToolPolicies(); ctx.provide('kodeOfficialToolPolicies', policies)
  const setup = (agentCtx, agent) => { agentCtx.effect(() => policies.register('fixture_effect', {
    capabilities: ['workspace_write'], network: false, implementation: ctx.tools.get('fixture_effect', agent), authorize: async () => true,
  })) }
  stage = 'execution-recovery'
  execution = new OfficialExecution(ctx, profiles, client, { host: node })
  await execution.ready
  host = new OfficialLoopHost(ctx, execution)
  const command = { command_id: 'create', session_id: 'worker', operation: { id: operationId, attempt: 1, epoch: 1 },
    profile_revision: profiles.binding('worker').revision, provider: 'fixture', model: 'model', cwd: root, tools: ['fixture_effect'] }
  if (mode === 'dispatch-effect') {
    const update = profiles.update.bind(profiles)
    profiles.update = operation => update(async state => {
      const result = await operation(state)
      if (state.bindings.worker.officialDispatch?.create?.state === 'created') {
        await ctx.sessions.flush(host.handles.get('worker').agent.session)
        process.send({ type: 'dispatch-effect', calls, effects })
        await new Promise(() => {}) // Actual Agent exists, but its created receipt has not been written.
      }
      return result
    })
  }
  if (['dispatch-intent', 'dispatch-created', 'dispatch-effect'].includes(mode)) {
    stage = mode
    const receipt = await host.dispatches.dispatch(command, { setup: mode === 'dispatch-intent' ? async () => {
      process.send({ type: 'dispatch-intent', calls, effects })
      await new Promise(() => {}) // Killed inside actual AgentLoop initialization, after durable command intent.
    } : setup })
    await ctx.sessions.flush(host.handles.get('worker').agent.session)
    process.send({ type: 'dispatch-created', state: receipt.state, calls, effects })
    await new Promise(() => {})
  } else if (mode === 'dispatch-recover') {
    stage = 'dispatch-recover'
    const receipt = await host.dispatches.dispatch(command, { setup })
    const reconciled = await host.dispatches.reconcile('worker', 'create')
    let replacementRejected = false
    try { await host.dispatches.dispatch({ ...command, command_id: 'replacement' }, { setup }) }
    catch (error) { if (!/already has a creation command/.test(error.message)) throw error; replacementRejected = true }
    const result = { type: 'dispatch-recovered', state: receipt.state, reconciledState: reconciled.state,
      recoveryBasis: reconciled.recovery?.basis ?? null, reconciliation: reconciled.reconciliation ?? null, calls, effects, replacementRejected,
      agentAbsent: ctx.agents.get('worker') === undefined, sessionAbsent: ctx.sessions.get('worker') === undefined }
    await host.close(); await execution.close(); await ctx.fiber.dispose()
    process.send(result, () => process.disconnect())
  } else if (mode === 'start') {
    stage = 'create'
    const owned = await host.create({ sessionId: 'worker', agentOptions: { provider: 'fixture', model: 'model' }, meta: { cwd: root }, setup }, { tools: ['fixture_effect'] })
    stage = 'turn'
    owned.agent.followup({ id: 'request', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: 'Run fixture effect' }] })
    await owned.agent.whenIdle()
    throw new Error('Fixture must be killed inside its tool')
  } else {
    stage = 'resume'
    let rejected = false
    try { await host.resume({ resumeSessionId: 'worker', agentOptions: { provider: 'fixture', model: 'model' }, setup }, { tools: ['fixture_effect'] }) }
    catch (error) { if (!/lease identity or state changed/.test(error.message)) throw error; rejected = true }
    stage = 'recovered-evidence'
    const row = profiles.binding('worker').officialTools.partial
    const result = { type: 'recovered', rejected, calls, effects, status: row.status, reason: row.reason,
      home_reconciled: row.home_reconciled, home_sequence: row.home_sequence,
      agentAbsent: ctx.agents.get('worker') === undefined, sessionAbsent: ctx.sessions.get('worker') === undefined }
    await host.close(); await execution.close(); await ctx.fiber.dispose()
    process.send(result, () => process.disconnect())
  }
} catch (error) {
  // Never serialize an arbitrary backend error or configuration to the parent.
  process.send?.({ type: 'failed', stage, code: ['lease identity or state changed', 'token', 'unauthorized', 'already', 'grant', 'Fixture must be killed'].find(text => error.message.includes(text)) ?? error.name }, () => process.exit(1))
}
