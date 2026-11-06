/** Test the host against a real Rust backend: KODE_TEST_BACKEND_URL / KODE_TEST_TOKEN_FILE. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { apply } from '../src/host.js'
import { BackendClient } from '../src/backend-client.js'
const url = process.env.KODE_TEST_BACKEND_URL
const tokenFile = process.env.KODE_TEST_TOKEN_FILE

test('dsh host registers scoped tools, persists inbox before receipt and delivers replies', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-dsh-host-'))
  const listeners = new Map(), disposers = [], tools = new Map(), received = [], events = []
  const originalCall = BackendClient.prototype.call
  let flushed = false
  const id = `dsh-test-${randomUUID()}`
  const agent = { id, session: { header: { title: 'Implementation session' }, snapshotEvents: offset => events.filter(event => event.seq >= offset) }, followup: message => { received.push(message); events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: received.length - 1, removedCount: 0, inserted: [message] } }) }, ctx: {
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    parallel: async () => { flushed = true },
  } }
  agent.inbox = { remove: id => { const index = received.findIndex(message => message.id === id); if (index >= 0) received.splice(index, 1) } }
  const ctx = { agents: { list: () => [agent], get: target => target === id ? agent : undefined },
    get: name => name === 'kodeSessionCreator' ? { lookup: async (args, source) => {
      assert.equal(source, agent); assert.deepEqual(args, { idempotency_key: 'original-key' }); return { status: 'not_found' }
    } } : undefined,
    logger: { warn() {} }, on: (event, callback) => { listeners.set(event, callback) },
    effect: callback => { const dispose = callback(); disposers.push(dispose) }, inject() {},
  }
  try {
    await apply(ctx, { url, tokenFile, stateFile: join(root, 'state.json'), pollMs: 20 })
    const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
    const creationSchema = tools.get('kode_sessions_create').parameters
    assert.equal(creationSchema.properties.model.type, 'string')
    assert.ok(!creationSchema.required.includes('model'))
    assert.deepEqual(await tools.get('kode_sessions_creation_status').execute({ idempotency_key: 'original-key' }, { agent }), { status: 'not_found' })
    await assert.rejects(tools.get('kode_sessions_creation_status').execute({ idempotency_key: 'original-key' }, { agent: {} }), /foreign agent/)
    const diagnostics = await tools.get('kode_sessions_diagnostics').execute({}, { agent })
    assert.equal(diagnostics.session_id, id)
    assert.equal(diagnostics.runtime_liveness, 'not_probed')
    await assert.rejects(tools.get('kode_sessions_diagnostics').execute({}, { agent: {} }), /foreign agent/)
    const directory = await tools.get('kode_sessions_list').execute({}, { agent })
    const own = directory.sessions.find(s => s.address.session_id === id)
    assert.equal(own.runtime, 'dsh')
    assert.equal(own.title, 'Implementation session')
    agent.session.header.title = 'Renamed implementation session'
    const renamedUntil = Date.now() + 3000
    while (true) {
      const updated = await tools.get('kode_sessions_list').execute({}, { agent })
      if (updated.sessions.find(s => s.address.session_id === id)?.title === 'Renamed implementation session') break
      assert.ok(Date.now() < renamedUntil, 'title updates must reach the shared directory')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const other = await admin.call('/api/v1/messaging/sessions', { session_id: `peer-${randomUUID()}`, title: 'Reviewer', runtime: 'external' })
    const peer = admin.forSession(other.owner_token)
    const message = await peer.call('/api/v1/messaging/messages', { target: own.address, content: 'Please review the fixture', idempotency_key: randomUUID() })
    const deadline = Date.now() + 4000
    let settled
    do {
      settled = await admin.call(`/api/v1/messaging/messages/${message.id}`)
      if (settled.status === 'accepted') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(settled.status, 'accepted')
    const delivery = await tools.get('kode_sessions_delivery_status').execute({ message_id: message.id }, { agent })
    assert.equal(delivery.delivery.phase, 'queued')
    assert.equal(delivery.delivery.input_id, received[0].id)
    assert.equal(flushed, true)
    assert.equal(received.length, 1)
    assert.match(received[0].content[0].text, /Please review/)
    await assert.rejects(tools.get('kode_sessions_cancel_input').execute({ message_id: message.id }, { agent }), /foreign session/)
    await peer.call(`/api/v1/messaging/messages/${message.id}/cancellation`, {})
    const cancelUntil = Date.now() + 3000
    let cancellation
    do {
      cancellation = await tools.get('kode_sessions_cancellation_status').execute({ message_id: message.id }, { agent })
      if (cancellation.cancellation?.state !== 'requested') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < cancelUntil)
    assert.equal(cancellation.cancellation.state, 'cancel_unconfirmed')
    assert.equal(cancellation.cancellation.reason, 'runtime_unsupported')
    const lifecycle = await tools.get('kode_sessions_lifecycle_read').execute({ after: 0 }, { agent })
    assert.ok(lifecycle.events.some(event => event.kind === 'cancellation' && event.data.reason === 'runtime_unsupported'))
    assert.ok(lifecycle.events.some(event => event.kind === 'delivery' && event.data.phase === 'queued'))
    assert.ok(lifecycle.events.every(event => !event.data.content))

    assert.equal(received.length, 1, 'unsupported runtime must not discard arbitrary inputs')
    const reply = await tools.get('kode_sessions_send').execute({ ...other.session.address, content: 'Review completed', idempotency_key: randomUUID(), in_reply_to: message.id }, { agent })
    assert.equal(reply.message.source.session_id, id)
    assert.equal(reply.message.in_reply_to, message.id)
    const cursor = (await tools.get('kode_sessions_read').execute({ after: 0 }, { agent })).cursor
    let readDuringPrepare = false
    BackendClient.prototype.call = async function (path, body, signal) {
      const result = await originalCall.call(this, path, body, signal)
      if (path.endsWith('/delivery') && body?.phase === 'prepared' && body.session_id === id) {
        const page = await tools.get('kode_sessions_read').execute({ after: cursor }, { agent })
        assert.ok(page.events.some(event => event.message.content === 'Final peer result'))
        readDuringPrepare = true
      }
      return result
    }
    await peer.call('/api/v1/messaging/messages', { target: own.address, content: 'Final peer result', idempotency_key: randomUUID(), in_reply_to: reply.message.id })
    const readUntil = Date.now() + 3000
    while (!readDuringPrepare) {
      assert.ok(Date.now() < readUntil)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    BackendClient.prototype.call = originalCall
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(!received.some(input => input.content[0].text.includes('Final peer result')), 'a reply read in this turn must not queue a duplicate automatic turn')
    await assert.rejects(tools.get('kode_sessions_send').execute({}, { agent: {} }), /foreign agent/)
    const longText = '🦊中a'.repeat(5000)
    const large = await peer.call('/api/v1/messaging/messages', { target: own.address, content: longText, in_reply_to: reply.message.id, idempotency_key: randomUUID() })
    let pageCursor = 0, preview
    for (let attempt = 0; attempt < 30 && !preview; attempt++) {
      const page = await tools.get('kode_sessions_read').execute({ after: pageCursor }, { agent })
      preview = page.events.find(e => e.message.id === large.id)?.message
      pageCursor = page.cursor
    }
    assert.equal(preview.content_truncated, true)
    let restored = preview.content, next = preview.continuation.offset
    while (next !== null) {
      const page = await tools.get('kode_sessions_message_read').execute({ message_id: large.id, offset: next }, { agent })
      restored += page.content; next = page.next
    }
    assert.equal(restored, longText)
    const inboxUntil = Date.now() + 3000
    while (!received.some(row => row.content[0].text.includes(large.id))) {
      assert.ok(Date.now() < inboxUntil); await new Promise(resolve => setTimeout(resolve, 20))
    }
    const relayed = received.find(row => row.content[0].text.includes(large.id)).content[0].text
    assert.ok(relayed.includes('Message preview'))
    assert.ok(Buffer.byteLength(JSON.stringify(received.find(row => row.content[0].text.includes(large.id)))) <= 8192)
    assert.ok(Number(/offset=(\d+);/.exec(relayed)[1]) < 4096)
    assert.ok(!relayed.includes(longText))
    // Successful followup/flush alone must not manufacture queue evidence.
    const snapshotEvents = agent.session.snapshotEvents
    delete agent.session.snapshotEvents
    const uncertain = await peer.call('/api/v1/messaging/messages', { target: own.address, content: 'Unobservable runtime input', idempotency_key: randomUUID() })
    let observed
    const uncertainUntil = Date.now() + 3000
    do {
      observed = await admin.call(`/api/v1/messaging/messages/${uncertain.id}`)
      if (observed.status === 'uncertain') break
      assert.ok(Date.now() < uncertainUntil); await new Promise(resolve => setTimeout(resolve, 20))
    } while (true)
    assert.match(observed.detail, /Approximate submission only/)
    assert.equal((await peer.call(`/api/v1/messaging/messages/${uncertain.id}/delivery`)).delivery.phase, 'prepared')
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(received.filter(input => input.content[0].text.includes(uncertain.id)).length, 1)
    agent.session.snapshotEvents = snapshotEvents
    const recoveryUntil = Date.now() + 3000
    while ((await peer.call(`/api/v1/messaging/messages/${uncertain.id}/delivery`)).delivery.phase !== 'queued') {
      assert.ok(Date.now() < recoveryUntil); await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(received.filter(input => input.content[0].text.includes(uncertain.id)).length, 1)
    const tokenState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.ok(tokenState[id])
  } finally {
    BackendClient.prototype.call = originalCall
    for (const dispose of disposers.reverse()) await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('queued messages resume only previously registered dsh sessions through the native controller', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-dsh-wake-'))
  const disposers = [], listeners = new Map(), received = [], tools = new Map(), registrations = new Map()
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const id = `cold-${randomUUID()}`, otherId = `unowned-${randomUUID()}`
  const own = await admin.call('/api/v1/messaging/sessions', { session_id: id, title: 'Cold dsh', runtime: 'dsh' })
  const peer = await admin.call('/api/v1/messaging/sessions', { session_id: otherId, title: 'Another host', runtime: 'dsh' })
  await admin.forSession(own.owner_token).call(`/api/v1/messaging/sessions/${id}/offline`, {})
  await writeFile(join(root, 'state.json'), JSON.stringify({ [id]: own.owner_token }))
  const message = await admin.forSession(peer.owner_token).call('/api/v1/messaging/messages', {
    target: own.session.address, content: 'Wake up the persisted conversation', idempotency_key: randomUUID(),
  })
  let resumes = 0, flushed = 0, current
  const agent = { id, session: { header: {} }, followup: message => received.push(message), ctx: {
    tools: { register: tool => { tools.set(tool.name, tool); registrations.set(tool.name, (registrations.get(tool.name) ?? 0) + 1); return () => tools.delete(tool.name) } },
    parallel: async () => { flushed++ },
  } }
  const controller = { resolveAgent: async target => {
    assert.equal(target, id, 'never resume sessions merely discovered in a peer directory')
    resumes++
    current = agent
    await listeners.get('agent/created')({ agent })
    return { agent }
  } }
  const controllerReadyAt = Date.now() + 80
  const ctx = {
    agents: { list: () => [], get: target => target === id ? current : undefined },
    get: name => name === 'sessionController' && Date.now() >= controllerReadyAt ? controller : undefined,
    logger: { warn() {} }, on: (event, callback) => listeners.set(event, callback),
    effect: callback => disposers.push(callback()),
  }
  try {
    await apply(ctx, { url, tokenFile, stateFile: join(root, 'state.json'), pollMs: 20, resumePollMs: 20 })
    const deadline = Date.now() + 4000
    let settled
    do {
      settled = await admin.call(`/api/v1/messaging/messages/${message.id}`)
      if (settled.status === 'uncertain') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(settled.status, 'uncertain')
    assert.match(settled.detail, /Approximate submission only/)
    assert.equal(resumes, 1)
    assert.equal(received.length, 1)
    assert.equal(flushed, 0)
    assert.ok(tools.has('kode_sessions_send')); assert.ok(tools.has('memory_search'))
    assert.ok([...registrations.values()].every(count => count === 1), 'created event and resolve continuation share one installation')
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
