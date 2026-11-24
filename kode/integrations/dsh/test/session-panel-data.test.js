import test from 'node:test'
import assert from 'node:assert/strict'
import { relayInput } from '../src/message-pages.js'
import { reviewReference, sessionPanelProjection } from '../src/session-panel-data.js'

const text = value => [{ type: 'text', text: value }]
const assistant = value => ({ type: 'assistant/message', surfaceOp: 'append', data: { message: { content: text(value) } } })
const project = (...events) => {
  const result = events.reduce(sessionPanelProjection.apply, sessionPanelProjection.init())
  return sessionPanelProjection.wire.viewSchema.parse(sessionPanelProjection.wire.view(result))
}

test('review links are unique, canonical and obtained from visible session messages', () => {
  const pr = 'https://git.example/team/project/pull/5'
  const mr = 'https://forge.example/group/team/project/-/merge_requests/12'
  const state = project(
    assistant(`[PR](${pr}/files?private_token=fixture) and ${mr}。`),
    { type: 'user/message', data: { source: { kind: 'user' }, content: text(`${pr}#review`) } },
    { type: 'user/message', surfaceOp: 'replace', data: { source: { kind: 'compact-checkpoint' }, content: text(pr.replace('/5', '/9')) } },
  )
  assert.deepEqual(state.reviews, [
    { url: mr, repo: 'group/team/project', number: '12', kind: 'MR' },
    { url: pr, repo: 'team/project', number: '5', kind: 'PR' },
  ])
  assert.equal(reviewReference('javascript://git.example/team/project/pull/5'), undefined)
  assert.equal(reviewReference('https://user:pass@git.example/team/project/pull/5'), undefined)
})

test('inbound and outbound Kode messages keep their real peer and transport status', () => {
  const source = { node_id: 'host.example', session_id: 'source-session' }
  const target = { node_id: 'local.example', session_id: 'target-session' }
  const inbound = relayInput({ id: 'incoming', source, target, content: 'A requested review', in_reply_to: 'earlier' }, 'input-id')
  const outbound = { id: 'outgoing', target: source, content: 'Reviewed', status: 'queued', in_reply_to: inbound.id }
  const result = (id, payload) => ({ type: 'tool/result', data: { message: { source: { callId: id }, content: text(JSON.stringify(payload)) } } })
  const state = project(
    { type: 'user/message', data: { ...inbound, source: { kind: 'user' } } },
    { type: 'user/message', data: inbound },
    result('unrelated', { message: outbound }),
    { type: 'tool/call', data: { callId: 'native-call', name: 'kode_native_mcpToolCall', arguments: JSON.stringify({ tool: 'kode_sessions_send' }) } },
    result('native-call', { result: { content: text(JSON.stringify({ message: outbound })) } }),
    { type: 'tool/call', data: { callId: 'direct-call', name: 'kode_sessions_send' } },
    result('direct-call', { message: outbound }),
  )
  assert.deepEqual(state.relays, [
    { id: 'incoming', nodeId: source.node_id, sessionId: source.session_id, direction: 'received', reply: true, content: 'A requested review' },
    { id: 'outgoing', nodeId: source.node_id, sessionId: source.session_id, direction: 'sent', reply: true, status: 'queued', content: 'Reviewed' },
  ])
})
