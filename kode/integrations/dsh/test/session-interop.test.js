import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeInteropSettings, summaryTranscript, SessionInterop, registerSessionInteropApi } from '../src/session-interop.js'
import { switchSessionModel } from '../src/session-interop-model.js'
test('local settings default unconfigured; reject malformed grants', () => {
  assert.deepEqual(normalizeInteropSettings({}), { summary: null, grants: [] })
  assert.throws(() => normalizeInteropSettings({ summary: { profile_id: 'p', model: 'm', endpoint: 'https://example.com' } }))
  assert.throws(() => normalizeInteropSettings({ grants: [{ source: 'a', target: 'b', actions: ['read_all'] }] }))
})
test('summary excludes system and tool content; reports truncation', () => {
  const events = [{ type: 'system/message', data: { content: [{ type: 'text', text: 'secret' }] } }, { type: 'tool/result', data: { content: [{ type: 'text', text: 'credential' }] } }, { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } }]
  assert.deepEqual(summaryTranscript(events).messages, [{ role: 'user', text: 'hello' }])
  assert.equal(summaryTranscript(events, 1).truncated, true)
})
function context() {
  const binding = { profile: { id: 'p', allowedModels: ['m'], type: 'codex' } }
  const agent = { id: 'a', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: {}, selectModel(s) { this.selected = s }, ctx: { sessions: { flush: async () => {} } } }
  const ctx = { agents: { get: id => id === 'a' ? agent : undefined }, sessionController: { resolveAgent: async () => ({ agent }) }, kodeAgents: { profiles: { binding: () => structuredClone(binding), list: () => [] }, adapter: { listModels: async () => [{ id: 'm' }] } } }
  return { ctx, agent, binding }
}
test('model validates catalogue; refuses busy, managed and discovery race', async () => {
  const { ctx, agent, binding } = context()
  assert.equal((await switchSessionModel(ctx, 'a', { model: 'm' })).effective, 'next_turn')
  await assert.rejects(switchSessionModel(ctx, 'a', { model: 'missing' }))
  agent.status = 'running'; await assert.rejects(switchSessionModel(ctx, 'a', { model: 'm' }), /busy/)
  agent.status = 'idle'; binding.managedOperation = {}; await assert.rejects(switchSessionModel(ctx, 'a', { model: 'm' }), /Managed/)
  delete binding.managedOperation
  ctx.kodeAgents.adapter.listModels = async () => { agent.status = 'running'; return [{ id: 'm' }] }
  await assert.rejects(switchSessionModel(ctx, 'a', { model: 'm' }), /busy/)
})
test('exact grants and caller identity govern cross-session access', async () => {
  const { ctx, agent } = context(), root = await mkdtemp(join(tmpdir(), 'interop-test-'))
  try {
    const service = new SessionInterop(ctx, { path: join(root, 'settings.json') })
    await service.authorize(agent, 'a', 'summary')
    await assert.rejects(service.authorize(agent, 'b', 'summary'), /grant/)
    await service.configure({ grants: [{ source: 'a', target: 'b', actions: ['summary'] }] })
    await service.authorize(agent, 'b', 'summary')
    await assert.rejects(service.authorize(agent, 'b', 'model'), /grant/)
    await assert.rejects(service.authorize({ id: 'a' }, 'a', 'summary'), /Foreign/)
    await assert.rejects(service.summary({ system_prompt: 'Summarize' }, agent), /Configure/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('HTTP denies nonowner before reads', async () => {
  let route, read = false, code
  const ctx = { webServer: { register: r => { route = r } }, connection: { admit: () => ({ peer: { principal: { kind: 'agent' } } }) } }
  registerSessionInteropApi(ctx, { settings: () => { read = true } })
  await route.handler({ method: 'GET' }, { writeHead: n => { code = n }, end() {} })
  assert.equal(code, 403); assert.equal(read, false)
})
test('summary uses isolated no-tool snapshot and does not mutate source', async () => {
  const { ctx, agent } = context(), root = await mkdtemp(join(tmpdir(), 'interop-summary-'))
  let prepared, options, closed = 0
  class Decision {
    constructor(o) { options = o }
    async prepare(p) { prepared = p }
    async execute() { await options.admit(); return { texts: ['summary'], calls: [], terminal: 'completed', stop: { leader_exited: true, process_group_empty: true, signal_failures: [] } } }
    async close() { closed++; return { process_group_empty: true } }
  }
  const events = [{ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'Explain the design' }] } }]
  agent.session.snapshotEvents = () => events
  ctx.kodeAgents.profiles.list = () => [{ id: 'p', type: 'codex', allowedModels: ['m'], managedInference: { endpoint: 'https://example.com/v1' } }]
  try {
    const service = new SessionInterop(ctx, { path: join(root, 'settings.json'), Decision })
    await service.configure({ summary: { profile_id: 'p', model: 'm' } })
    const result = await service.summary({ system_prompt: 'Explain status' }, agent)
    assert.equal(result.summary, 'summary'); assert.equal(result.snapshot_seq, 1)
    assert.deepEqual(prepared.tools, []); assert.equal(options.allowUserInput, false)
    assert.notEqual(options.cwd, process.cwd()); assert.equal(events.length, 1); assert.equal(closed, 1)
    assert.equal(service.pending.size, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('HTTP session credential cannot edit settings; invalid token cannot reach service', async () => {
  let route, code, configured = false
  const ctx = { webServer: { register: r => { route = r } }, connection: { admit: () => ({ rejection: {} }) } }
  const service = { backend: { forSession: token => ({ call: async path => {
    if (token !== 'fixture-session-token') throw new Error('invalid')
    return path.endsWith('/self') ? { address: { session_id: 'a' } } : { messaging_enabled: true }
  } }) }, configure: () => { configured = true } }
  registerSessionInteropApi(ctx, service)
  const request = token => ({ method: 'POST', headers: { authorization: `Bearer ${token}` }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ action: 'configure', settings: {} }) } })
  const response = { writeHead: n => { code = n }, end() {} }
  await route.handler(request('fixture-session-token'), response)
  assert.equal(code, 403); assert.equal(configured, false)
  await route.handler(request('invalid'), response); assert.equal(code, 403)
})
test('HTTP client disconnect aborts pending summary and removes lifecycle listeners', async () => {
  const { EventEmitter } = await import('node:events')
  let route, inferenceSignal, admitted
  const started = new Promise(resolve => { admitted = resolve })
  const ctx = { webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } }
  registerSessionInteropApi(ctx, { summary: async (_input, _source, signal) => {
    inferenceSignal = signal; admitted()
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const req = Object.assign(new EventEmitter(), { method: 'POST', async *[Symbol.asyncIterator]() { yield JSON.stringify({ action: 'summary', session_id: 'fixture', system_prompt: 'Summarize fixture only' }) } })
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, writeHead() {}, end() { this.writableEnded = true } })
  const operation = route.handler(req, res)
  await started
  res.destroyed = true; res.emit('close')
  await operation
  assert.equal(inferenceSignal.aborted, true)
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0)
})
