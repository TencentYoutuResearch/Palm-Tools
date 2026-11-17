/** Actual disposable Rust Hub and durable documents; native history bytes are controlled. No CLI/model. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeBridge } from '../src/runtime-bridge.js'
import { BackendDocument } from '../src/backend-state.js'
import { isolatedHub } from './support/isolated-hub.js'

test('saved mobile projection and repeated archive survive a Hub restart without activating an Agent', { skip: !process.env.KODE_TEST_ISOLATED_HUB, timeout: 30000 }, async () => {
  const hub = await isolatedHub('runtime-directory-recovery')
  try {
    const index = new BackendDocument(hub.client, 'session-index')
    await index.write({ ...await index.read(), native_sessions: [{ backend_key: 'fixture', session_id: 'native-thread', dsh_session_id: 'saved', title: 'Saved conversation', cwd: hub.root }] })
    const profile = { id: 'fixture', name: 'Fixture', type: 'codex' }
    const services = {
      agents: { get: () => undefined },
      kodeAgents: { profiles: { binding: () => undefined, list: () => [profile] }, hasRuntime: () => true },
      workspaceRegistry: { archivedSessionIds: [], list: () => [] },
      sessionController: { list: async () => ({ items: [] }), resolveAgent: () => { throw Error('must not activate an Agent') } },
    }
    const ctx = { get: name => services[name], logger: { warn() {} } }
    const backend = { call: (path, body, signal) => path.endsWith('/workbench/transcript')
      ? Promise.resolve({ available: true, timeline: [{ kind: 'text', role: 'user', text: 'Retained user history' }] })
      : hub.client.call(path, body, signal) }
    let bridge = new RuntimeBridge(ctx, backend)
    await bridge.publish()
    let directory = await hub.client.call('/api/v1/messaging/runtime/sessions')
    const saved = directory.sessions.find(row => row.runtime_session_id === 'saved')
    assert.ok(saved); assert.equal(saved.title, 'Saved conversation'); assert.equal(saved.runtime_saved, true)
    const history = await hub.client.call('/api/v1/messaging/runtime/history?id=' + saved.id)
    assert.ok(history.events.some(row => row.type === 'message' && row.payload.text === 'Retained user history'))
    await bridge.execute({ id: 'archive-saved', session_id: 'saved', kind: 'delete', payload: {} })
    directory = await hub.client.call('/api/v1/messaging/runtime/sessions')
    assert.equal(directory.sessions.some(row => row.runtime_session_id === 'saved'), false, 'archived sessions are filtered by the owner directory')
    await hub.stop('SIGKILL'); await hub.start()
    bridge = new RuntimeBridge(ctx, backend)
    await bridge.publish()
    await bridge.execute({ id: 'archive-saved-retry', session_id: 'saved', kind: 'delete', payload: {} })
    directory = await hub.client.call('/api/v1/messaging/runtime/sessions')
    assert.equal(directory.sessions.some(row => row.runtime_session_id === 'saved'), false, 'archived sessions are filtered by the owner directory')
    const retained = await hub.client.call('/api/v1/messaging/runtime/history?id=' + saved.id)
    assert.ok(retained.events.some(row => row.type === 'message' && row.payload.text === 'Retained user history'))
    const workspaces = await new BackendDocument(hub.client, 'workspaces').read()
    assert.equal(workspaces.global.archivedSessionIds.filter(id => id === 'saved').length, 1)
  } finally { await hub.close() }
})
