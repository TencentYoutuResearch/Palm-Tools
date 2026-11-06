import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteAssignmentDiscovery } from '../src/remote-assignment-discovery.js'
const operation = home => ({ id: 'op', attempt: 1, epoch: 1, home_node: home })
function fixture(prepare = async () => ({})) {
  const seen = [], calls = []
  const dispatcher = { host: { stop: new AbortController(), execution: { host: 'remote', client: { async call(path, body) {
    if (path.endsWith('/hosts')) return { local_node_id: 'remote', hosts: [{ node_id: 'b' }, { node_id: 'a' }] }
    const home = path.split('/').at(-1), id = body.accounting.action.assignment_id
    return { id, worker: { node_id: 'remote', session_id: id }, bundle: { operation: operation(home) }, dispatch: { command: { operation: operation(home) } } }
  } } } }, async discoverRemote(home, { after }) {
    calls.push([home, after]); return { items: ['one', 'three', 'two'].filter(id => !after || id > after).map(id => ({ assignment_id: id, worker_session: id, operation: operation(home) })), next_cursor: null }
  }, async dispatch(id, options) { seen.push([options.homeScope.operation.home_node, id]); return { state: 'created' } } }
  return { dispatcher, seen, calls, service: new RemoteAssignmentDiscovery(dispatcher, { batchSize: 1, prepare }) }
}
test('remote discovery rotates homes and advances only processed items without skipping a partial page', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 8; i++) await f.service.scan()
    assert.deepEqual(f.seen, [['a','one'],['b','one'],['a','three'],['b','three'],['a','two'],['b','two'],['a','one'],['b','one']])
    assert.deepEqual(f.calls.slice(2, 6), [['a','one'],['b','one'],['a','three'],['b','three']])
  } finally { await f.service.close() }
})
test('closing discovery during preparation prevents creation and joins the coalesced scan', async () => {
  let release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const f = fixture(async () => { entered(); await new Promise(resolve => { release = resolve }); return {} })
  const first = f.service.scan(); assert.equal(f.service.scan(), first)
  await waiting
  const closed = f.service.close(); release()
  await assert.rejects(first, /Remote discovery closed/); await closed
  assert.deepEqual(f.seen, [])
  await assert.rejects(f.service.scan(), /closed/)
})
test('remote preparation failures do not starve another paired home or leak errors', async () => {
  const f = fixture(async () => { throw new Error('private adapter diagnostic') })
  try {
    assert.equal((await f.service.scan())[0].state, 'remote_discovery_failed')
    assert.equal((await f.service.scan())[0].home_hub, 'b')
    assert.deepEqual(f.seen, [])
  } finally { await f.service.close() }
})
