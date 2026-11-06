/** Transport observations through actual paired Hubs; never starts a runtime. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
const path = '/api/v1/messaging/workbench/communication-health'
test('owner transport health tracks handshake, peer death and reconnect without starting work', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const home = await isolatedHub('health-home'), remote = await isolatedHub('health-remote')
  const wait = async (hub, state) => {
    for (let index = 0; index < 150; index++) {
      const value = await hub.client.call(path)
      if (value.peers[0]?.state === state) return value
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    assert.fail(`Expected transport state: ${state}`)
  }
  try {
    const registered = await home.client.call('/api/v1/messaging/sessions', { session_id: 'observer', title: 'Observer', runtime: 'external' })
    const session = home.client.forSession(registered.owner_token)
    await assert.rejects(session.call(path), /403.*administrator required/)
    const empty = await home.client.call(path)
    assert.equal(empty.hub, 'responding'); assert.deepEqual(empty.peers, [])
    await pairHubs(home, remote)
    const connected = await wait(home, 'connected'); await wait(remote, 'connected')
    assert.deepEqual(connected.peers[0].protocol_versions, [2])
    assert.equal(connected.scope, 'local_transport_observation')
    assert.ok(connected.limitations.includes('connected_is_not_worker_ready'))
    assert.deepEqual(Object.keys(connected.peers[0]).sort(), ['connections', 'last_received_at', 'node_id', 'protocol_versions', 'recent_connections', 'state'])
    await remote.stop('SIGKILL')
    const disconnected = await wait(home, 'not_connected')
    assert.equal(disconnected.peers[0].connections, 0)
    assert.equal(disconnected.peers[0].last_received_at, null)
    await remote.start(); await wait(home, 'connected')
    const diagnostics = await session.call('/api/v1/messaging/sessions/observer/diagnostics')
    assert.deepEqual(diagnostics.incoming.counts, {}); assert.deepEqual(diagnostics.outgoing.counts, {})
    assert.equal(diagnostics.runtime_liveness, 'not_probed')
  } finally { await home.close(); await remote.close() }
})
