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
  const listeners = new Map(), disposers = [], tools = new Map(), received = []
  let flushed = false
  const id = `dsh-test-${randomUUID()}`
  const agent = { id, session: { header: { title: 'Implementation session' } }, followup: message => received.push(message), ctx: {
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
    assert.equal(flushed, true)
    assert.equal(received.length, 1)
    assert.match(received[0].content[0].text, /Please review/)
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
    const tokenState = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
    assert.ok(tokenState[id])
  } finally {
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
      if (settled.status === 'accepted') break
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    assert.equal(settled.status, 'accepted')
    assert.equal(resumes, 1)
    assert.equal(received.length, 1)
    assert.equal(flushed, 1)
    assert.ok(tools.has('kode_sessions_send')); assert.ok(tools.has('memory_search'))
    assert.ok([...registrations.values()].every(count => count === 1), 'created event and resolve continuation share one installation')
  } finally {
    for (const dispose of disposers.reverse()) await dispose?.()
    await rm(root, { recursive: true, force: true })
  }
})
