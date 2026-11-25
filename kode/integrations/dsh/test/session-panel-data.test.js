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
  const inbound = relayInput({ id: 'incoming', source, target, content: 'A requested review', title: 'Review details', in_reply_to: 'earlier' }, 'input-id')
  const outbound = { id: 'outgoing', target: source, content: 'Reviewed', title: 'Review complete', status: 'queued', in_reply_to: 'incoming' }
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
    { id: 'incoming', nodeId: source.node_id, sessionId: source.session_id, direction: 'received', reply: true, replyTo: 'earlier', title: 'Review details', content: 'A requested review' },
    { id: 'outgoing', nodeId: source.node_id, sessionId: source.session_id, direction: 'sent', reply: true, replyTo: 'incoming', title: 'Review complete', status: 'queued', content: 'Reviewed' },
  ])
})

test('explicit wait records the peer reply once and ignores delivery receipts or unrelated rows', () => {
  const local = { node_id: 'local.example', session_id: 'me' }
  const peer = { node_id: 'peer.example', session_id: 'reviewer' }
  const request = { id: 'request', source: local, target: peer, content: 'Please read the report', title: 'Report review' }
  const reply = { id: 'reply', source: peer, target: local, content: 'Reviewed it', title: 'Review result', in_reply_to: 'request' }
  const result = (callId, payload) => ({ type: 'tool/result', data: { message: { source: { callId }, content: text(JSON.stringify(payload)) } } })
  const state = project(
    { type: 'tool/call', data: { callId: 'send', name: 'kode_sessions_send' } },
    result('send', { message: request }),
    { type: 'tool/call', data: { callId: 'wait', name: 'kode_native_mcpToolCall', arguments: JSON.stringify({ tool: 'kode_sessions_wait' }) } },
    result('wait', { result: { structuredContent: { events: [
      { message: { ...request, status: 'accepted' } },
      { message: { ...reply, id: 'other', source: { ...peer, session_id: 'other' } } },
      { message: { ...reply, id: 'unrelated', in_reply_to: 'other' } },
      { message: reply },
      { message: { ...reply, status: 'accepted' } },
    ] } } }),
  )
  assert.equal(state.relays[0].answered, true)
  assert.deepEqual(state.relays.map(({ id, direction, title, replyTo }) => ({ id, direction, title, replyTo })), [
    { id: 'request', direction: 'sent', title: 'Report review', replyTo: undefined },
    { id: 'reply', direction: 'received', title: 'Review result', replyTo: 'request' },
  ])
})

test('a confirmed reply survives an idempotent send retry after the reply leaves the recent list', () => {
  const local = { node_id: 'local.example', session_id: 'me' }
  const peer = { node_id: 'peer.example', session_id: 'reviewer' }
  const request = { id: 'request', source: local, target: peer, content: 'Review the report', title: 'Report review' }
  const send = callId => [
    { type: 'tool/call', data: { callId, name: 'kode_sessions_send' } },
    { type: 'tool/result', data: { message: { source: { callId }, content: text(JSON.stringify({ message: request })) } } },
  ]
  const inbound = (id, in_reply_to) => ({
    type: 'user/message',
    data: relayInput({ id, source: peer, target: local, content: 'Peer message', in_reply_to }, `input-${id}`),
  })
  const view = project(
    ...send('send'), inbound('reply', 'request'), ...send('retry'),
    ...Array.from({ length: 23 }, (_, i) => inbound(`more-${i}`)),
  )
  assert.equal(view.relays.some(row => row.id === 'reply'), false)
  assert.equal(view.relays.find(row => row.id === 'request').answered, true)
})
