/** Real Hub persistence + controlled controller boundary; not a full dsh runtime E2E. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installSessionCreator } from '../src/session-create.js'
import { isolatedHub } from './support/isolated-hub.js'
test('creation uncertainty survives Hub restart and recovery never repeats create', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let hub
  try {
    hub = await isolatedHub('creation-durable')
    let creator, creates = 0, submissions = 0
    const profile = { id: 'worker', name: 'Fixture worker', type: 'custom' }
    const agent = { id: '', session: { header: { cwd: hub.root }, snapshotEvents: () => [] }, selectModel() {}, followup() { submissions++ }, ctx: { sessions: { flush: async () => {} } } }
    const workspace = { id: 'workspace', title: 'Fixture', path: hub.root, sessionIds: [], async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) } }
    const services = {
      kodeAgents: { profiles: { list: () => [profile], bind: async () => {} }, hasRuntime: () => true, recordBinding() {}, adapter: { listModels: async () => [{ id: 'fixture', isDefault: true }] } },
      workspaceRegistry: { list: () => [workspace], archivedSessionIds: [] },
      sessionController: {
        create: async request => { creates++; agent.id = request.sessionId; throw new Error('created but response lost') },
        resolveAgent: async id => id === agent.id ? { agent } : { error: { message: 'not found' } }, rename: async () => {},
      },
    }
    const install = () => installSessionCreator({ get: key => services[key], provide: (_key, value) => { creator = value }, effect() {} }, hub.client, hub.node)
    install()
    const input = { title: 'Worker', task: 'Fixture task', idempotency_key: 'durable-create' }
    await assert.rejects(creator.create(input), /response lost/)
    const uncertain = await creator.lookup(input)
    assert.equal(uncertain.status, 'uncertain'); assert.equal(uncertain.stage, 'creating')
    assert.equal(submissions, 0)
    await hub.stop('SIGKILL'); await hub.start(); install()
    assert.deepEqual(await creator.lookup(input), uncertain)
    const result = await creator.create(input)
    assert.deepEqual(result.address, uncertain.address)
    assert.equal(creates, 1); assert.equal(submissions, 1)
    await hub.stop('SIGKILL'); await hub.start(); install()
    assert.deepEqual(await creator.create(input), result)
    assert.equal(creates, 1); assert.equal(submissions, 1)
  } finally { await hub?.close() }
})
