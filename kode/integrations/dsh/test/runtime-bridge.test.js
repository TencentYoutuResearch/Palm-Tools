import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { RuntimeBridge, projectSessionEvent, permissionSnapshot } from '../src/runtime-bridge.js'
import { BackendClient } from '../src/backend-client.js'

test('canonical messages, native tools and turn boundaries retain identities and content', () => {
  const content = [{ type: 'text', text: 'A reply' }, { type: 'image', attachment: { id: 'image-1' } }]
  const [message] = projectSessionEvent({ seq: 5, type: 'assistant/message', data: { message: { id: 'native-message', content } } }, 'shared-message')
  assert.equal(message.payload.id, 'shared-message'); assert.equal(message.payload.text, 'A reply'); assert.deepEqual(message.payload.content, content)
  assert.equal(projectSessionEvent({ seq: 6, type: 'tool/result', data: { callId: 'call-1', message: { isError: true, content: [{ type: 'text', text: 'Command failed' }] } } })[0].payload.status, 'error')
  assert.equal(projectSessionEvent({ seq: 7, type: 'turn/end', data: {} })[0].payload.status, 'idle')
  assert.deepEqual(projectSessionEvent({ seq: 8, type: 'request/header', data: { private: 'not a chat message' } }), [])
})

test('stream snapshots are bounded and a committed reply wins over buffered deltas', async () => {
  const publications = [], events = [{ seq: 0, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'native', content: [{ type: 'text', text: 'Finished' }] } } }]
  const services = { sessionController: { list: async () => ({ items: [{ sessionId: 'one' }] }), inspect: async () => ({ events }) }, agents: { get: () => undefined }, kodeAgents: { profiles: { binding: () => undefined } } }
  const bridge = new RuntimeBridge({ get: key => services[key] }, { call: async (path, body) => { if (path.endsWith('/sessions')) return { sessions: [] }; publications.push(body); return { sessions: [{ id: 100, session_id: 'one' }] } } })
  for (let index = 0; index < 100; index++) bridge.emit('one', { key: `stream:${index}`, kind: 'message', payload: { id: 'dsh:one:1:1:0', text: `Partial ${index}`, streaming: true } })
  assert.equal(bridge.extra.get('one').length, 1)
  await bridge.publish()
  const projected = publications[0].sessions[0].events
  assert.equal(projected.length, 1); assert.equal(projected[0].payload.id, 'dsh:one:1:1:0')
  assert.equal(projected.at(-1).payload.text, 'Finished'); assert.equal(projected.at(-1).payload.streaming, false)
})

test('real Kode backend routes mobile input into the existing dsh session and preserves replay', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const token = (await readFile(process.env.KODE_TEST_TOKEN_FILE, 'utf8')).trim()
  const backend = new BackendClient(process.env.KODE_TEST_BACKEND_URL, token)
  const sessionId = `runtime-${randomUUID()}`, runtimeId = `runtime-${randomUUID()}`
  const events = [{ seq: 0, type: 'user/message', data: { id: 'old-user', content: [{ type: 'text', text: 'Existing desktop prompt' }] } }]
  let submissions = 0
  const controller = {
    list: async () => ({ items: [{ sessionId, cwd: '/tmp', title: 'Shared session' }] }), inspect: async () => ({ events }),
    prompt: async request => { assert.equal(request.sessionId, sessionId); submissions++; events.push({ seq: events.length, type: 'user/message', data: { id: request.requestId, content: request.content } }); return { accepted: true } },
  }
  const services = { sessionController: controller, agents: { get: () => undefined }, kodeAgents: { profiles: { binding: () => undefined } } }
  const bridge = new RuntimeBridge({ get: key => services[key], logger: { warn() {} } }, backend, { runtime: runtimeId, intervalMs: 20 }).start()
  try {
    const deadline = Date.now() + 5000
    while (!bridge.ids.has(sessionId)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)) }
    const publicId = bridge.ids.get(sessionId), requestId = randomUUID()
    const request = { session_id: publicId, kind: 'input', payload: { text: 'Sent from phone' }, request_id: requestId }
    const result = await backend.call('/api/v1/messaging/runtime/command', request)
    assert.equal(result.accepted, true)
    await backend.call('/api/v1/messaging/runtime/command', request)
    assert.equal(submissions, 1)
    await assert.rejects(backend.call('/api/v1/messaging/runtime/command', { ...request, payload: { text: 'Conflicting retry' } }), /identity conflicts/)
    await bridge.publish()
    const projected = await backend.call(`/api/v1/messaging/runtime/history?id=${publicId}`)
    assert.deepEqual(projected.events.filter(event => event.type === 'message').map(event => event.payload.text), ['Existing desktop prompt', 'Sent from phone'])
  } finally { await bridge.close() }
})


