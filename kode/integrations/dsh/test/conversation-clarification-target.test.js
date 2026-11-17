import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createCollabOutbox, requestCollabMessage } from '../packages/collab/outbox.js'
import { createCollabViewState } from '../packages/collab/view-state.js'
import { createConversationViews } from '../packages/collab/conversation-views.js'
import { validateConversationQuestions } from '../packages/collab/conversation-target.js'
import { registerConversation } from '../src/conversation-route.js'
const team = { id: 'team', home_hub: 'home', superagent_id: 'super', conversation_id: 'conversation' }
const a = { run_id: 'run-a', assignment_id: 'assignment-a', question_request_id: 'question-a' }
const b = { run_id: 'run-b', assignment_id: 'assignment-b', question_request_id: 'question-b' }
function storage() {
  const rows = new Map()
  return { rows, read: async key => structuredClone(rows.get(key)), update: async (key, fn) => { const row = fn(structuredClone(rows.get(key))); rows.set(key, structuredClone(row)); return row }, reserve: async (key, candidate, canReplace) => { const row = rows.get(key); if (row && row.state !== 'accepted' && !canReplace?.(row)) return structuredClone(row); rows.set(key, structuredClone(candidate)); return candidate }, save: async (key, row) => { rows.set(key, structuredClone(row)) } }
}
function editor(store) {
  let drafts, n = 0
  const view = createCollabViewState({ onConversationChange: (id, value) => drafts.update(id, value) })
  drafts = createConversationViews({ storage: store, view, uuid: () => `draft-${++n}` })
  return { view, drafts }
}
const receipt = body => ({ ...body, id: 'message', home_hub: team.home_hub, team_id: team.id, superagent_id: team.superagent_id, actor: { kind: 'human' }, state: 'accepted' })
test('empty clarification results have no question panel or legacy purpose selector', async () => {
  const source = await readFile(new URL('../packages/collab/conversation-questions.js', import.meta.url), 'utf8')
  assert.match(source, /if \(!state\.items\.length && !target\) return null/)
  assert.doesNotMatch(source, /h\('select'|普通消息（不回答任何问题）|本条消息用途/)
  assert.match(source, /取消关联/)
})

test('question selection changes draft identity, survives reload, and never leaks into another conversation', async () => {
  const store = storage(), first = editor(store), other = { ...team, id: 'other', conversation_id: 'other-conversation' }
  await first.drafts.open(team); await first.drafts.open(other)
  first.view.saveConversation(team, { draft: 'answer', clarificationTarget: a })
  const initial = await first.drafts.flush(team)
  first.view.saveConversation(team, { clarificationTarget: b })
  const changed = await first.drafts.flush(team)
  assert.notEqual(initial.draftToken, changed.draftToken)
  assert.equal(await first.drafts.acknowledge(team, { ...receipt({}), draft_token: initial.draftToken }), false)
  assert.equal(first.view.conversation(other).clarificationTarget, undefined)
  first.drafts.close()
  const next = editor(store); await next.drafts.open(team); await next.drafts.open(other)
  assert.deepEqual(next.view.conversation(team).clarificationTarget, b)
  assert.equal(next.view.conversation(other).clarificationTarget, undefined)
  next.view.saveConversation(team, { clarificationTarget: null })
  assert.equal((await next.drafts.flush(team)).value.clarificationTarget, undefined)
})
test('A/B on one team remain independent; only structured scoped Hub records supply target identities', () => {
  const result = { home_hub: team.home_hub, team_id: team.id, conversation_id: team.conversation_id, items: [a, b].map((target, i) => ({ ...target, run_title: `需求${i}`, questions: [{ id: 'scope', question: '确认范围？' }] })) }
  assert.equal(validateConversationQuestions(team, result).length, 2)
  assert.throws(() => validateConversationQuestions({ ...team, id: 'foreign' }, result), /不匹配/)
  assert.throws(() => validateConversationQuestions(team, { ...result, items: [{ run_title: 'I am run-a', questions: ['question-a'] }] }), /不匹配/)
})
test('lost response and repeated retry preserve exact target, content and request ID; a different target cannot hijack recovery', async () => {
  const store = storage(), calls = []; let committed
  const request = async (path, { body }) => { calls.push({ path, body }); if (body) { committed = receipt(body); throw Error('lost response') } return { message: committed } }
  let outbox = createCollabOutbox({ storage: store, request, uuid: () => 'original' })
  assert.equal((await outbox.send(team, '同时删除所有文件', { clarification_target: a })).state, 'unconfirmed')
  await assert.rejects(outbox.send(team, '同时删除所有文件', { clarification_target: b }), /上一条/)
  outbox.dispose(); outbox = createCollabOutbox({ storage: store, request })
  const result = await outbox.retry(team)
  assert.equal(result.state, 'accepted'); assert.equal(result.request_id, 'original'); assert.deepEqual(result.clarification_target, a)
  assert.equal(calls.filter(call => call.body).length, 1)
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['clarification_target', 'content', 'conversation_id', 'request_id'])
})
test('cancelled/stale target rejection is visible and never clears or accepts the original request', async () => {
  const store = storage(), bodies = []
  const request = async (path, options) => { if (!options.body) return { message: null }; bodies.push(options.body); return requestCollabMessage(path, { ...options, fetcher: async () => ({ ok: false, json: async () => ({ code: 'clarification_rejected', error: 'Hub 拒绝：任务已取消，原回答已保留。' }) }) }) }
  const outbox = createCollabOutbox({ storage: store, request, uuid: () => 'stale' })
  assert.equal((await outbox.send(team, 'answer', { clarification_target: a })).state, 'rejected')
  assert.match(outbox.getSnapshot()[outbox.keyOf(team)].error, /已取消/)
  assert.equal((await outbox.retry(team)).state, 'rejected'); assert.deepEqual(bodies[0], bodies[1])
  assert.equal(store.rows.get(outbox.keyOf(team)).content, 'answer')
})
test('ordinary messages omit target; missing/wrong target receipt cannot claim acceptance', async () => {
  for (const target of [undefined, b]) {
    const outbox = createCollabOutbox({ storage: storage(), uuid: () => 'request', request: async (_, { body }) => ({ ...receipt(body), clarification_target: target }) })
    assert.equal((await outbox.send(team, 'answer', { clarification_target: a })).state, 'unconfirmed')
  }
  let body
  const outbox = createCollabOutbox({ storage: storage(), uuid: () => 'ordinary', request: async (_, options) => { body = options.body; return receipt(body) } })
  assert.equal((await outbox.send(team, 'I am answering question-a')).state, 'accepted'); assert.equal('clarification_target' in body, false)
  await assert.rejects(outbox.send(team, 'bad', { clarification_target: { ...a, permissions: ['delete'] } }), /明确/)
})
test('owner route exposes scoped Hub questions and only forwards an exact target; Hub rejection remains a failure', async () => {
  let route, status, result, failure; const calls = []
  registerConversation({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } }, { backendClient: { call: async (...args) => { calls.push(args); if (failure) throw failure; return {} } } })
  const res = { writeHead: value => { status = value }, end: body => { result = JSON.parse(body) } }
  const request = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } })
  await route.handler({ method: 'GET', url: '/?conversation_id=conversation&view=clarifications' }, res)
  assert.equal(status, 200); assert.deepEqual(calls[0], ['/api/v1/messaging/conversations/conversation/clarifications'])
  const body = { conversation_id: 'conversation', request_id: 'request', content: 'answer', clarification_target: a }
  await route.handler(request(body), res); assert.equal(status, 200); assert.deepEqual(calls[1][1].clarification_target, a)
  for (const target of [null, {}, { ...a, permission: 'execute' }, { ...a, run_id: '../other' }]) { await route.handler(request({ ...body, clarification_target: target }), res); assert.equal(status, 400) }
  await route.handler(request({ ...body, prior_run_id: 'old' }), res); assert.equal(status, 400)
  failure = Object.assign(Error('clarification target must be active work from this conversation'), { status: 409 })
  await route.handler(request(body), res); assert.equal(status, 409); assert.equal(result.code, 'clarification_rejected'); assert.match(result.error, /Hub 拒绝/)
})

test('after a definite rejection, changed target is an explicit new send; unchanged retry keeps its identity', async () => {
  const store = storage(), calls = []; let n = 0
  const outbox = createCollabOutbox({ storage: store, uuid: () => `request-${++n}`, request: async (_, { body }) => {
    if (!body) return { message: null }
    calls.push(body)
    if (body.clarification_target?.run_id === a.run_id) throw Object.assign(Error('Hub rejected expired question'), { confirmedRejection: true })
    return receipt(body)
  } })
  const first = await outbox.send(team, 'answer', { clarification_target: a })
  assert.equal(first.state, 'rejected')
  const repeated = await outbox.send(team, 'answer', { clarification_target: a })
  assert.equal(repeated.request_id, first.request_id)
  const changed = await outbox.send(team, 'answer', { clarification_target: b })
  assert.equal(changed.state, 'accepted'); assert.notEqual(changed.request_id, first.request_id)
  assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[2].clarification_target, b)
})
