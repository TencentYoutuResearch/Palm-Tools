/** Installed official controller + Session/Agent services; in-memory persistence and no inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import * as factoryPlugin from '../src/native-agent-factory.js'
import { installSessionCreator } from '../src/session-create.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('installed controller attach failure recovers original blank session and workspace before delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-create-controller-'))
  const ctx = new Context(), rows = new Map(), fibers = []
  let failAttach = true, creates = 0, state = null, revision = 0, creator
  try {
    for (const plugin of [SessionStore, AgentRegistry, ProjectionRegistry]) fibers.push(await ctx.plugin(plugin))
    const handle = row => ({ header: row.header, inheritedEventCount: 0, read: async () => ({ events: [...row.events] }), append: async events => row.events.push(...events), flush: async () => {}, close: async () => {} })
    ctx.provide('sessionPersistence', {
      create: async header => { creates++; assert.ok(!rows.has(header.id)); const row = { header, events: [] }; rows.set(header.id, row); return handle(row) },
      open: async id => handle(rows.get(id)),
    })
    ctx.on('session/event', (session, event) => rows.get(session.id).events.push(event))
    ctx.on('session/flush', async () => {})
    const workspace = { id: 'workspace', title: 'Fixture', path: root, sessionIds: [], attachSession: async id => { if (failAttach) throw new Error('fixture attach unavailable'); if (!workspace.sessionIds.includes(id)) workspace.sessionIds.push(id) } }
    const profile = { id: 'worker', name: 'Worker', type: 'custom' }
    const services = {
      tools: { schemas: () => [] }, agentLoop: {}, sessionTitle: { rename: (_session, title) => ({ title, eventSeq: 0 }) },
      kodeAgents: { profiles: { list: () => [profile], bind: async () => {} }, hasRuntime: () => true, recordBinding() {}, adapter: { listModels: async () => [{ id: 'fixture', isDefault: true }], closeSession: async () => {} } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'kode-agent-worker', model: 'fixture' }) },
      attachments: { imageLimits: { maxImageBytes: 1024 } }, fileUploads: { registerAgentResolver: () => () => {} }, fs: {}, llm: {}, remoteAccess: { allows: () => true },
      typert: { resources: { register() {} }, lookups: { configure() {} }, contexts: { configureHost() {} } },
      workspaceRegistry: { get: id => id === workspace.id ? workspace : undefined, list: () => [workspace], archivedSessionIds: [] },
      sessionQuery: { listSessions: async () => [...rows.values()].map(row => ({ header: row.header })), observeSession: async () => { throw new SessionQueryError('not found', 'SESSION_QUERY_SESSION_NOT_FOUND') } },
      agentPresets: { register: async () => () => {}, resolve: async id => ({ id }), mount: async () => {} },
    }
    for (const [name, value] of Object.entries(services)) ctx.provide(name, value)
    ctx.agents.setFactory({ createAgent() { throw new Error('unexpected official inference') }, resume() { throw new Error('unexpected official resume') } })
    fibers.push(await ctx.plugin(factoryPlugin))
    fibers.push(await ctx.plugin(SessionController, { nativeOpen: false }))
    const backend = { call: async (_path, body) => { if (!body) return { value: structuredClone(state), revision }; assert.equal(body.expected_revision, revision); state = structuredClone(body.value); return { value: structuredClone(state), revision: ++revision } } }
    const install = () => installSessionCreator({ get: key => ctx.get(key), provide: (_key, value) => { creator = value }, effect() {} }, backend, 'fixture.example')
    install()
    const input = { title: 'Helper', task: 'Inspect', requester: 'owner', idempotency_key: 'attach-failure' }
    await assert.rejects(creator.create(input), /could not attach/)
    const pending = await creator.lookup(input)
    assert.equal(pending.stage, 'creating'); assert.equal(creates, 1)
    assert.deepEqual(workspace.sessionIds, [])
    failAttach = false; install()
    const result = await creator.create(input)
    assert.deepEqual(result.address, pending.address)
    assert.deepEqual(workspace.sessionIds, [pending.address.session_id])
    assert.equal(creates, 1); assert.equal(result.status, 'ready')
    assert.equal(rows.get(result.address.session_id).events.some(event => event.type === 'user/message'), false)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
