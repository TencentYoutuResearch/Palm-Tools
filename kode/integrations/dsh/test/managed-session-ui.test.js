import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagedSessionNavigation } from '../packages/collab/managed-session-navigation.js'
function fixture(options = {}) {
  const values = new Map(), selected = [], modes = [], effects = []
  const blocks = { set: (id, value) => { if (values.get(id)?.reason !== value?.reason) values.set(id, value) }, storeFor: id => ({ getSnapshot: () => values.get(id) }) }
  let refreshed = false
  const workspace = { openSession: id => { assert.equal(refreshed, true); selected.push(id) } }
  const sessions = { async refresh() { refreshed = true } }
  const api = createManagedSessionNavigation({ blocks, workspace, sessions, selectMode: mode => modes.push(mode), ...options })
  effects.push(api.close)
  const run = { id: 'run', team_id: 'team', home_hub: 'home' }
  const item = { assignment_id: 'assignment', worker: { session_id: 'worker', node_id: 'home' }, operation: { id: 'operation' } }
  const response = { scope: 'host_managed_session_binding', host: 'home', home_hub: 'home', session_id: 'worker', read_only: true,
    managed: { role: 'worker', assignment_id: 'assignment', operation_id: 'operation' } }
  return { values, selected, modes, effects, blocks, sessions, api, run, item, response }
}
test('native navigation proves the local Worker identity and blocks input before opening it', async t => {
  const f = fixture(), original = globalThis.fetch, requests = []
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (path, options) => { requests.push([path, options.method]); return { ok: true, json: async () => f.response } }
  await f.api.open(f.run, f.item)
  assert.deepEqual(f.selected, ['worker']); assert.deepEqual(f.modes, ['session'])
  assert.match(f.values.get('worker').reason, /只读排障/)
  f.api.block('worker', f.values.get('worker').reason)
  assert.deepEqual(requests, [['/api/kode/managed-session?session_id=worker', 'GET']])
  for (const dispose of f.effects) dispose()
  assert.equal(f.values.get('worker'), undefined)
})
test('foreign and unbound native Sessions cannot change navigation or input state', async t => {
  const f = fixture(), original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  for (const change of [{ host: 'foreign' }, { home_hub: 'foreign' }, { session_id: 'other' }, { read_only: false, managed: null },
    { managed: { assignment_id: 'other', operation_id: 'operation' } }, { managed: { assignment_id: 'assignment', operation_id: 'other' } }]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...f.response, ...change }) })
    await assert.rejects(f.api.open(f.run, f.item), /scope|ownership/)
  }
  assert.deepEqual(f.selected, []); assert.equal(f.values.size, 0)
})
test('native composer integration preserves another plugin blocker through open and disposal', async t => {
  const f = fixture(), original = globalThis.fetch, external = { reason: 'Existing host restriction' }
  t.after(() => { globalThis.fetch = original })
  f.blocks.set('worker', external)
  globalThis.fetch = async () => ({ ok: true, json: async () => f.response })
  await f.api.open(f.run, f.item)
  assert.equal(f.values.get('worker'), external)
  for (const dispose of f.effects) dispose()
  assert.equal(f.values.get('worker'), external)
  await assert.rejects(f.api.open(f.run, f.item), /disposed/)
})
test('catalog refresh failures and disposal cannot open a stale Worker selection', async t => {
  const f = fixture(), original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => ({ ok: true, json: async () => f.response })
  f.sessions.refresh = async () => { throw Error('Catalog unavailable') }
  await assert.rejects(f.api.open(f.run, f.item), /Catalog unavailable/)
  assert.deepEqual(f.selected, []); assert.equal(f.values.size, 0)
  f.sessions.refresh = async () => f.api.close()
  await assert.rejects(f.api.open(f.run, f.item), /disposed/)
  assert.deepEqual(f.selected, []); assert.equal(f.values.size, 0)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
test('newer Worker selection wins over late ownership responses without stale input or navigation effects', async t => {
  const f = fixture(), original = globalThis.fetch, reads = new Map()
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = (path, options) => { const row = { ...deferred(), signal: options.signal }; reads.set(new URL(path, 'http://fixture.invalid').searchParams.get('session_id'), row); return row.promise }
  const second = { ...f.item, worker: { ...f.item.worker, session_id: 'worker-b' } }
  const a = f.api.open(f.run, f.item), b = f.api.open(f.run, second)
  assert.equal(reads.get('worker').signal.aborted, true)
  reads.get('worker-b').resolve({ ok: true, json: async () => ({ ...f.response, session_id: 'worker-b' }) }); assert.equal(await b, true)
  reads.get('worker').resolve({ ok: true, json: async () => f.response }); assert.equal(await a, false)
  assert.deepEqual(f.selected, ['worker-b']); assert.deepEqual(f.modes, ['session']); assert.equal(f.values.has('worker'), false)
})
test('scope/panel dismissal invalidates an ownership read and an in-flight catalog refresh', async t => {
  const f = fixture(), original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const read = deferred(); globalThis.fetch = () => read.promise
  const first = f.api.open(f.run, f.item); f.api.invalidate()
  read.resolve({ ok: true, json: async () => f.response }); assert.equal(await first, false)
  const refresh = deferred(), entered = deferred()
  globalThis.fetch = async () => ({ ok: true, json: async () => f.response })
  f.sessions.refresh = async () => { entered.resolve(); await refresh.promise }
  const second = f.api.open(f.run, f.item); await entered.promise; f.api.invalidate(); refresh.resolve(); assert.equal(await second, false)
  assert.deepEqual(f.selected, []); assert.deepEqual(f.modes, []); assert.equal(f.values.size, 0)
})

const target = { scope: { home_hub: 'home', host_id: 'home', workspace_id: 'workspace', root_ref: '/fixture/project' }, teamId: 'team', runId: 'run' }
test('only a verified source open keeps a transient return target; returning rereads ownership and process access', async t => {
  const returned = [], reads = [], f = fixture({ returnProcess: { current: () => true, read: async value => { reads.push(value) }, open: value => returned.push(value) } })
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  let ownershipReads = 0
  globalThis.fetch = async () => { ownershipReads++; return { ok: true, json: async () => f.response } }
  await f.api.open(f.run, f.item); assert.equal(f.api.getSnapshot(), null, 'unknown direct source has no guessed return target')
  await f.api.open(f.run, f.item, target)
  assert.equal(f.api.getSnapshot().target.runId, 'run')
  assert.equal(await f.api.returnToProcess('other'), false)
  assert.equal(await f.api.returnToProcess('worker'), true)
  assert.equal(ownershipReads, 3); assert.deepEqual(reads, [target]); assert.deepEqual(returned, [target])
  assert.equal(f.api.getSnapshot(), null); assert.match(f.values.get('worker').reason, /只读/)
})
test('changed binding and denied process reads cannot restore old details or unblock native input', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  for (const failure of ['binding', 'permission']) {
    let returns = 0, reads = 0
    const f = fixture({ returnProcess: { current: () => true, read: async () => { reads++; throw Error('403') }, open: () => returns++ } })
    globalThis.fetch = async () => ({ ok: true, json: async () => f.response })
    await f.api.open(f.run, f.item, target)
    if (failure === 'binding') f.response.managed.operation_id = 'changed'
    await assert.rejects(f.api.returnToProcess('worker'), /ownership|403/)
    assert.equal(returns, 0); assert.equal(reads, failure === 'binding' ? 0 : 1); assert.equal(f.api.getSnapshot(), null)
    assert.match(f.values.get('worker').reason, /只读/)
  }
})
test('invalidation and newer session navigation discard an in-flight return read', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  for (const action of ['invalidate', 'new-session', 'close']) {
    const started = deferred(), pending = deferred(); let returns = 0
    const f = fixture({ returnProcess: { current: () => true, read: async () => { started.resolve(); await pending.promise }, open: () => returns++ } })
    globalThis.fetch = async path => ({ ok: true, json: async () => ({ ...f.response, session_id: new URL(path, 'http://fixture.invalid').searchParams.get('session_id') }) })
    await f.api.open(f.run, f.item, target)
    const back = f.api.returnToProcess('worker'); await started.promise
    if (action === 'new-session') await f.api.open(f.run, { ...f.item, worker: { ...f.item.worker, session_id: 'worker-b' } }, { ...target, taskId: 'task-b', contextId: 'context-b' })
    else f.api[action]()
    pending.resolve(); assert.equal(await back, false); assert.equal(returns, 0)
    if (action === 'new-session') assert.equal(f.api.getSnapshot().sessionId, 'worker-b')
    else assert.equal(f.api.getSnapshot(), null)
  }
})

