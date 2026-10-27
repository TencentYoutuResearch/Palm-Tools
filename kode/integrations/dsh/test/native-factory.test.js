import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { assistantStreamFirstTokenTime, expandAssistantStream } from '@deepseek-ai/dsh-llm'
import * as factoryPlugin from '../src/native-agent-factory.js'

async function host(adapter) {
  const ctx = new Context(), stored = new Map(), writers = new Map()
  await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(ProjectionRegistry)
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('agentPresets', { register: async () => () => {} })
  ctx.provide('kodeAgents', { adapter })
  const makeHandle = (row, write) => {
    const handle = { header: row.header, inheritedEventCount: 0,
      read: async () => ({ events: [...row.events] }),
      append: async events => { assert.equal(events[0]?.seq ?? row.events.length, row.events.length); row.events.push(...events) },
      flush: async () => {}, close: async () => { if (writers.get(row.header.id) === handle) writers.delete(row.header.id) },
    }
    if (write) { if (writers.has(row.header.id)) throw new Error('already owned'); writers.set(row.header.id, handle) }
    return handle
  }
  ctx.provide('sessionPersistence', {
    create: async header => { if (stored.has(header.id)) throw new Error('already exists'); const row = { header, events: [] }; stored.set(header.id, row); return makeHandle(row, true) },
    open: async (id, access) => { if (!stored.has(id)) throw new Error('not found'); return makeHandle(stored.get(id), access === 'write') },
  })
  ctx.on('session/event', (session, event) => { const row = stored.get(session.id); if (row && writers.has(session.id)) { assert.equal(event.seq, row.events.length); row.events.push(event) } })
  ctx.on('session/flush', async () => {})
  const fiber = await ctx.plugin(factoryPlugin)
  return { ctx, stored, writers, fiber }
}
const message = (id, text) => ({ id, role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text }] })
const options = { sessionId: 'session-native-check', agentOptions: { provider: 'kode-agent-fixture', model: 'fixture' }, meta: { cwd: '/tmp' } }

test('native factory persists actual Agent turns without assembling a dsh system prompt and resumes once', async () => {
  const inputs = []
  const h = await host({ async *stream(request) { inputs.push(request.messages.map(m => m.id)); yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'Native reply' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native reply' } }; yield { type: 'finish', reason: { kind: 'stop' } } }, closeSession: async () => {} })
  let prompts = 0, scopedToolReads = 0
  h.ctx.tools.schemas = scope => { assert.equal(scope.id, options.sessionId); scopedToolReads++; return [] }
  h.ctx.on('system-prompt/assemble', () => { prompts++; throw new Error('Native Agent must own its prompt') })
  const first = await h.ctx.agents.create(options)
  first.agent.followup(message('one', 'hello')); await first.agent.whenIdle()
  const log = h.stored.get(options.sessionId).events
  assert.ok(log.some(e => e.type === 'assistant/message' && e.data.message.content.some(c => c.text === 'Native reply')))
  const answer = log.find(e => e.type === 'assistant/message')
  assert.equal(typeof assistantStreamFirstTokenTime(answer.data.stream), 'number')
  assert.ok(expandAssistantStream(answer.data.stream).some(row => row.chunk.type === 'text-delta'))
  assert.ok(log.some(e => e.type === 'turn/end' && e.data.reason.kind === 'completed'))
  assert.equal(prompts, 0)
  assert.equal(scopedToolReads, 1)
  assert.ok(!log.some(e => e.type === 'system/message' || e.type === 'developer/message'))
  await first.dispose()
  assert.equal(h.writers.size, 0)
  const second = await h.ctx.agents.resume({ resumeSessionId: options.sessionId, agentOptions: options.agentOptions })
  second.agent.followup(message('two', 'again')); await second.agent.whenIdle()
  assert.deepEqual(inputs, [['one'], ['two']])
  await h.fiber.dispose()
  assert.equal(h.ctx.agents.list().length, 0)
  assert.equal(h.ctx.sessions.list().length, 0)
  assert.equal(h.writers.size, 0)
})

test('unplugging a native runtime cancels and drains a live Agent before releasing storage', async () => {
  let started, ended = false
  const running = new Promise(resolve => { started = resolve })
  const h = await host({ async *stream({ signal }) { started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); ended = true; signal.throwIfAborted() }, closeSession: async () => {} })
  const handle = await h.ctx.agents.create(options)
  handle.agent.followup(message('cancel', 'work')); await running
  await h.fiber.dispose()
  assert.equal(ended, true)
  assert.equal(h.writers.size, 0)
  assert.equal(h.ctx.agents.list().length, 0)
  assert.equal(h.stored.get(options.sessionId).events.at(-1).data.reason.kind, 'aborted')
})
