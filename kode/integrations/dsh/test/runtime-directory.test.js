import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeBridge } from '../src/runtime-bridge.js'

function fixture() {
  const profile = { id: 'agent', name: 'Agent', type: 'codex' }
  const items = [{ sessionId: 'blank', blank: true }, { sessionId: 'cold', cwd: '/work/fe', projections: { values: {} } }, { sessionId: 'archived', cwd: '/work/fe' }]
  const tabs = [{ backend_key: 'native', session_id: 'thread', dsh_session_id: 'cold', title: 'FE title', cwd: '/work/fe' }, { backend_key: 'native', session_id: 'saved-thread', dsh_session_id: 'saved', title: 'Saved FE', cwd: '/work/fe' }]
  const state = { 'session-index': { native_sessions: tabs }, workspaces: { global: { archivedSessionIds: ['archived'] } } }
  const publications = [], inspections = []
  const profiles = { binding: id => id === 'cold' ? { profile, threadId: 'thread' } : undefined, list: () => [profile], sharedState: { desktop_ids: { agent: 'native' } } }
  const services = {
    sessionController: { list: async () => ({ items }), inspect: async id => { inspections.push(id); return { events: [] } }, resolveAgent: () => { throw new Error('Listing must not start an Agent') } },
    agents: { get: () => undefined }, kodeAgents: { profiles, hasRuntime: () => true },
    workspaceRegistry: { archivedSessionIds: ['archived'], list: () => [] },
  }
  const backend = { call: async (path, body) => {
    if (path.includes('/documents/')) { const key = path.split('/').at(-1); if (body) state[key] = body.value; return { revision: 1, value: state[key] } }
    if (path.endsWith('/node')) return { node_id: 'fixture' }
    if (path.endsWith('/sessions')) return { sessions: [{ runtime: 'dsh', runtime_session_id: 'blank', status: 'idle' }, { runtime: 'dsh', runtime_session_id: 'archived', status: 'idle' }] }
    if (path.endsWith('/transcript')) return { available: true, timeline: [{ kind: 'text', role: 'user', text: 'Saved content' }] }
    if (path.endsWith('/publish')) { publications.push(body); return { sessions: [{ id: 100 }] } }
    throw new Error(path)
  } }
  return { bridge: new RuntimeBridge({ get: key => services[key], logger: { warn() {} } }, backend), publications, inspections, state, services }
}

test('mobile uses desktop titles and saved history, removes drafts and archives without activating agents', async () => {
  const f = fixture(); await f.bridge.publish()
  const rows = f.publications.flatMap(batch => batch.sessions)
  assert.deepEqual(rows.filter(row => row.dto.status === 'exited').map(row => row.session_id), ['blank', 'archived'])
  assert.deepEqual(rows.filter(row => row.dto.status !== 'exited').map(row => [row.session_id, row.dto.title]), [['cold', 'FE title'], ['saved', 'Saved FE']])
  assert.deepEqual(f.inspections, ['cold'])
  assert.equal(rows.find(row => row.session_id === 'saved').dto.runtime_saved, true)
  assert.ok(rows.find(row => row.session_id === 'saved').events.some(event => event.payload.text === 'Saved content'))
  f.publications.length = 0
  await f.bridge.execute({ id: 'delete', session_id: 'saved', kind: 'delete', payload: {} })
  assert.ok(f.state.workspaces.global.archivedSessionIds.includes('saved'))
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'saved' && row.dto.status === 'exited'))
})

test('a broken cold history does not starve later sessions or remove their titles', async () => {
  const f = fixture(); f.services.sessionController.inspect = async () => { throw new Error('Unreadable history') }
  await f.bridge.publish()
  assert.deepEqual(f.publications.flatMap(batch => batch.sessions).filter(row => row.dto.status !== 'exited').map(row => row.dto.title), ['FE title', 'Saved FE'])
})

test('a created blank stays retired until it has content and can still be archived', async () => {
  const f = fixture(); f.bridge.created.add('blank'); await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'exited'))
  f.services.sessionController.list = async () => ({ items: [{ sessionId: 'blank', blank: false, title: 'Started conversation' }] })
  f.services.sessionController.inspect = async () => ({ events: [{ seq: 0, type: 'user/message', data: { id: 'first', content: [{ type: 'text', text: 'Start' }] } }] })
  f.publications.length = 0
  await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'idle'))
  f.state.workspaces.global.archivedSessionIds.push('blank'); f.publications.length = 0
  await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'exited'))
})

test('cold setup-only records are drafts even when the cached blank flag is false', async () => {
  const f = fixture()
  f.services.sessionController.list = async () => ({ items: [{ sessionId: 'blank', blank: false }] })
  f.services.sessionController.inspect = async () => ({ events: [{ seq: 0, type: 'permission/preset', data: {} }, { seq: 1, type: 'sandbox/mode', data: {} }] })
  await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'exited'))
  assert.ok(!f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status !== 'exited'))
})

test('setup-only filtering preserves queued native sessions after projection isolation', async () => {
  const { isSetupOnlySession } = await import('../src/session-visibility.js')
  const observed = { events: [{ type: 'model/selection', data: {} }] }
  for (const key of ['inbox', 'kodeInbox']) {
    for (const target of ['next-turn', 'next-step']) {
      const row = { projections: { values: { [key]: { [target]: [{ id: 'queued-input' }] } } } }
      assert.equal(isSetupOnlySession(row, observed), false)
    }
  }
  assert.equal(isSetupOnlySession({ projections: { values: { kodeInbox: { 'next-turn': [], 'next-step': [] } } } }, observed), true)
})
