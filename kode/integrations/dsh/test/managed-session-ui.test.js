import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagedSessionNavigation } from '../packages/collab/managed-session-navigation.js'
function fixture() {
  const values = new Map(), selected = [], modes = [], effects = []
  const blocks = { set: (id, value) => { if (values.get(id)?.reason !== value?.reason) values.set(id, value) }, storeFor: id => ({ getSnapshot: () => values.get(id) }) }
  let refreshed = false
  const workspace = { openSession: id => { assert.equal(refreshed, true); selected.push(id) } }
  const sessions = { async refresh() { refreshed = true } }
  const api = createManagedSessionNavigation({ blocks, workspace, sessions, selectMode: mode => modes.push(mode) })
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
