import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { installRuntimeInteractions, questionAnswer } from '../src/runtime-interactions.js'

async function fixture(policy = 'ask') {
  const ctx = new Context(); const sessions = await ctx.plugin(SessionStore), approval = await ctx.plugin(ApprovalService, { policy })
  const session = ctx.sessions.prepare('interaction-test'); const detach = ctx.sessions.enter(session)
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  const agent = { id: session.id, session, ctx }
  const questions = { ctx, assertLiveRoot() {}, ask: UserQuestionService.prototype.ask }
  ctx.provide('userQuestions', questions)
  const bridge = { mobileEnabled: true, pending: new Map() }, dispose = installRuntimeInteractions(ctx, bridge)
  return { ctx, session, agent, bridge, async close() { dispose(); detach(); await approval.dispose(); await sessions.dispose() } }
}
async function pending(bridge) {
  for (let count = 0; count < 100; count++) { if (bridge.pending.size) return [...bridge.pending.entries()][0]; await new Promise(resolve => setImmediate(resolve)) }
  throw new Error('No mobile interaction was published')
}

test('mobile approval preserves the real dsh policy and its audit outcome', async () => {
  const h = await fixture()
  try {
    const controller = new AbortController(), original = Object.freeze({ agent: h.agent, toolName: 'shell', reason: 'Run the requested check', signal: controller.signal })
    const outcome = h.ctx.approval.request(original)
    const [id, request] = await pending(h.bridge)
    assert.equal(request.sessionId, h.agent.id)
    request.answer({ response: { optionId: 'allowed-once' } })
    assert.equal(await outcome, 'allowed-once'); assert.equal(original.signal, controller.signal); assert.equal(controller.signal.aborted, false)
    assert.equal(h.session.snapshotEvents().findLast(event => event.type === 'approval/decided').data.outcome, 'allowed-once')
    assert.equal(h.session.snapshotEvents().findLast(event => event.type === 'plugin:kode/shared-interaction').data.state, 'closed')
    assert.ok(!h.bridge.pending.has(id))
  } finally { await h.close() }
  const confined = await fixture('never')
  try { assert.equal(await confined.ctx.approval.request({ agent: confined.agent, toolName: 'shell' }), 'rejected'); assert.equal(confined.bridge.pending.size, 0) }
  finally { await confined.close() }
})

test('the existing dsh UI may win, and the competing mobile card is withdrawn', async () => {
  const h = await fixture()
  try {
    h.ctx.on('approval/request', () => 'rejected')
    assert.equal(await h.ctx.approval.request({ agent: h.agent, toolName: 'shell' }), 'rejected')
    assert.equal(h.bridge.pending.size, 0)
  } finally { await h.close() }
})

test('mobile questions survive the real service request copy and return structured answers', async () => {
  const h = await fixture()
  try {
    const original = Object.freeze({ agent: h.agent, questions: [{ id: 'choice', question: 'Choose a target', options: [{ label: 'Local' }, { label: 'Remote' }] }, { id: 'detail', question: 'Add detail' }] })
    const outcome = h.ctx.userQuestions.ask(original)
    const [, request] = await pending(h.bridge)
    assert.throws(() => request.answer({ response: { action: 'accept', content: { choice: 'Local' } } }), /Answer required/)
    request.answer({ response: { action: 'accept', content: { choice: 'Remote', detail: 'Use the test Host' } } })
    assert.deepEqual(await outcome, { answers: [{ id: 'choice', selected: ['Remote'] }, { id: 'detail', selected: [], custom: 'Use the test Host' }] })
    assert.equal(original.signal, undefined); assert.equal(h.bridge.pending.size, 0)
  } finally { await h.close() }
  assert.throws(() => questionAnswer([{ id: 'one' }], { action: 'cancel' }), /cancelled/)
})
