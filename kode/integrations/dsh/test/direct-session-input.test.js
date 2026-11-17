import test from 'node:test'
import assert from 'node:assert/strict'
import { interruptAndInsert } from '../src/direct-session-input.js'
function fixture({ running = true, confirmed = true, managed = false } = {}) {
  const log = [], queue = [{ id: 'older' }], calls = []
  const recordEvent = (_session, type, data) => { const seq = log.length; log.push({ seq, type, data }); return seq }
  const agent = { id: 'target', isKodeNativeAgent: true, status: running ? 'running' : 'idle',
    runtime: { profiles: { binding: () => managed ? { managedOperation: {} } : {} }, adapter: { stopBlocked: () => false } },
    session: { snapshotEvents: () => log }, ctx: { sessions: { flush: async () => { calls.push('flush') } } },
    inbox: { prepend: (_kind, m) => { queue.unshift(m); calls.push('insert') } },
    cancel(cause, options) { calls.push('cancel'); assert.equal(options.keepInbox, true); assert.equal(cause.kind, 'direct_insert') },
    async whenIdle() { agent.status = 'idle'; if (confirmed) recordEvent(null, 'plugin:kode/native-event', { event: { method: 'kode/process_stop', params: { spawned: true, leader_exited: true, signal_scope: 'process_group', process_group_empty: true, signal_failures: [], stopBlocked: false } } }) },
    wake() { calls.push('wake') },
  }
  return { agent, queue, calls, log, options: { recordEvent }, message: { id: 'new' } }
}
test('interrupt waits for fresh process-group stop then inserts ahead without dropping queue', async () => {
  const f = fixture()
  const result = await interruptAndInsert(f.agent, f.message, f.options)
  assert.deepEqual(result, { state: 'inserted', interrupted: true })
  assert.deepEqual(f.queue.map(x => x.id), ['new', 'older'])
  assert.ok(f.calls.indexOf('cancel') < f.calls.indexOf('insert'))
  assert.deepEqual(f.log.filter(e => e.type === 'plugin:kode/direct-insert').map(e => e.data.stage), ['prepared', 'stop_requested', 'stop_confirmed', 'inserted'])
  const replay = await interruptAndInsert(f.agent, f.message, f.options)
  assert.equal(replay.replay, true); assert.equal(f.calls.filter(x => x === 'cancel').length, 1)
})
test('idle direct insert starts without claiming a nonexistent interruption', async () => {
  const f = fixture({ running: false })
  assert.equal((await interruptAndInsert(f.agent, f.message, f.options)).interrupted, false)
  assert.ok(!f.calls.includes('cancel'))
})
test('unconfirmed stop parks session, preserves prior queue and never retries intent', async () => {
  const f = fixture({ confirmed: false })
  await assert.rejects(interruptAndInsert(f.agent, f.message, f.options), /unconfirmed/)
  assert.deepEqual(f.queue.map(x => x.id), ['older']); assert.equal(f.agent.parked, true)
  await assert.rejects(interruptAndInsert(f.agent, f.message, f.options), /unavailable|Earlier/)
  assert.equal(f.calls.filter(x => x === 'cancel').length, 1)
})
test('unsupported managed sessions reject before any side effect', async () => {
  const f = fixture({ managed: true })
  await assert.rejects(interruptAndInsert(f.agent, f.message, f.options), { code: 'DIRECT_INSERT_UNSUPPORTED' })
  assert.deepEqual(f.calls, []); assert.deepEqual(f.log, [])
})
test('revoked admission after stop is uncertain, not a false no-side-effect rejection', async () => {
  const f = fixture(); let checks = 0
  await assert.rejects(interruptAndInsert(f.agent, f.message, { ...f.options, beforeInsert: () => { if (++checks === 1) return; throw Object.assign(new Error('grant withdrawn'), { code: 'DIRECT_INSERT_UNSUPPORTED' }) } }), { code: 'DIRECT_INSERT_UNCERTAIN' })
  assert.deepEqual(f.queue.map(x => x.id), ['older']); assert.equal(f.agent.parked, true)
})
test('stop timeout does not insert or drain old input', async () => {
  const f = fixture(); f.agent.whenIdle = () => new Promise(() => {})
  await assert.rejects(interruptAndInsert(f.agent, f.message, { ...f.options, timeoutMs: 5 }), /timed out/)
  assert.deepEqual(f.queue.map(x => x.id), ['older']); assert.equal(f.agent.parked, true)
})
test('production plugin records use numeric sequence and survive real Session restore', async () => {
  const { Session, appendPluginRecord } = await import('@deepseek-ai/dsh-session')
  const f = fixture(); f.agent.session = Session.create('direct-insert-fixture', [])
  f.agent.whenIdle = async () => { f.agent.status = 'idle'; appendPluginRecord(f.agent.session, 'plugin:kode/native-event', { event: { method: 'kode/process_stop', params: { spawned: true, leader_exited: true, signal_scope: 'process_group', process_group_empty: true, signal_failures: [], stopBlocked: false } } }) }
  await interruptAndInsert(f.agent, f.message)
  const saved = f.agent.session.snapshotEvents()
  f.agent.session = Session.create('direct-insert-restored', saved)
  assert.equal((await interruptAndInsert(f.agent, f.message)).replay, true)
  assert.equal(f.calls.filter(x => x === 'cancel').length, 1)
})
test('natural completion during prepared flush does not cancel or fence', async () => {
  const f = fixture(); let first = true
  f.agent.ctx.sessions.flush = async () => { if (first) { first = false; f.agent.status = 'idle' } }
  assert.equal((await interruptAndInsert(f.agent, f.message, f.options)).interrupted, false)
  assert.equal(f.calls.includes('cancel'), false); assert.equal(f.agent.directInsertBlocked, undefined)
  assert.deepEqual(f.queue.map(x => x.id), ['new', 'older'])
})
test('authority withdrawal before stop rejects without cancelling or fencing', async () => {
  const f = fixture()
  await assert.rejects(interruptAndInsert(f.agent, f.message, { ...f.options, beforeInsert: () => { throw Object.assign(new Error('withdrawn'), { code: 'DIRECT_INSERT_UNSUPPORTED' }) } }), { code: 'DIRECT_INSERT_UNSUPPORTED' })
  assert.equal(f.calls.includes('cancel'), false); assert.equal(f.agent.directInsertBlocked, undefined)
  assert.deepEqual(f.queue.map(x => x.id), ['older'])
})
test('native drive checks maintenance before claiming another queued turn', async () => {
  const { NativeAgentDriver } = await import('../src/native-agent-driver.js')
  let claimed = false
  const agent = { maintenance: true, runtime: { profiles: { binding: () => ({}) }, adapter: { stopBlocked: () => false } }, inbox: { nextTurn: [{}], nextStep: [], claim() { claimed = true } } }
  await NativeAgentDriver.prototype.drive.call(agent, new AbortController().signal)
  assert.equal(claimed, false)
})
