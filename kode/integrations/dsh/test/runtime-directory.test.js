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
    sessionController: { list: async () => ({ items }), inspect: async id => { inspections.push(id); return { inheritedEventCount: 0, events: [] } }, resolveAgent: () => { throw new Error('Listing must not start an Agent') } },
    agents: { get: () => undefined }, kodeAgents: { profiles, hasRuntime: () => true },
    workspaceRegistry: { archivedSessionIds: ['archived'], list: () => [], archiveSession: async (id, options) => { assert.deepEqual(options, { stopActivity: true }); state.workspaces.global.archivedSessionIds.push(id) } },
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
  await f.bridge.execute({ id: 'retry-delete', session_id: 'saved', kind: 'delete', payload: {} })
  assert.equal(f.state.workspaces.global.archivedSessionIds.filter(id => id === 'saved').length, 1, 'archival stays idempotent')
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'saved' && row.dto.status === 'exited'))
})

test('a broken cold history does not starve later sessions or remove their titles', async () => {
  const f = fixture(); f.services.sessionController.inspect = async () => { throw new Error('Unreadable history') }
  await f.bridge.publish()
  assert.deepEqual(f.publications.flatMap(batch => batch.sessions).filter(row => row.dto.status !== 'exited').map(row => row.dto.title), ['FE title', 'Saved FE'])
})

test('a previously published blank stays retired until it has content and can still be archived', async () => {
  const f = fixture(); await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'exited'))
  f.services.sessionController.list = async () => ({ items: [{ sessionId: 'blank', blank: false, title: 'Started conversation' }] })
  f.services.sessionController.inspect = async () => ({ events: [{ seq: 0, type: 'user/message', data: { id: 'first', content: [{ type: 'text', text: 'Start' }] } }] })
  f.publications.length = 0
  await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'idle'))
  f.publications.length = 0
  await f.bridge.execute({ id: 'archive-started', session_id: 'blank', kind: 'delete', payload: {} })
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'exited'))
})

test('cold setup-only records are drafts even when the cached blank flag is false', async () => {
  const f = fixture()
  f.services.sessionController.list = async () => ({ items: [{ sessionId: 'blank', blank: false }] })
  f.services.sessionController.inspect = async () => ({ inheritedEventCount: 0, events: [{ seq: 0, type: 'permission/preset', data: {} }, { seq: 1, type: 'sandbox/mode', data: {} }] })
  await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status === 'exited'))
  assert.ok(!f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'blank' && row.dto.status !== 'exited'))
})

test('setup-only filtering preserves queued native sessions after projection isolation', async () => {
  const { isSetupOnlySession } = await import('../src/session-visibility.js')
  const observed = { inheritedEventCount: 0, events: [{ type: 'model/selection', data: {} }] }
  for (const key of ['inbox', 'kodeInbox']) {
    for (const target of ['next-turn', 'next-step']) {
      const row = { projections: { values: { [key]: { [target]: [{ id: 'queued-input' }] } } } }
      assert.equal(isSetupOnlySession(row, observed), false)
    }
  }
  assert.equal(isSetupOnlySession({ projections: { values: { kodeInbox: { 'next-turn': [], 'next-step': [] } } } }, observed), true)
})


test('unknown inheritance metadata is not proof of an empty cold conversation', async () => {
  const f = fixture()
  f.services.sessionController.list = async () => ({ items: [{ sessionId: 'unknown', blank: false }] })
  f.services.sessionController.inspect = async () => ({ events: [{ seq: 0, type: 'permission/preset', data: {} }] })
  await f.bridge.publish()
  assert.ok(f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'unknown' && row.dto.status !== 'exited'))
})

test('history failures retain the cursor and later recover without replaying delivered messages', async () => {
  const f = fixture(), events = [{ seq: 0, type: 'user/message', data: { id: 'first', content: [{ type: 'text', text: 'first' }] } }]
  f.services.sessionController.list = async () => ({ items: [{ sessionId: 'cold', title: 'Current title', cwd: '/work/fe' }] })
  let unavailable = false
  f.services.sessionController.inspect = async () => { if (unavailable) throw Error('offline history'); return { inheritedEventCount: 0, events } }
  await f.bridge.publish()
  assert.equal(f.bridge.cursors.get('cold'), 0)
  unavailable = true; f.publications.length = 0; await f.bridge.publish()
  assert.equal(f.bridge.cursors.get('cold'), 0)
  assert.ok(!f.publications.flatMap(batch => batch.sessions).some(row => row.session_id === 'cold' && row.dto.status === 'exited'))
  unavailable = false; events.push({ seq: 1, type: 'user/message', data: { id: 'second', content: [{ type: 'text', text: 'second' }] } })
  f.publications.length = 0; await f.bridge.publish()
  assert.deepEqual(f.publications.flatMap(batch => batch.sessions).find(row => row.session_id === 'cold').events.filter(event => event.kind === 'message').map(event => event.payload.text), ['second'])
  assert.equal(f.bridge.cursors.get('cold'), 1)
})


test('queued work and a native thread survive a settings-only local snapshot', async () => {
  for (const [id,projections] of [['cold',{}],['queued',{values:{kodeInbox:{'next-turn':[{id:'input'}]}}}]]) {
    const f=fixture()
    f.services.sessionController.list=async()=>({items:[{sessionId:id,blank:false,projections}]})
    f.services.sessionController.inspect=async()=>({inheritedEventCount:0,events:[{seq:0,type:'permission/preset',data:{}}]})
    await f.bridge.publish()
    assert.ok(f.publications.flatMap(batch=>batch.sessions).some(row=>row.session_id===id&&row.dto.status!=='exited'),id)
  }
})
