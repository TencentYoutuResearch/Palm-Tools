import test from 'node:test'
import assert from 'node:assert/strict'
import { isSetupOnlySession } from '../src/session-visibility.js'
import { hostDirectory } from '../src/workspace-directory.js'
const setup = { events: [{ type: 'permission/preset' }, { type: 'turn/start' }, { type: 'turn/end' }] }
test('setup-only histories are hidden but messages, native threads and queued work remain', () => {
  assert.equal(isSetupOnlySession({}, setup), true)
  for (const type of ['user/message', 'assistant/message', 'tool/call', 'plugin:kode/shared-interaction']) assert.equal(isSetupOnlySession({}, { events: [...setup.events, { type }] }), false)
  assert.equal(isSetupOnlySession({}, setup, { threadId: 'native' }), false)
  assert.equal(isSetupOnlySession({ running: true }, setup), false)
  assert.equal(isSetupOnlySession({ projections: { values: { inbox: { pending: [{}] } } } }, setup), false)
  assert.equal(isSetupOnlySession({}, { unavailable: true, events: [] }), false)
})
test('desktop publishes hidden IDs so its original ungrouped source cannot resurrect drafts', async () => {
  const services = { workspaceRegistry: { archivedSessionIds: [], list: () => [] }, sessionController: {
    list: async () => ({ items: [{ sessionId: 'draft', blank: false }, { sessionId: 'real', blank: false }, { sessionId: 'unreadable', blank: false }] }),
    inspect: async id => { if (id === 'unreadable') throw new Error('unavailable'); return id === 'draft' ? setup : { events: [{ type: 'user/message' }] } },
  } }
  const ctx = { get: key => services[key] }
  for (let restart = 0; restart < 2; restart++) {
    const directory = await hostDirectory(ctx)
    assert.deepEqual(directory.hiddenSessionIds, ['draft'])
    assert.deepEqual(directory.sessions.map(row => row.id), ['real', 'unreadable'])
  }
})
