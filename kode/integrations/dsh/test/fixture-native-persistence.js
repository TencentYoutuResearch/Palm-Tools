/** Owned crash-test Host: real JSONL persistence, no inference or daily configuration. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as factory from '../src/native-agent-factory.js'
import { join } from 'node:path'
const [root, mode, compression] = process.argv.slice(2)
try {
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ProjectionRegistry)
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('agentPresets', { register: async () => () => {} })
  ctx.provide('agentLoop', {})
  ctx.provide('kodeAgents', { adapter: { stopBlocked: () => true, closeSession: async () => {}, stream() { throw new Error('Fixture must never infer') } } })
  ctx.agents.setFactory({ createAgent() { throw new Error('Unexpected official create') }, resume() { throw new Error('Unexpected official resume') } })
  await ctx.plugin(persistence, { root: join(root, 'sessions'), compression })
  await ctx.plugin(factory)
  const selection = { provider: 'kode-agent-fixture', model: 'fixture' }
  const { agent } = mode === 'create'
    ? await ctx.agents.create({ sessionId: 'durable-worker', agentOptions: selection, meta: { cwd: root, agentPreset: 'kode-native' } })
    : await ctx.agents.resume({ resumeSessionId: 'durable-worker', agentOptions: selection })
  if (mode === 'create') {
    agent.inject({ id: 'queued-original', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture queued work' }] })
    await agent.ctx.sessions.flush(agent.session)
  }
  const snapshot = () => ({ id: agent.id, cwd: agent.session.header.cwd, queued: agent.inbox.nextStep.map(row => row.id), consumed: agent.session.snapshotEvents().filter(row => row.type === 'user/message').length })
  process.on('message', async command => {
    try {
      if (command === 'cancel') process.send({ type: 'cancelled', result: await agent.cancelInput('queued-original'), snapshot: snapshot() })
    } catch (error) { process.send({ type: 'error', message: error.message }) }
  })
  process.send({ type: 'ready', snapshot: snapshot() })
} catch (error) { process.send?.({ type: 'error', message: error.stack ?? error.message }); process.exitCode = 1 }