test('generic owner targets retain newly verified task identity, and checked returns cannot change run/team/scope', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  const verified = { ...target, taskId: 'task', contextId: 'context' }, opened = []
  const f = fixture({ returnProcess: { current: () => true, read: async () => verified, open: value => opened.push(value) } })
  globalThis.fetch = async () => ({ ok: true, json: async () => f.response })
  await f.api.open(f.run, f.item, target);await f.api.returnToProcess('worker')
  assert.deepEqual(opened, [verified])
  for (const change of [{runId:'other'}, {teamId:'other'}, {scope:{...target.scope,root_ref:'/other'}}, {taskId:'other'}, {contextId:'other'}]) {
    const bad = fixture({ returnProcess: { current: () => true, read: async () => ({...verified,...change}), open: () => assert.fail('must not navigate') } })
    await bad.api.open(bad.run,bad.item,verified)
    await assert.rejects(bad.api.returnToProcess('worker'),/identity/)
    assert.match(bad.values.get('worker').reason,/只读/)
  }
})
test('Orbit presents the verified, blocked Worker Session in its own tab without session mode or a process return', async t => {
  const f = fixture(), original = globalThis.fetch, presented = []
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => ({ ok: true, json: async () => f.response })
  assert.equal(await f.api.open(f.run, f.item, null, { present: id => presented.push(id) }), true)
  assert.deepEqual(presented, ['worker']); assert.deepEqual(f.selected, []); assert.deepEqual(f.modes, [])
  assert.match(f.values.get('worker').reason, /只读排障/, 'input stays blocked in the tab too')
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...f.response, host: 'foreign' }) })
  await assert.rejects(f.api.open(f.run, f.item, null, { present: id => presented.push(id) }), /scope|ownership/)
  assert.deepEqual(presented, ['worker'], 'a foreign Session is never presented')
})
