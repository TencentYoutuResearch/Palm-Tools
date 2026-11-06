/** Existing session tools over STDIO + two real Hubs; no model execution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'
import { sessionMcp } from './support/session-mcp.js'
async function eventually(read, accept, label) {
  const until = Date.now() + 10000
  do { const result = await read(); if (accept(result)) return result; await delay(50) } while (Date.now() < until)
  throw new Error(`Fixture recovery did not converge: ${label}`)
}
test('session tools recover dropped send receipt, queued message and terminal receipt across both Hub restarts', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 45000 }, async () => {
  let home, remote, sourceMcp, peerMcp
  try {
    home = await isolatedHub('recovery-home'); remote = await isolatedHub('recovery-remote'); await pairHubs(home, remote)
    const source = await home.client.call('/api/v1/messaging/sessions', { session_id: 'source', title: 'Requester', runtime: 'external' })
    const target = await remote.client.call('/api/v1/messaging/sessions', { session_id: 'target', title: 'Review fixture', runtime: 'external' })
    const sourceClient = home.client.forSession(source.owner_token), targetClient = remote.client.forSession(target.owner_token)
    sourceMcp = await sessionMcp(home, source)
    const directory = await eventually(() => sourceMcp.tool('kode_sessions_list', { query: 'Review fixture' }), result => result.sessions.some(row => row.address.node_id === remote.node && row.address.session_id === 'target'), 'peer directory')
    const address = directory.sessions.find(row => row.address.node_id === remote.node && row.address.session_id === 'target').address
    await remote.stop('SIGKILL')
    const request = { ...address, content: 'Durable fixture request', idempotency_key: 'same-request' }
    sourceMcp.dropReceipt('kode_sessions_send', request)
    const committed = await eventually(() => sourceClient.call('/api/v1/messaging/events?after=0'), result => result.events.some(row => row.message.idempotency_key === request.idempotency_key), 'send committed despite discarded receipt')
    const message = committed.events.find(row => row.message.idempotency_key === request.idempotency_key).message
    const cursor = committed.cursor
    await sourceMcp.close(); await home.stop('SIGKILL'); await home.start()
    sourceMcp = await sessionMcp(home, source)
    const retry = await sourceMcp.tool('kode_sessions_send', request)
    assert.equal(retry.id, message.id)
    await assert.rejects(sourceMcp.tool('kode_sessions_send', { ...request, content: 'changed' }), /conflict/)
    await remote.start()
    await eventually(() => targetClient.call('/api/v1/messaging/events?after=0'), result => result.events.some(row => row.message.id === message.id), 'queued delivery')
    const claim = await targetClient.call('/api/v1/messaging/sessions/target/claim', {})
    assert.deepEqual(claim.messages.map(row => row.id), [message.id])
    // Persist terminal delivery evidence while the sender cannot acknowledge it.
    await sourceMcp.close(); await home.stop('SIGKILL')
    await targetClient.call(`/api/v1/messaging/messages/${message.id}`, { session_id: 'target', status: 'accepted' })
    peerMcp = await sessionMcp(remote, target)
    const reply = await peerMcp.tool('kode_sessions_send', { ...source.session.address, content: 'Fixture response', idempotency_key: 'same-reply', in_reply_to: message.id })
    await peerMcp.close(); await remote.stop('SIGKILL'); await remote.start(); await home.start()
    sourceMcp = await sessionMcp(home, source)
    let after = cursor, accepted = false, replySeen = false
    const until = Date.now() + 12000
    while ((!accepted || !replySeen) && Date.now() < until) {
      const page = await sourceMcp.tool('kode_sessions_wait', { after, timeout_seconds: 1 })
      assert.ok(page.events.every(event => event.seq > after))
      for (const event of page.events) {
        if (event.message.id === message.id && event.message.status === 'accepted') accepted = true
        if (event.message.id === reply.id) { assert.equal(event.message.in_reply_to, message.id); replySeen = true }
      }
      after = page.cursor
    }
    assert.ok(accepted && replySeen, 'terminal receipt and correlated reply must survive both restarts')
    assert.equal((await sourceMcp.tool('kode_sessions_send', request)).id, message.id)
    assert.deepEqual((await targetClient.call('/api/v1/messaging/sessions/target/claim', {})).messages, [])
    const page = await sourceMcp.tool('kode_sessions_read', { after })
    assert.ok(page.events.every(event => event.seq > after))
  } finally { await sourceMcp?.close(); await peerMcp?.close(); await remote?.close(); await home?.close() }
})
