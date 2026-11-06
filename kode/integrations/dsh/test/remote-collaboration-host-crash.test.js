/** Two-Hub/two-Host recovery, optionally through the explicit disposable SSH fixture. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { collaborationHost } from './support/collaboration-host.js'
import { openKodeTunnel } from '../src/project-hosts.js'
import { fileURLToPath } from 'node:url'

for (const running of [false, true, 'native']) test(`remote creation response loss and two-Host crash retain Worker, assignment and cancellation (running=${running})`, { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 60000 }, async t => {
  const home = await isolatedHub('creation-home'), worker = await isolatedHub('creation-worker')
  const sender = collaborationHost(home), receiver = collaborationHost(worker, { native: running === 'native' })
  let tunnel
  const connect = async remote => {
    await tunnel?.close()
    tunnel = undefined
    if (process.env.KODE_TEST_SSH_CONFIG) {
      tunnel = await openKodeTunnel(fileURLToPath(new URL('../../../target/debug/kode-ssh-tunnel', import.meta.url)), {
        host: 'messaging.example', port: Number(process.env.KODE_TEST_SSH_PORT),
        remote_port: Number(new URL(remote.url).port), config_file: process.env.KODE_TEST_SSH_CONFIG,
      })
    }
    return sender.call('connect-fixture', { url: tunnel?.url ?? remote.url, tokenFile: join(worker.root, 'admin.token') })
  }
  try {
    await pairHubs(home, worker)
    await sender.start()
    const remote = await receiver.start()
    await connect(remote)
    for (const path of ['/api/kode/session-create', '/api/kode/session-creation-status']) {
      const denied = await fetch(`${remote.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      assert.equal(denied.status, 403)
      await denied.body.cancel()
    }
    const input = { title: 'Remote helper', task: running === 'native' ? 'WAIT' : 'Inspect remote fixture', host: 'Remote fixture', workspace_id: remote.workspace, idempotency_key: 'remote-work', model: 'fixture' }
    await receiver.call('drop-creation-response')
    await assert.rejects(sender.call('kode_sessions_create', input), /fetch failed/)
    const status = await sender.call('kode_sessions_creation_status', { host: input.host, idempotency_key: input.idempotency_key })
    assert.equal(status.status, 'completed')
    assert.equal(status.address.node_id, worker.node)
    const assigned = await sender.call('kode_sessions_create', input)
    assert.deepEqual(assigned.address, status.address)
    const message_id = assigned.assignment.id
    const queued = await sender.wait('kode_sessions_delivery_status', { message_id }, value => value.delivery?.phase === 'queued')
    const session_id = assigned.address.session_id
    let stopObservation
    const snapshot = await receiver.call('snapshot', { session_id })
    assert.deepEqual(snapshot.queued, [queued.delivery.input_id]); assert.equal(snapshot.consumed, 0)
    assert.deepEqual(new Set(snapshot.stored), new Set(['coordinator', session_id]))
    await sender.kill(); await receiver.kill(); await home.stop('SIGKILL'); await worker.stop('SIGKILL')
    await home.start(); await worker.start(); await sender.start(); await connect(await receiver.start())
    await receiver.wait('live', { session_id }, value => value.active)
    const retried = await sender.call('kode_sessions_create', input)
    assert.deepEqual(retried.address, assigned.address); assert.equal(retried.assignment.id, message_id)
    assert.deepEqual(await receiver.call('snapshot', { session_id }), snapshot)
    await assert.rejects(sender.call('kode_sessions_create', { ...input, task: 'Changed task' }), /different task/)
    // Wait for capabilities/mirrors to reconnect before exercising remote control.
    await sender.wait('kode_sessions_delivery_status', { message_id }, value => value.delivery?.phase === 'queued')
    if (running) {
      await receiver.call('enable-execution', { session_id })
      const consumed = await sender.wait('kode_sessions_delivery_status', { message_id }, value => value.delivery?.phase === 'consumed')
      assert.equal(consumed.delivery.input_id, queued.delivery.input_id)
      const active = await receiver.call('snapshot', { session_id })
      assert.equal(active.consumed, 1); assert.deepEqual(active.queued, [])
      if (running === 'native') await receiver.wait('native-ready', { session_id }, value => value.ready)
      assert.deepEqual(await receiver.call('execution-state'), { starts: 1, aborts: 0 })
    }
    await sender.call('kode_sessions_cancel_input', { message_id })
    const expectedCancellation = running ? 'cancel_unconfirmed' : 'queued_removed'
    await sender.wait('kode_sessions_cancellation_status', { message_id }, value => value.cancellation?.state === expectedCancellation)
    if (running) await receiver.wait('execution-state', {}, value => value.aborts === 1)
    if (running === 'native') {
      const observations = await receiver.call('stop-observation', { session_id })
      assert.equal(observations.length, 1)
      stopObservation = observations[0]
      assert.deepEqual(observations[0].inputIds, [queued.delivery.input_id])
      assert.equal(observations[0].leader_exited, true)
      assert.equal(observations[0].process_group_empty, true)
      assert.equal(observations[0].descendants_confirmed, false)
    }
    await sender.kill(); await receiver.kill(); await home.stop('SIGKILL'); await worker.stop('SIGKILL')
    await home.start(); await worker.start(); await sender.start(); await connect(await receiver.start())
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.deepEqual(await receiver.call('live', { session_id }), { active: false })
    assert.equal((await sender.call('kode_sessions_cancellation_status', { message_id })).cancellation.state, expectedCancellation)
    assert.equal((await sender.call('kode_sessions_create', input)).assignment.id, message_id)
    const cancelled = await receiver.call('snapshot', { session_id })
    assert.deepEqual(cancelled.queued, []); assert.equal(cancelled.consumed, running ? 1 : 0)
    assert.deepEqual(await receiver.call('execution-state'), { starts: 0, aborts: 0 })
    if (running) {
      assert.equal((await sender.call('kode_sessions_delivery_status', { message_id })).delivery.phase, 'consumed')
      assert.deepEqual(await receiver.call('cancel-runtime-input', { session_id, input_id: queued.delivery.input_id }), { state: 'cancel_unconfirmed', reason: 'stop_requested' })
      assert.deepEqual(await receiver.call('execution-state'), { starts: 0, aborts: 0 })
      if (running === 'native') assert.deepEqual(await receiver.call('stop-observation', { session_id }), [stopObservation])
    }
    t.diagnostic(JSON.stringify({ transport: process.env.KODE_TEST_SSH_CONFIG ? 'actual_openssh' : 'loopback_http',
      hub_link: process.env.KODE_TEST_SSH_CONFIG ? 'ssh' : 'http', owner_creation_transport: tunnel ? 'ssh' : 'http',
      same_machine: true, running, cancellation: expectedCancellation }))
  } finally { await sender.kill(); await receiver.kill(); await tunnel?.close(); await home.close(); await worker.close() }
})