test('permission changes preserve the deployment preset catalog and flush durable state', async () => {
  const session = {}, changes = []
  let current = 'restricted'
  const service = { names: ['restricted', 'reviewed'], current: () => current, catalog: () => ({ options: [{ value: 'restricted', name: 'Restricted', description: 'Read only' }, { value: 'reviewed', name: 'Reviewed', description: 'Review every change' }] }), set: (target, mode) => { assert.equal(target, session); changes.push(mode); current = mode } }
  let flushed = 0
  const agent = { session, ctx: { sessions: { flush: async target => { assert.equal(target, session); flushed++ } } } }
  const services = { permissionPresets: service, sessionController: { resolveAgent: async () => ({ agent }) } }
  const bridge = new RuntimeBridge({ get: key => services[key] }, {})
  assert.deepEqual(permissionSnapshot(service, session).permission_modes.map(mode => mode.id), ['restricted', 'reviewed'])
  await assert.rejects(bridge.execute({ id: 'bad', kind: 'mode', session_id: 'one', payload: { mode: 'bypassPermissions' } }), /Unsupported permission preset/)
  assert.equal(changes.length, 0)
  assert.deepEqual(await bridge.execute({ id: 'ok', kind: 'mode', session_id: 'one', payload: { mode: 'reviewed' } }), { accepted: true, mode: 'reviewed' })
  assert.equal(flushed, 1)
})

test('continued timed questions stay answerable through the original dsh service', async () => {
  const question = { callId: 'timed-call', state: 'continued', questions: [{ id: 'target', question: 'Choose a target', options: [{ label: 'Local' }] }] }
  const row = { sessionId: 'continued-session', projections: { values: { userQuestions: { questions: { active: [question] } } } } }
  const agent = { id: row.sessionId }, publications = []
  let replies = 0
  const services = {
    sessionController: { list: async () => ({ items: [row] }), inspect: async () => ({ events: [] }), resolveAgent: async () => ({ agent }) },
    agents: { get: () => undefined }, kodeAgents: { profiles: { binding: () => undefined } },
    userQuestions: { answer: (owner, callId, answer) => { assert.equal(owner, agent); assert.equal(callId, question.callId); assert.deepEqual(answer.answers, [{ id: 'target', selected: ['Local'] }]); replies++; return true } },
  }
  const bridge = new RuntimeBridge({ get: key => services[key] }, { call: async (path, body) => { if (path.endsWith('/sessions')) return { sessions: [] }; publications.push(body); return { sessions: [{ id: 100 }] } } })
  await bridge.publish()
  const card = publications.at(-1).sessions[0].events.find(event => event.kind === 'ask_user_question')
  assert.ok(card)
  await bridge.answer(row.sessionId, { request_id: card.payload.request_id, response: { action: 'accept', content: { target: 'Local' } } }, 'answer')
  assert.equal(replies, 1)
  assert.throws(() => bridge.answer(row.sessionId, { request_id: card.payload.request_id }, 'answer'), /already settled/)
  await bridge.publish()
  assert.ok(!publications.at(-1).sessions[0].events.some(event => event.kind === 'ask_user_question'))
  row.projections.values.userQuestions.questions.active = []
  await bridge.publish()
  assert.equal(bridge.continued.get(row.sessionId).size, 0)
})
