import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollabOutbox } from '../packages/collab/outbox.js'
const team = { id: 'team', home_hub: 'home', superagent_id: 'super', conversation_id: 'conversation' }
function memoryStorage() {
  const rows = new Map()
  return { rows, async read(key) { return rows.get(key) ?? null }, async reserve(key, row) { const prior = rows.get(key); if (prior && prior.state !== 'accepted') return prior; rows.set(key, structuredClone(row)); return row }, async save(key, row) { assert.equal(rows.get(key).request_id, row.request_id); rows.set(key, structuredClone(row)) } }
}
const receipt = body => ({ ...body, id: 'message', home_hub: team.home_hub, team_id: team.id, superagent_id: team.superagent_id, actor: { kind: 'human' }, state: 'accepted' })
test('lost send response recovers its receipt after reconstruction without a duplicate POST', async () => {
  const storage = memoryStorage(), calls = []; let committed
  const request = async (path, options) => { calls.push({ path, body: options.body }); if (options.body) { committed = receipt(options.body); throw Error('response lost') } return { message: committed } }
  let box = createCollabOutbox({ storage, request, uuid: () => 'original' })
  const first = await box.send(team, '实现这个需求'); assert.equal(first.state, 'unconfirmed'); box.dispose()
  box = createCollabOutbox({ storage, request, uuid: () => 'must-not-be-used' })
  await box.load(team); const recovered = await box.retry(team)
  assert.equal(recovered.state, 'accepted'); assert.equal(recovered.request_id, 'original')
  assert.equal(calls.filter(call => call.body).length, 1); assert.match(calls[1].path, /request_id=original/)
})
test('missing receipt retries the exact original message and cannot replace unresolved content', async () => {
  const storage = memoryStorage(), bodies = []; let online = false
  const box = createCollabOutbox({ storage, uuid: () => 'fixed', request: async (_, { body }) => { if (!online) throw Error('offline'); if (!body) return { message: null }; bodies.push(body); return receipt(body) } })
  await box.send(team, '原消息'); await assert.rejects(box.send(team, '替换内容'), /上一条/)
  online = true; const result = await box.retry(team)
  assert.equal(result.state, 'accepted'); assert.deepEqual(bodies, [{ conversation_id: 'conversation', request_id: 'fixed', content: '原消息' }])
})
test('storage must commit before dispatch; foreign receipts remain unconfirmed', async () => {
  let calls = 0
  const denied = createCollabOutbox({ storage: { reserve() { throw Error('full') } }, uuid: () => 'fixed', request: () => { calls++ } })
  await assert.rejects(denied.send(team, 'hello')); assert.equal(calls, 0)
  const storage = memoryStorage(), box = createCollabOutbox({ storage, uuid: () => 'fixed', request: async (_, { body }) => ({ ...receipt(body), home_hub: 'foreign' }) })
  assert.equal((await box.send(team, 'hello')).state, 'unconfirmed')
  assert.equal(storage.rows.values().next().value.state, 'unconfirmed')
})
test('send waits for initial read and duplicate clicks share one dispatch', async () => {
  const storage = memoryStorage(); let resolveRead, sends = 0, release
  storage.read = () => new Promise(resolve => { resolveRead = resolve })
  const box = createCollabOutbox({ storage, uuid: () => 'fixed', request: async (_, { body }) => { sends++; await new Promise(resolve => { release = resolve }); return receipt(body) } })
  const loading = box.load(team); await Promise.resolve()
  const sending = box.send(team, 'hello'); resolveRead(null); await loading
  await new Promise(resolve => setImmediate(resolve))
  const duplicate = box.send(team, 'hello'); assert.equal(sends, 1)
  release(); assert.equal((await sending).state, 'accepted'); assert.equal((await duplicate).request_id, 'fixed'); assert.equal(sends, 1)
})
test('disposal during durable preparation prevents a late dispatch', async () => {
  let finish, calls = 0
  const box = createCollabOutbox({ storage: { reserve: (_, row) => new Promise(resolve => { finish = () => resolve(row) }) }, uuid: () => 'fixed', request: () => { calls++ } })
  const pending = box.send(team, 'hello'); await Promise.resolve(); box.dispose(); finish()
  assert.equal((await pending).state, 'prepared'); assert.equal(calls, 0)
})

test('follow-up reference survives reconstruction and cannot be replaced or omitted in a receipt', async () => {
  const storage = memoryStorage(), bodies = []; let online = false, omit = true
  const request = async (_, { body }) => {
    if (!online) throw Error('offline')
    if (!body) return { message: null }
    bodies.push(body)
    const result = receipt(body); if (omit) delete result.prior_run_id
    return result
  }
  let box = createCollabOutbox({ storage, request, uuid: () => 'followup' })
  await box.send(team, '按反馈修改', { prior_run_id: 'old-run' })
  await assert.rejects(box.send(team, '按反馈修改'), /上一条/)
  await assert.rejects(box.send(team, '按反馈修改', { prior_run_id: 'other-run' }), /上一条/)
  box.dispose(); box = createCollabOutbox({ storage, request })
  await box.load(team); online = true
  assert.equal((await box.retry(team)).state, 'unconfirmed')
  omit = false
  assert.equal((await box.retry(team)).state, 'accepted')
  assert.deepEqual(bodies[0], bodies[1])
  assert.equal(bodies[1].prior_run_id, 'old-run')
  assert.equal(bodies[1].request_id, 'followup')
})
