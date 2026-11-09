import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { createCollabViewState } from '../packages/collab/view-state.js'
import { installCollabNavigation } from '../packages/collab/navigation.js'

test('view preferences tolerate unavailable storage and keep conversation drafts isolated across modes', () => {
  let stored = '{broken', writes = 0
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; writes++ } }
  const view = createCollabViewState({ storage })
  assert.equal(view.getSnapshot().mode, 'session')
  view.selectSuperagent('super-a'); view.rememberSession('session-a')
  view.saveConversation('conversation-a', { draft: '未发送的需求', scrollTop: 245 })
  view.saveConversation('conversation-b', { draft: '另一项需求' })
  view.setMode('im'); view.setMode('session')
  assert.deepEqual(view.conversation('conversation-a'), { draft: '未发送的需求', scrollTop: 245 })
  assert.equal(view.conversation('conversation-b').draft, '另一项需求')
  assert.equal(stored.includes('需求'), false)
  view.saveConversation('conversation-a', { priorRunId: 'run-a' })
  assert.equal(view.conversation('conversation-a').draft, '未发送的需求')
  assert.equal(view.conversation('conversation-b').priorRunId, undefined)
  assert.throws(() => view.saveConversation('conversation-a', { priorRunId: 'bad/id' }))
  assert.equal(stored.includes('run-a'), false)
  const restored = createCollabViewState({ storage })
  assert.deepEqual(restored.getSnapshot(), view.getSnapshot())
  const before = writes; view.setMode('session'); assert.equal(writes, before)
  const unavailable = createCollabViewState({ storage: { getItem() { throw Error('denied') }, setItem() { throw Error('full') } } })
  unavailable.setMode('im'); assert.equal(unavailable.getSnapshot().mode, 'im')
  assert.throws(() => view.saveConversation('conversation-a', { scrollTop: Infinity }))
  assert.throws(() => view.setMode('invalid'))
})

test('real Cordis references share reversible mode navigation without session effects on switching', () => {
  const ctx = new Context()
  class Workspace extends Service {
    constructor() { super(ctx, 'uiWorkspace'); this.calls = [] }
    startSession(...args) { this.calls.push(args); return args }
  }
  const workspace = new Workspace(), traced = ctx.get('uiWorkspace', false)
  const view = createCollabViewState(), panels = []
  let builder = 0, missing = false
  const adapter = installCollabNavigation({ workspace: traced, originalSymbol: symbols.original, view,
    layout: { selectPanel(id) { if (missing) throw Error('not registered'); panels.push(id) } }, openBuilder: () => ++builder })
  adapter.selectMode('im'); assert.equal(workspace.calls.length, 0)
  workspace.startSession(); traced.startSession()
  assert.equal(builder, 2); assert.equal(workspace.calls.length, 0)
  adapter.selectMode('session'); assert.equal(workspace.calls.length, 0)
  adapter.selectMode('im')
  const options = { prompt: 'explicit session request', clearPreviousDraft: false }
  assert.deepEqual(traced.startSession('workspace', options), ['workspace', options])
  assert.equal(view.getSnapshot().mode, 'session'); assert.equal(workspace.calls.length, 1)
  missing = true; assert.throws(() => adapter.selectMode('im'), /not registered/)
  assert.equal(view.getSnapshot().mode, 'session')
  adapter.dispose(); adapter.dispose()
  assert.equal(Object.hasOwn(workspace, 'startSession'), false)
  traced.startSession(); assert.equal(workspace.calls.length, 2)
  assert.throws(() => adapter.selectMode('im'), /disposed/)
})

test('navigation teardown preserves a later owner replacement', () => {
  const workspace = { startSession() {} }, view = createCollabViewState()
  const adapter = installCollabNavigation({ workspace, view, layout: { selectPanel() {} }, openBuilder() {} })
  const later = () => 42; workspace.startSession = later
  adapter.dispose(); assert.equal(workspace.startSession, later)
})
