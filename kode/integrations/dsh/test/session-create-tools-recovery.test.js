/** Actual Host tools + creator + Hub; controlled Worker controller, no inference. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { apply } from '../src/host.js'
import { installSessionCreator } from '../src/session-create.js'
import { BackendClient } from '../src/backend-client.js'
import { isolatedHub } from './support/isolated-hub.js'

test('creation tool recovers lost assignment receipt across Hub and Host rebuild without duplicate work', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('create-tools')
  const originalCall = BackendClient.prototype.call
  let host, created = 0, worker, assignmentId, drop = true
  const workspace = { id: 'workspace', title: 'Fixture', path: hub.root }
  const profile = { id: 'worker', name: 'Worker', type: 'custom' }
  async function boot() {
    const tools = new Map(), disposers = [], services = {}
    const source = { id: 'coordinator', session: { header: { cwd: hub.root }, snapshotEvents: () => [] }, followup() { throw new Error('unexpected reply') }, ctx: {
      get: key => key === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write' }) } : undefined,
      tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    } }
    Object.assign(services, {
      kodeAgents: { profiles: { list: () => [profile], binding: () => undefined, bind: async () => {} }, hasRuntime: () => true, recordBinding() {}, adapter: { listModels: async () => [{ id: 'fixture', isDefault: true }] } },
      workspaceRegistry: { list: () => [workspace] },
      sessionController: {
        create: async request => {
          created++
          const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: request.sessionId, title: 'Helper', runtime: 'external' })
          worker = { id: request.sessionId, client: hub.client.forSession(registration.owner_token), session: { header: { cwd: hub.root } }, selectModel() {}, followup() { throw new Error('delegation must use durable messaging') }, ctx: { sessions: { flush: async () => {} } } }
          return { sessionId: request.sessionId }
        }, resolveAgent: async () => ({ agent: worker }), rename: async () => {},
      },
    })
    const ctx = {
      agents: { list: () => [source], get: id => id === source.id ? source : undefined },
      get: key => services[key], provide: (key, value) => { services[key] = value },
      effect: callback => disposers.push(callback()), inject() {}, on() {}, logger: { warn() {} },
    }
    installSessionCreator(ctx, hub.client, hub.node)
    await apply(ctx, { url: hub.url, tokenFile: join(hub.root, 'admin.token'), stateFile: join(hub.root, 'host-tokens.json'), pollMs: 20, agentRuntime: false, runtimeBridge: false })
    return { call: (name, input) => tools.get(name).execute(input, { agent: source }), close: async () => { for (const dispose of disposers.reverse()) await dispose?.() } }
  }
  try {
    host = await boot()
    BackendClient.prototype.call = async function(path, body, signal) {
      const result = await originalCall.call(this, path, body, signal)
      if (drop && path === '/api/v1/messaging/messages' && body?.idempotency_key?.startsWith('create:')) {
        drop = false; assignmentId = result.id
        throw new Error('fixture assignment response lost after commit')
      }
      return result
    }
    const input = { title: 'Helper', task: 'Inspect fixture', idempotency_key: 'create-original' }
    await assert.rejects(host.call('kode_sessions_create', input), /response lost after commit/)
    assert.equal(created, 1)
    const status = await host.call('kode_sessions_creation_status', { idempotency_key: input.idempotency_key })
    assert.equal(status.status, 'completed')
    assert.equal(status.result.status, 'ready', 'creation does not assert assignment completion')
    await host.close(); host = undefined
    await hub.stop('SIGKILL'); await hub.start()
    host = await boot()
    const recovered = await host.call('kode_sessions_create', input)
    assert.equal(recovered.assignment.id, assignmentId)
    assert.deepEqual(recovered.address, status.address)
    assert.equal(created, 1)
    await assert.rejects(host.call('kode_sessions_create', { ...input, task: 'different task' }), /different task/)
    const claimed = await worker.client.call(`/api/v1/messaging/sessions/${worker.id}/claim`, {})
    assert.deepEqual(claimed.messages.map(row => row.id), [assignmentId])
    await worker.client.call(`/api/v1/messaging/messages/${assignmentId}`, { session_id: worker.id, status: 'accepted' })
    assert.equal((await host.call('kode_sessions_create', input)).assignment.id, assignmentId)
    assert.equal((await worker.client.call(`/api/v1/messaging/sessions/${worker.id}/claim`, {})).messages.length, 0)
  } finally {
    BackendClient.prototype.call = originalCall
    await host?.close(); await hub.close()
  }
})
