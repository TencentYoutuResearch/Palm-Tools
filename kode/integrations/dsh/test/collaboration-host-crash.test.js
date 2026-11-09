/** Crosses actual tool/controller/Hub/workspace/native JSONL persistence boundaries. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isolatedHub } from './support/isolated-hub.js'

test('creation tool recovers original assignment and Worker across actual Host and Hub SIGKILL', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 40000 }, async () => {
  const hub = await isolatedHub('host-crash')
  let child, next = 0, generation = 0
  const receive = (phase, match, send) => new Promise((resolve, reject) => {
    const current = child
    const timer = setTimeout(() => {
      finish(new Error(`Host fixture timed out during ${phase} in generation ${generation}`
        + ` (connected=${current.connected}, exit=${current.exitCode}, signal=${current.signalCode})`))
    }, 10000)
    function finish(error, value) { clearTimeout(timer); current.off('message', message); current.off('exit', exited); error ? reject(error) : resolve(value) }
    const message = value => { if (value.type === 'error') finish(new Error(value.error)); else if (match(value)) finish(value.error ? new Error(value.error) : null, value) }
    const exited = () => finish(new Error('Host fixture exited'))
    current.on('message', message); current.once('exit', exited); send?.()
  })
  const start = async () => {
    generation++
    child = fork(fileURLToPath(new URL('./fixture-collaboration-host.js', import.meta.url)), [hub.root, hub.url, join(hub.root, 'admin.token'), hub.node], { execPath: process.env.KODE_TEST_HOST_NODE ?? process.execPath, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    return receive('startup', value => value.type === 'ready')
  }
  const call = async (name, args, dropAssignment = false) => { const id = ++next; return (await receive(name, value => value.id === id, () => child.send({ id, name, args, dropAssignment }))).result }
  const kill = async () => { if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit } }
  const wait = async (name, args, predicate) => { for (let i = 0; i < 100; i++) { const value = await call(name, args); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)) }; assert.fail('Expected durable state') }
  try {
    const first = await start()
    const input = { title: 'Helper', task: 'Inspect fixture', idempotency_key: 'same-work', workspace_id: first.workspace }
    await assert.rejects(call('kode_sessions_create', input, true), /lost assignment response/)
    const saved = await call('kode_sessions_creation_status', { idempotency_key: input.idempotency_key })
    assert.equal(saved.status, 'completed')
    const assigned = await call('kode_sessions_create', input)
    const message_id = assigned.assignment.id
    const queued = await wait('kode_sessions_delivery_status', { message_id }, value => value.delivery?.phase === 'queued')
    const snapshot = await call('snapshot', { session_id: assigned.address.session_id })
    assert.deepEqual(snapshot.queued, [queued.delivery.input_id]); assert.equal(snapshot.consumed, 0)
    assert.deepEqual(new Set(snapshot.stored), new Set(['coordinator', assigned.address.session_id]))
    await kill(); await hub.stop('SIGKILL'); await hub.start()
    assert.equal((await start()).workspace, first.workspace)
    await wait('live', { session_id: assigned.address.session_id }, value => value.active)
    const retried = await call('kode_sessions_create', input)
    assert.deepEqual(retried.address, assigned.address); assert.equal(retried.assignment.id, message_id)
    const restored = await call('snapshot', { session_id: assigned.address.session_id })
    assert.deepEqual(restored, snapshot)
    await call('kode_sessions_cancel_input', { message_id })
    await wait('kode_sessions_cancellation_status', { message_id }, value => value.cancellation?.state === 'queued_removed')
    await kill(); await hub.stop('SIGKILL'); await hub.start(); await start()
    // Let several automatic wake scans run; terminal cancellation must stay cold.
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.deepEqual(await call('live', { session_id: assigned.address.session_id }), { active: false })
    const cancelled = await call('snapshot', { session_id: assigned.address.session_id })
    assert.deepEqual(cancelled.queued, []); assert.equal(cancelled.consumed, 0)
    assert.equal((await call('kode_sessions_cancellation_status', { message_id })).cancellation.state, 'queued_removed')
    assert.equal((await call('kode_sessions_create', input)).assignment.id, message_id)
    assert.deepEqual((await call('snapshot', { session_id: assigned.address.session_id })).queued, [])
  } finally { await kill(); await hub.close() }
})
