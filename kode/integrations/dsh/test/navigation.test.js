import test from 'node:test'
import assert from 'node:assert/strict'
import { openSessionTarget } from '../packages/transport/navigation.js'

test('resume unarchives the original session before navigation, so archive reconciliation cannot clear it', async () => {
  let archived = true, selected = 'current', refreshed = false, oldDraftCancelled = false
  const gate = Promise.withResolvers()
  const services = {
    workspaces: { async unarchiveSession(id) { assert.equal(id, 'original'); await gate.promise; archived = false } },
    sessions: { async refresh() { refreshed = true } },
    layout: { beginNavigation() { oldDraftCancelled = true } },
    uiWorkspace: { openSession(id) { assert.ok(refreshed); assert.ok(oldDraftCancelled); selected = archived ? undefined : id } },
  }
  const pending = openSessionTarget({ get: name => services[name] }, { sessionId: 'original', resume: true }, new AbortController().signal)
  assert.equal(selected, 'current')
  gate.resolve(); await pending
  assert.equal(selected, 'original')
})

test('resume reacquires the current Host view after asynchronous preparation', async () => {
  let opened
  const services = { uiWorkspace: { openSession() { throw new Error('disposed old Host') } }, workspaces: { unarchiveSession: async () => {} }, layout: { beginNavigation() {} }, sessions: { async refresh() { services.uiWorkspace = { openSession: id => { opened = id } } } } }
  await openSessionTarget({ get: name => services[name] }, { sessionId: 'remote-original', resume: true }, new AbortController().signal)
  assert.equal(opened, 'remote-original')
})

test('a failed or superseded resume does not open a new or wrong conversation', async () => {
  let opened = false
  const controller = new AbortController(), services = { uiWorkspace: { openSession() { opened = true } }, layout: { beginNavigation() {} }, sessions: { refresh: async () => {} }, workspaces: { unarchiveSession: async () => { throw new Error('offline') } } }
  await assert.rejects(openSessionTarget({ get: name => services[name] }, { sessionId: 'original', resume: true }, controller.signal), /offline/)
  services.workspaces.unarchiveSession = async () => { controller.abort(new Error('superseded')) }
  await assert.rejects(openSessionTarget({ get: name => services[name] }, { sessionId: 'original', resume: true }, controller.signal), /superseded/)
  assert.equal(opened, false)
})
