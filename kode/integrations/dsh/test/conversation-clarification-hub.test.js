/** Real isolated Hub + owner route + browser outbox protocol, without any model process. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { registerConversation } from '../src/conversation-route.js'
import { createCollabOutbox, requestCollabMessage } from '../packages/collab/outbox.js'

test('real Hub question projection and invalid-target rejection pass through owner route without accepting a message', {
  skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000,
}, async () => {
  const hub = await isolatedHub('conversation-target-route')
  try {
    const team = await conversationTeam(hub)
    let route
    registerConversation({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } }, { backendClient: hub.client })
    const invoke = async (url, body) => {
      let status, result
      const req = { url, method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body) } }
      await route.handler(req, { writeHead: value => { status = value }, end: text => { result = JSON.parse(text) } })
      return { ok: status >= 200 && status < 300, json: async () => result, status }
    }
    const projection = await (await invoke(`/api/kode/conversation/messages?conversation_id=${team.conversation_id}&view=clarifications`)).json()
    assert.equal(projection.home_hub, team.home_hub); assert.equal(projection.team_id, team.id); assert.deepEqual(projection.items, [])
    const rows = new Map(), bodies = []
    const store = { read: async key => rows.get(key), reserve: async (key, row) => { const previous = rows.get(key); if (previous) return previous; rows.set(key, row); return row }, save: async (key, row) => rows.set(key, row) }
    const outbox = createCollabOutbox({ storage: store, uuid: () => 'invalid-question-request', request: (path, options) => requestCollabMessage(path, { ...options, fetcher: async (url, init) => { const body = init.body ? JSON.parse(init.body) : undefined; if (body) bodies.push(body); return invoke(url, body) } }) })
    const result = await outbox.send(team, 'answer must not become a new requirement', { clarification_target: { run_id: 'missing-run', assignment_id: 'missing-assignment', question_request_id: 'missing-question' } })
    assert.equal(result.state, 'rejected'); assert.match(outbox.getSnapshot()[outbox.keyOf(team)].error, /Hub 拒绝/)
    assert.equal((await outbox.retry(team)).state, 'rejected'); assert.deepEqual(bodies[0], bodies[1])
    const receipt = await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/requests/${result.request_id}`)
    assert.equal(receipt.message, null)
    const messages = await hub.client.call(`/api/v1/messaging/conversations/${team.conversation_id}/messages`)
    assert.equal(messages.items.length, 0)
  } finally { await hub.close() }
})
