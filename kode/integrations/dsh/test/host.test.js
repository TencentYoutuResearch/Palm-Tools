/** Test the host against a real Rust backend: KODE_TEST_BACKEND_URL / KODE_TEST_TOKEN_FILE. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { apply } from '../src/host.js'
import { BackendClient } from '../src/backend-client.js'
import { deliveryInputId } from '../src/delivery-tracker.js'
const url = process.env.KODE_TEST_BACKEND_URL
const tokenFile = process.env.KODE_TEST_TOKEN_FILE

test('dsh host registers scoped tools, persists inbox before receipt and delivers replies', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-dsh-host-'))
  const listeners = new Map(), disposers = [], tools = new Map(), received = [], events = []
  const originalCall = BackendClient.prototype.call
  let releaseRecovery
  let flushed = false
  const id = `dsh-test-${randomUUID()}`
  const agent = { id, session: { header: { title: 'Implementation session' }, snapshotEvents: offset => events.filter(event => event.seq >= offset) }, followup: message => { received.push(message); events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: received.length - 1, removedCount: 0, inserted: [message] } }) }, ctx: {
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    parallel: async () => { flushed = true },
  } }
  agent.inbox = { remove: id => { const index = received.findIndex(message => message.id === id); if (index >= 0) received.splice(index, 1) } }
  const ctx = { agents: { list: () => [agent], get: target => target === id ? agent : undefined },
    logger: { warn() {} }, on: (event, callback) => { listeners.set(event, callback) },
    effect: callback => { const dispose = callback(); disposers.push(dispose) }, inject() {},
  }
  try {
    await apply(ctx, { url, tokenFile, stateFile: join(root, 'state.json'), pollMs: 20 })
    const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
    const creationSchema = tools.get('kode_sessions_create').parameters
    assert.equal(creationSchema.properties.model.type, 'string')
    assert.ok(!creationSchema.required.includes('model'))
    assert.match(creationSchema.properties.title.description, /at most 4 words/)
    assert.match(creationSchema.properties.title.description, /kode_sessions_list/)
    const directory = await tools.get('kode_sessions_list').execute({}, { agent })
    const own = directory.sessions.find(s => s.address.session_id === id)
    assert.equal(own.runtime, 'dsh')
    assert.equal(own.title, 'Implementation session')
    assert.equal(directory.sessionNaming.maxWords, 4)
    assert.match(directory.sessionNaming.prompt, /Feat.*Bug.*MR/)
    const namingPath = '/api/v1/messaging/integrations'
    const customPrompt = '用中文概括任务。\n评审名称以 Review- 开头。'
    try {
      await admin.call(namingPath, { session_naming_prompt: ` ${customPrompt} ` })
      await assert.rejects(admin.call(namingPath, { session_naming_prompt: '规'.repeat(2001) }), /2000/)
      const fresh = await tools.get('kode_sessions_list').execute({}, { agent })
      assert.deepEqual(fresh.sessionNaming, { prompt: customPrompt, maxWords: 4 })
    } finally {
      await admin.call(namingPath, { session_naming_prompt: '' })
    }
    assert.deepEqual((await tools.get('kode_sessions_list').execute({}, { agent })).sessionNaming, directory.sessionNaming)
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
    assert.equal(flushed, true)
    assert.equal(received.length, 1)
    assert.match(received[0].content[0].text, /Please review/)
    await assert.rejects(tools.get('kode_sessions_cancel_input').execute({ message_id: message.id }, { agent }), /foreign session/)
    let recoveryBlocked = false
    BackendClient.prototype.call = async function (path, body, signal) {
      if (path.startsWith(`/api/v1/messaging/sessions/${id}/deliveries`)) {
        recoveryBlocked = true
        await new Promise(resolve => { releaseRecovery = resolve })
      }
      return originalCall.call(this, path, body, signal)
    }
    const recoveryUntil = Date.now() + 3000
    while (!recoveryBlocked) {
      assert.ok(Date.now() < recoveryUntil)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await peer.call(`/api/v1/messaging/messages/${message.id}/cancellation`, {})
    let cancellation
    const cancelUntil = Date.now() + 3000
    do {
      cancellation = await tools.get('kode_sessions_cancellation_status').execute({ message_id: message.id }, { agent })
      if (cancellation.cancellation?.state !== 'requested') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < cancelUntil)
    assert.equal(cancellation.cancellation.state, 'cancel_unconfirmed')
    assert.equal(cancellation.cancellation.reason, 'runtime_unsupported')
    assert.equal(received.length, 1)
    BackendClient.prototype.call = originalCall
    releaseRecovery()
    const reply = await tools.get('kode_sessions_send').execute({ ...other.session.address, content: 'Review completed', idempotency_key: randomUUID(), in_reply_to: message.id }, { agent })
    assert.equal(reply.message.source.session_id, id)
    assert.equal(reply.message.in_reply_to, message.id)
    const cursor = (await tools.get('kode_sessions_read').execute({ after: 0 }, { agent })).cursor
    const completed = await peer.call('/api/v1/messaging/messages', { target: own.address, content: 'Final peer result', idempotency_key: randomUUID(), in_reply_to: reply.message.id })
    const readUntil = Date.now() + 3000
    while (true) {
      const result = await tools.get('kode_sessions_read').execute({ after: cursor }, { agent })
      if (result.events.some(event => event.message.id === completed.id)) break
      assert.ok(Date.now() < readUntil)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
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
    const tokenState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.ok(tokenState[id])
  } finally {
    BackendClient.prototype.call = originalCall
    releaseRecovery?.()
    for (const dispose of disposers.reverse()) await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('queued messages resume only previously registered dsh sessions through the native controller', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-dsh-wake-'))
  const disposers = [], listeners = new Map(), received = [], tools = new Map(), registrations = new Map(), events = []
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
  const agent = { id, session: { header: {}, snapshotEvents: offset => events.filter(event => event.seq >= offset) }, followup: message => { received.push(message); events.push({ seq: events.length, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: received.length - 1, removedCount: 0, inserted: [message] } }) }, ctx: {
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
      if (settled.status === 'accepted') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(settled.status, 'accepted')
    assert.equal(resumes, 1)
    assert.equal(received.length, 1)
    assert.ok(flushed >= 1)
    assert.ok(tools.has('kode_sessions_send')); assert.ok(tools.has('memory_search'))
    assert.ok([...registrations.values()].every(count => count === 1), 'created event and resolve continuation share one installation')
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})

test('incoming session messages steer a ready native turn without losing durable delivery evidence', { skip: !url || !tokenFile }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-dsh-relay-steering-'))
  const admin = new BackendClient(url, (await readFile(tokenFile, 'utf8')).trim())
  const id = `steered-${randomUUID()}`
  const disposers = [], events = [], submitted = [], tools = new Map()
  const flushStarted = Promise.withResolvers(), releaseFlush = Promise.withResolvers()
  const readStarted = Promise.withResolvers(), releaseRead = Promise.withResolvers(), waitAbort = new AbortController()
  const originalCall = BackendClient.prototype.call
  let waiting
  const queues = { 'next-turn': [], 'next-step': [] }
  const append = (type, data) => { const seq = events.length; events.push({ seq, type, data }); return seq }
  const splice = (target, start, removedCount, inserted) => {
    queues[target].splice(start, removedCount, ...inserted)
    append('agent/inbox/spliced', { target, start, removedCount, inserted })
  }
  const enqueue = (target, message) => {
    submitted.push({ target, message })
    splice(target, queues[target].length, 0, [message])
  }
  let steeringReady = true, flushes = 0
  const agent = {
    id, isKodeNativeAgent: true, status: 'running',
    session: { header: {}, snapshotEvents: offset => events.filter(event => event.seq >= offset) },
    canSteerRelay() { return this.status === 'running' && steeringReady },
    steer: message => enqueue('next-step', message),
    followup: message => enqueue('next-turn', message),
    inbox: { remove: id => {
      for (const [target, messages] of Object.entries(queues)) {
        const index = messages.findIndex(message => message.id === id)
        if (index !== -1) { splice(target, index, 1, []); return }
      }
    } },
    ctx: {
      tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      async parallel(event, session) {
        assert.equal(event, 'session/flush')
        assert.equal(session, agent.session)
        if (++flushes !== 1) return
        flushStarted.resolve()
        await releaseFlush.promise
      },
    },
  }
  const ctx = {
    agents: { list: () => [agent], get: target => target === id ? agent : undefined },
    logger: { warn() {} }, on() {}, inject() {},
    effect: callback => { disposers.push(callback()) },
  }
  const endpoint = message => `/api/v1/messaging/messages/${message.id}`
  const delivery = async message => (await admin.call(`${endpoint(message)}/delivery`)).delivery
  async function until(read, match) {
    const deadline = Date.now() + 4000
    do {
      const value = await read()
      if (match(value)) return value
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.fail('timed out waiting for delivery evidence')
  }
  const waitForGate = (gate, label) => Promise.race([
    gate.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), 4000).unref()),
  ])
  try {
    await apply(ctx, { url, tokenFile, stateFile: join(root, 'state.json'), pollMs: 20 })
    const own = (await admin.call('/api/v1/messaging/sessions')).sessions.find(row => row.address.session_id === id)
    const other = await admin.call('/api/v1/messaging/sessions', { session_id: `peer-${randomUUID()}`, title: 'Reviewer', runtime: 'external' })
    const peer = admin.forSession(other.owner_token)
    const send = content => peer.call('/api/v1/messaging/messages', { target: own.address, content, idempotency_key: randomUUID() })

    const active = await send('Adjust the running work using this review')
    await waitForGate(flushStarted, 'runtime never flushed queued message')
    const expectedId = deliveryInputId(active.id)
    const pending = await delivery(active)
    assert.equal(pending.phase, 'prepared', 'do not confirm the receipt while inbox persistence is blocked')
    assert.equal(pending.input_id, expectedId)
    assert.notEqual((await admin.call(endpoint(active))).status, 'accepted')
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].target, 'next-step')
    assert.equal(submitted[0].message.id, expectedId)
    assert.match(submitted[0].message.content[0].text, /Adjust the running work/)
    releaseFlush.resolve()

    await until(() => admin.call(endpoint(active)), row => row.status === 'accepted')
    assert.equal((await delivery(active)).phase, 'queued')
    splice('next-step', 0, 1, [])
    const consumedSeq = append('user/message', submitted[0].message)
    const consumed = await until(() => delivery(active), row => row?.phase === 'consumed')
    assert.equal(consumed.input_id, expectedId)
    assert.equal(consumed.event_seq, consumedSeq)

    for (const [status, ready, content] of [
      ['idle', true, 'Start a later turn'],
      ['running', false, 'Queue when mid-turn admission is unavailable'],
    ]) {
      agent.status = status
      steeringReady = ready
      const message = await send(content)
      await until(() => admin.call(endpoint(message)), row => row.status === 'accepted')
      const evidence = await delivery(message)
      assert.equal(evidence.phase, 'queued')
      assert.equal(evidence.input_id, deliveryInputId(message.id))
      assert.equal(submitted.at(-1).target, 'next-turn')
      assert.equal(submitted.at(-1).message.id, evidence.input_id)
    }
    assert.equal(submitted.length, 3, 'one runtime input per message even after delivery recovery')

    agent.status = 'running'
    steeringReady = true
    const requested = await tools.get('kode_sessions_send').execute({
      ...other.session.address, content: 'Review the code', idempotency_key: randomUUID(),
    }, { agent })
    const { cursor } = await tools.get('kode_sessions_read').execute({ after: 0 }, { agent })
    BackendClient.prototype.call = async function (path, body, signal) {
      if (path === `/api/v1/messaging/events?after=${cursor}`) {
        readStarted.resolve()
        await releaseRead.promise
      }
      return originalCall.call(this, path, body, signal)
    }
    waiting = tools.get('kode_sessions_wait').execute({ after: cursor, timeout_seconds: 4 }, { agent, signal: waitAbort.signal })
    void waiting.catch(() => {})
    await waitForGate(readStarted, 'agent did not begin waiting for replies')
    const reply = await peer.call('/api/v1/messaging/messages', {
      target: own.address, content: 'Review completed', in_reply_to: requested.message.id, idempotency_key: randomUUID(),
    })
    await until(() => admin.call(endpoint(reply)), row => row.status === 'accepted')
    const replyId = deliveryInputId(reply.id)
    assert.equal(submitted.at(-1).message.id, replyId)
    assert.equal(submitted.at(-1).target, 'next-turn', 'do not steer and interrupt the waiting Agent')
    assert.ok(queues['next-turn'].some(message => message.id === replyId))
    releaseRead.resolve()
    const read = await waiting
    const receivedReply = read.events.find(row => row.message.id === reply.id)?.message
    assert.equal(receivedReply?.content, 'Review completed')
    assert.ok(!queues['next-turn'].some(message => message.id === replyId), 'the full reply returned by wait must not start a duplicate turn')
    assert.equal(submitted.filter(row => row.message.id === replyId).length, 1)
  } finally {
    BackendClient.prototype.call = originalCall
    releaseFlush.resolve()
    waitAbort.abort()
    releaseRead.resolve()
    await waiting?.catch(() => {})
    for (const dispose of disposers.reverse()) await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
