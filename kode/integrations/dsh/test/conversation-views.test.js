import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationViews, conversationViewKey } from '../packages/collab/conversation-views.js'
import { createCollabViewState } from '../packages/collab/view-state.js'

const team = { home_hub: 'home', id: 'team', conversation_id: 'conversation' }
function memory() {
  const values = new Map()
  return {
    values,
    read: async key => structuredClone(values.get(key) ?? null),
    update: async (key, change) => {
      const next = change(structuredClone(values.get(key) ?? null))
      values.set(key, structuredClone(next))
      return structuredClone(next)
    },
  }
}
function editor(storage) {
  let drafts, serial = 0
  const view = createCollabViewState({ onConversationChange: (id, value) => drafts.update(id, value) })
  drafts = createConversationViews({ storage, view, uuid: () => `draft-${++serial}-${Math.random().toString(36).slice(2)}` })
  return { view, drafts }
}

test('scoped drafts restore content, follow-up and scroll after reconstruction', async () => {
  const storage = memory(), first = editor(storage)
  await first.drafts.open(team)
  first.view.saveConversation(team.conversation_id, { draft: '未发送内容', priorRunId: 'prior', scrollTop: 123 })
  const saved = await first.drafts.flush(team)
  first.drafts.close()
  const restored = editor(storage)
  await restored.drafts.open(team)
  assert.deepEqual(restored.view.conversation(team.conversation_id), { draft: '未发送内容', priorRunId: 'prior', scrollTop: 123 })
  assert.equal((await restored.drafts.flush(team)).draftToken, saved.draftToken)
  const foreign = editor(storage)
  await foreign.drafts.open({ ...team, home_hub: 'different-home' })
  assert.equal(foreign.view.conversation(team.conversation_id).draft, '')
  assert.equal(storage.values.size, 1)
})

test('a later edit during a pending transaction is persisted before flush returns', async () => {
  const storage = memory(), original = storage.update
  let release, first = true
  storage.update = async (...args) => {
    if (first) { first = false; await new Promise(resolve => { release = resolve }) }
    return original(...args)
  }
  const { view, drafts } = editor(storage)
  await drafts.open(team)
  view.saveConversation(team.conversation_id, { draft: 'first' })
  await Promise.resolve()
  view.saveConversation(team.conversation_id, { draft: 'latest' })
  release()
  await drafts.flush(team)
  assert.equal(storage.values.get(conversationViewKey(team)).value.draft, 'latest')
  assert.equal(drafts.getSnapshot()[team.conversation_id].error, '')
})

test('two renderers retain conflicting local edits until explicit overwrite', async () => {
  const storage = memory(), a = editor(storage), b = editor(storage)
  await Promise.all([a.drafts.open(team), b.drafts.open(team)])
  a.view.saveConversation(team.conversation_id, { draft: 'saved in A' })
  await a.drafts.flush(team)
  b.view.saveConversation(team.conversation_id, { draft: 'local in B' })
  await assert.rejects(b.drafts.flush(team), /另一页面/)
  assert.equal(b.view.conversation(team.conversation_id).draft, 'local in B')
  assert.equal(storage.values.get(conversationViewKey(team)).value.draft, 'saved in A')
  await b.drafts.retry(team, { overwrite: true })
  assert.equal(storage.values.get(conversationViewKey(team)).value.draft, 'local in B')
})

test('accepted send clears only its exact draft token, while scrolling preserves that token', async () => {
  const storage = memory(), { view, drafts } = editor(storage)
  await drafts.open(team)
  view.saveConversation(team.conversation_id, { draft: 'sent' })
  const first = await drafts.flush(team)
  view.saveConversation(team.conversation_id, { scrollTop: 99 })
  assert.equal((await drafts.flush(team)).draftToken, first.draftToken)
  view.saveConversation(team.conversation_id, { draft: 'new' })
  assert.equal(await drafts.acknowledge(team, { ...team, team_id: team.id, state: 'accepted', draft_token: first.draftToken }), false)
  assert.equal(view.conversation(team.conversation_id).draft, 'new')
  const current = await drafts.flush(team)
  assert.equal(await drafts.acknowledge(team, { ...team, team_id: team.id, state: 'accepted', draft_token: current.draftToken }), true)
  assert.equal(storage.values.get(conversationViewKey(team)).value.draft, '')
})

test('a crash after accepted send recovers a matching uncleared draft without resending', async () => {
  const storage = memory(), first = editor(storage)
  await first.drafts.open(team)
  first.view.saveConversation(team.conversation_id, { draft: 'committed' })
  const { draftToken } = await first.drafts.flush(team)
  const receipt = { home_hub: team.home_hub, team_id: team.id, conversation_id: team.conversation_id, content: 'committed', request_id: 'send', state: 'accepted', actor: { kind: 'human' } }
  storage.values.set(JSON.stringify([team.home_hub, team.conversation_id]), { ...receipt, draft_token: draftToken, receipt })
  const restored = editor(storage)
  await restored.drafts.open(team)
  assert.equal(restored.view.conversation(team.conversation_id).draft, '')
  assert.equal(storage.values.get(conversationViewKey(team)).value.draft, '')
})

test('failed draft writes stay local and block flush until storage succeeds', async () => {
  const storage = memory(), original = storage.update, { view, drafts } = editor(storage)
  await drafts.open(team)
  storage.update = async () => { throw Error('storage full') }
  view.saveConversation(team.conversation_id, { draft: 'keep this' })
  await assert.rejects(drafts.flush(team), /storage full/)
  assert.equal(view.conversation(team.conversation_id).draft, 'keep this')
  storage.update = original
  await drafts.retry(team)
  assert.equal(storage.values.get(conversationViewKey(team)).value.draft, 'keep this')
})
