import test from 'node:test'
import assert from 'node:assert/strict'
import { openSessionTarget, openWorkspaceTarget } from '../packages/transport/navigation.js'

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

test('a directory-only workspace is admitted before the native Agent picker starts', async () => {
  const actions = [], items = [], options = { agentPreset: 'example-agent' }
  const workspace = { workspaceId: 'existing-project', path: '/project/example' }
  const services = {
    workspaces: {
      list: { getSnapshot: () => ({ items }) },
      async create(input) {
        actions.push(['admit', input])
        items.push(workspace)
        return workspace
      },
    },
    uiWorkspace: {
      startSession(id, draft) {
        assert.ok(items.some(row => row.workspaceId === id))
        actions.push(['start', id, draft])
      },
      openWorkspace(id) { actions.push(['open', id]) },
    },
  }
  const ctx = { get: name => services[name] }, signal = new AbortController().signal
  await openWorkspaceTarget(ctx, { workspaceId: 'directory-id', workspacePath: workspace.path, startSession: true, options }, signal)
  await openWorkspaceTarget(ctx, { workspaceId: workspace.workspaceId, workspacePath: workspace.path }, signal)
  assert.deepEqual(actions, [['admit', { path: workspace.path }], ['start', workspace.workspaceId, options], ['open', workspace.workspaceId]])
})

test('a superseded workspace lookup cannot start a session on the new Host', async () => {
  const controller = new AbortController()
  const services = {
    workspaces: {
      list: { getSnapshot: () => ({ items: [] }) },
      async create() {
        controller.abort(new Error('superseded'))
        return { workspaceId: 'original' }
      },
    },
    uiWorkspace: { startSession() { assert.fail('opened a workspace after navigation was superseded') } },
  }
  await assert.rejects(openWorkspaceTarget({ get: name => services[name] }, {
    workspaceId: 'original', workspacePath: '/project/example', startSession: true,
  }, controller.signal), /superseded/)
})

test('a workbench-only row is admitted by its exact native Host identity before the composer opens', async () => {
  const byId = {}, calls = []
  const sessions = {
    list: { getSnapshot: () => ({ byId }) },
    refresh: async () => { calls.push('refresh') },
    handleSessionAdded(summary) { byId[summary.sessionId] = summary },
  }
  const services = { sessions, layout: { beginNavigation() {} }, uiWorkspace: {
    openSession(id) { assert.equal(byId[id].sessionId, id); calls.push('open') },
  } }
  const ctx = { get: key => services[key] }, target = { sessionId: 'original' }
  const open = summary => openSessionTarget(ctx, target, new AbortController().signal, async (url, init) => {
    assert.equal(url, '/api/kode/native-sessions?summary=original')
    assert.equal(init.body, undefined)
    calls.push('lookup')
    return { ok: true, json: async () => ({ summary }) }
  })
  await assert.rejects(open({ sessionId: 'wrong' }), /找不到/)
  await open({ sessionId: 'original' })
  await open()
  assert.deepEqual(calls, ['refresh', 'lookup', 'refresh', 'lookup', 'open', 'open'])
})
