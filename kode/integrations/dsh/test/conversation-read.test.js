import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { registerConversationRead } from '../src/conversation-read-route.js'

test('owner read position persists without consuming Coordinator input or changing work', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('conversation-read')
  try {
    const team = await conversationTeam(hub)
    const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
    const path = 'conversations/' + team.conversation_id
    const empty = await call(path + '/read-state')
    assert.equal(empty.through_sequence, 0); assert.equal(empty.unread_count, 0)
    const first = await call(path + '/messages', { request_id: 'one', content: 'First requirement' })
    const second = await call(path + '/messages', { request_id: 'two', content: 'Second requirement' })
    const pending = await call(path + '/pending-inputs')
    const registered = await call('sessions', { session_id: 'observer', title: 'Observer', runtime: 'external' })
    const worker = hub.client.forSession(registered.owner_token)
    for (const body of [undefined, { through_sequence: second.sequence }]) await assert.rejects(worker.call('/api/v1/messaging/' + path + '/read-state', body), /403/)
    await assert.rejects(call(path + '/read-state', { through_sequence: second.sequence + 1 }), /not in this conversation/)
    await assert.rejects(call(path + '/read-state', { through_sequence: 0, principal_id: 'someone-else' }), /422/)
    const newer = await call(path + '/read-state', { through_sequence: second.sequence })
    assert.equal(newer.principal_id, 'local_owner'); assert.equal(newer.unread_count, 0)
    assert.deepEqual(await call(path + '/read-state', { through_sequence: first.sequence }), newer)
    assert.deepEqual(await call(path + '/read-state', { through_sequence: second.sequence }), newer)
    assert.deepEqual(await call(path + '/pending-inputs'), pending, 'user read is not runtime consumption')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await call(path + '/read-state'), newer)
    const events = (await call('teams/' + team.id + '/events')).events
    assert.equal(events.filter(row => row.data.kind === 'conversation_read_advanced').length, 1)
  } finally { await hub.close() }
})

test('dsh owner read bridge recovers a lost write response across Hub restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('conversation-read-bridge')
  try {
    const team = await conversationTeam(hub)
    const path = `/api/v1/messaging/conversations/${team.conversation_id}`
    const message = await hub.client.call(path + '/messages', { request_id: 'bridge-message', content: 'Implement requirement' })
    let route, kind = 'agent', lose = false, calls = 0
    registerConversationRead({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, {
      backendClient: { call: async (...args) => {
        calls++
        const value = await hub.client.call(...args)
        if (lose) { lose = false; throw Error('private transport details') }
        return value
      } },
    })
    const invoke = async (method, body, query = '') => {
      let status, result
      await route.handler({ method, url: route.path + query, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }, {
        writeHead: value => { status = value }, end: value => { result = JSON.parse(value) },
      })
      return { status, result }
    }
    const body = { conversation_id: team.conversation_id, through_sequence: message.sequence }
    assert.equal((await invoke('POST', body)).status, 403)
    assert.equal(calls, 0)
    kind = 'owner'
    for (const invalid of [{ ...body, principal_id: 'other' }, { ...body, through_sequence: -1 }, { ...body, through_sequence: 1.5 }, { ...body, through_sequence: Number.MAX_SAFE_INTEGER + 1 }, []]) {
      assert.equal((await invoke('POST', invalid)).status, 400)
    }
    assert.equal((await invoke('GET', undefined, `?conversation_id=${team.conversation_id}&conversation_id=other`)).status, 400)
    assert.equal(calls, 0)
    lose = true
    const lost = await invoke('POST', body)
    assert.equal(lost.status, 409); assert.equal(lost.result.retry, 'same_position')
    assert.ok(!JSON.stringify(lost).includes('private transport'))
    await hub.stop('SIGKILL'); await hub.start()
    const recovered = await invoke('GET', undefined, `?conversation_id=${team.conversation_id}`)
    assert.equal(recovered.status, 200); assert.equal(recovered.result.through_sequence, message.sequence)
    assert.deepEqual(await invoke('POST', body), recovered)
    assert.deepEqual(await invoke('POST', { ...body, through_sequence: 0 }), recovered)
    const events = await hub.client.call(`/api/v1/messaging/teams/${team.id}/events`)
    assert.equal(events.events.filter(row => row.data.kind === 'conversation_read_advanced').length, 1)
  } finally { await hub.close() }
})
