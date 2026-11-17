import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationRequestEvidence } from '../src/scoped-conversation-request.js'
const route = { provider: 'original-provider', model: 'original-model' }, scope = { sessionId: 'own-session', route }
const request = () => ({ sessionId: scope.sessionId, ...route, messages: [{ role: 'system', content: 'PUBLIC' }, { role: 'user', content: 'SOURCE_A' }] })
test('actual request evidence is stable across transport cancellation and optional empty tools', () => {
  const a = conversationRequestEvidence(request(), scope)
  const b = conversationRequestEvidence({ ...request(), signal: new AbortController().signal, tools: [], toolHistory: [] }, scope)
  assert.deepEqual(a, b); assert.match(a.request_sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(a, conversationRequestEvidence({ ...request(), toolHistory: { tools: [], updates: [] } }, scope))
  assert.doesNotMatch(JSON.stringify(a), /PUBLIC|SOURCE_A/)
})
test('request evidence changes for scope content, model metadata, and message ordering', () => {
  const base = conversationRequestEvidence(request(), scope)
  const changed = request(); changed.messages[1].content = 'SOURCE_B'
  assert.notEqual(conversationRequestEvidence(changed, scope).request_sha256, base.request_sha256)
  assert.notEqual(conversationRequestEvidence({ ...request(), messages: request().messages.reverse() }, scope).request_sha256, base.request_sha256)
  assert.throws(() => conversationRequestEvidence({ ...request(), model: 'other' }, scope))
})
test('empty-tool profile refuses tools, tool history, foreign session and unsupported content', () => {
  for (const patch of [{ tools: [{ name: 'read_other_thread' }] }, { toolHistory: [{}] },
    { toolHistory: { tools: [], updates: [{ messageId: 'foreign', additions: [] }] } },
    { toolHistory: { tools: [], updates: [], extra: 'foreign' } }, { sessionId: 'foreign' },
    { messages: [{ role: 'tool', content: 'FOREIGN' }] }, { messages: [{ role: 'user', content: NaN }] }, { secretContext: 'FOREIGN' }]) {
    assert.throws(() => conversationRequestEvidence({ ...request(), ...patch }, scope))
  }
})
