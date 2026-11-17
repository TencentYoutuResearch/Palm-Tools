import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativePlanningBridge } from '../src/native-planning-bridge.js'
const id = 'session-11111111-1111-4111-8111-111111111111'
function fixture() {
  const calls = [], state = { admission: true, existing: false, events: [], changedId: false }
  const profile = { id: 'native', type: 'claude', defaultModel: 'opus' }
  const agent = { id, status: 'idle', session: { header: { cwd: '/fixture/project' }, snapshotEvents: () => state.events },
    ctx: { sessions: { flush: async () => { calls.push('flush'); return true } } },
    selectModel: async selection => calls.push(['select', selection]), followup: () => { throw Error('Must not submit input') } }
  const controller = { list: async () => ({ items: state.existing ? [{ sessionId: id }] : [] }),
    create: async options => { calls.push(['create', options]); return { sessionId: state.changedId ? 'other' : id } },
    resolveAgent: async () => ({ agent }), rename: async options => calls.push(['rename', options]) }
  const selection = { provider: 'kode-agent-native', model: 'opus' }
  const binding = { version: 1, mode: 'interactive_planning', home_hub: 'fixture', draft_id: 'draft', context_epoch: 1, session_id: id, workspace_id: 'workspace', cwd: '/fixture/project' }
  const ctx = { get: name => ({ sessionController: controller, workspaceRegistry: { get: key => key === 'workspace' ? { path: '/fixture/project' } : undefined },
    kodePlanningRuntime: { sessionAdmission: async () => state.admission ? { binding, selection } : undefined }, agents: { get: () => undefined } })[name] }
  const service = { profiles: { list: () => [profile], binding: () => undefined, bind: async (...args) => calls.push(['bind', ...args]) },
    adapter: { listModels: async () => [{ id: 'opus' }] }, hasRuntime: () => true, recordBinding: () => calls.push('record') }
  const input = { session_id: id, workspace_id: 'workspace', profile_id: 'native', title: 'Planning', selection: { provider: 'kode-agent-native', model: 'opus' } }
  return { bridge: createNativePlanningBridge({ ctx, service }), input, state, calls }
}
test('method-shaped objects cannot substitute for actual native factory ownership', async () => {
  const f = fixture()
  await assert.rejects(f.bridge.create(f.input), /trusted native factory/)
  assert.deepEqual(f.calls.find(row => row[0] === 'create')[1], { sessionId: id, agentPreset: 'kode-native', workspaceId: 'workspace' })
  assert.equal(f.calls.some(row => row[0] === 'bind'), false)
})
test('unknown owner draft admission cannot create a native session', async () => {
  const f = fixture(); f.state.admission = false
  await assert.rejects(f.bridge.create(f.input), /admission/)
  assert.equal(f.calls.length, 0)
})
test('existing conversation cannot be adopted or replaced', async () => {
  const f = fixture(); f.state.existing = true
  await assert.rejects(f.bridge.create(f.input), /existing conversation/)
  assert.equal(f.calls.length, 0)
})
test('changed creation identity is uncertain and never retried inside bridge', async () => {
  const f = fixture(); f.state.changedId = true
  await assert.rejects(f.bridge.create(f.input), /reconciliation/)
  assert.equal(f.calls.filter(row => row[0] === 'create').length, 1)
})
test('nonblank history is rejected before selecting or binding', async () => {
  const f = fixture(); f.state.events = [{ type: 'user/message' }]
  await assert.rejects(f.bridge.create(f.input), /blank/)
  assert.equal(f.calls.some(row => row[0] === 'bind'), false)
})
