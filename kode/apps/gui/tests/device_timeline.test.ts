import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTimeline,
  commandFailure,
  liveStatus,
  relayDelivery,
  relayToolTitleKey,
  sessionNameFor,
} from '../src/lib/device_timeline.ts'

const ev = (type: string, ts: number, payload: Record<string, any>) => ({ type, ts, payload })

test('tool updates merge into one item and keep earlier fields', () => {
  const items = buildTimeline([
    ev('tool_use', 2, { tool_use_id: 't', tool: 'Bash', status: 'running', input_summary: 'ls' }),
    ev('message', 1, { id: 'm', role: 'assistant', text: 'hi' }),
    ev('tool_use', 3, { tool_use_id: 't', status: 'ok', input_summary: null, output_preview: 'a' }),
    ev('session.status', 4, { status: 'idle' }),
  ])
  assert.deepEqual(items.map((i) => i.key), ['message-m', 'tool_use-t'])
  assert.equal(items[1].payload.status, 'ok')
  assert.equal(items[1].payload.input_summary, 'ls')
})

test('questions stay pending until cleared, answered or followed by user input', () => {
  const ask = ev('ask_user_question', 5, { question_id: 'q', question: 'Which?', options: [] })
  assert.equal(buildTimeline([ask])[0].pending, true)
  assert.equal(buildTimeline([ask, ev('session.attention_cleared', 6, {})])[0].pending, false)
  assert.equal(buildTimeline([ask, ev('message', 7, { id: 'u', role: 'user', text: 'A' })])[0].pending, false)
  const acp = ev('ask_user_question', 5, { request_id: 'r', options: [] })
  assert.equal(buildTimeline([acp, ev('interaction.resolved', 6, { request_id: 'r' })])[0].pending, false)
  // A clear before the question does not resolve it.
  assert.equal(buildTimeline([ev('session.attention_cleared', 1, {}), ask])[0].pending, true)
})

test('status follows the newest status event in the window', () => {
  assert.equal(liveStatus([], 'idle'), 'idle')
  assert.equal(liveStatus([ev('session.status', 2, { status: 'busy' }), ev('session.status', 1, { status: 'idle' })], 'idle'), 'busy')
  assert.equal(liveStatus([ev('session.status', 1, { status: 'busy' }), ev('session.exited', 2, {})], 'idle'), 'exited')
})

test('only failures of own commands are reported', () => {
  const events = [
    ev('command.status', 1, { command_id: 'other', status: 'failed', error: 'x' }),
    ev('command.status', 2, { command_id: 'mine', status: 'dispatched' }),
    ev('command.status', 3, { command_id: 'mine', status: 'failed', error: 'offline' }),
  ]
  assert.equal(commandFailure(events, ['mine']), 'offline')
  assert.equal(commandFailure(events, ['none']), null)
})

test('session names resolve kode addresses only', () => {
  const sessions = [{ backend_key: 'claude', title: ' Fix nav ', session_uuid: 'u1' }]
  assert.equal(sessionNameFor('kode:claude:u1', sessions), 'Fix nav')
  assert.equal(sessionNameFor('kode:codex:u1', sessions), null)
  assert.equal(sessionNameFor('node-a/session-b', sessions), null)
  assert.equal(sessionNameFor(undefined, sessions), null)
})

test('session tools get readable titles and send-time delivery', () => {
  assert.equal(relayToolTitleKey({ op: 'send' }), 'devices.tool.send')
  assert.equal(relayToolTitleKey({ op: 'send', in_reply_to: 'm' }), 'devices.tool.reply')
  assert.equal(relayToolTitleKey({ op: 'weird' }), 'devices.tool.other')
  assert.equal(relayDelivery({ output_preview: '{"message":{"status":"accepted"}}' }), 'accepted')
  assert.equal(relayDelivery({ output_preview: '{"message":{"sta' }), null)
  assert.equal(relayDelivery({ output: { message: { status: 'queued' } } }), 'queued')
})

test('questions asked together become one card in order', () => {
  const items = buildTimeline([
    ev('ask_user_question', 2, { question_id: 'tooluse_a-1', question: 'Second' }),
    ev('ask_user_question', 2, { question_id: 'tooluse_a-0', question: 'First' }),
    ev('ask_user_question', 3, { question_id: 'tooluse_b-0', question: 'Other' }),
  ])
  assert.equal(items.length, 2)
  assert.deepEqual(items[0].questions?.map((q) => q.question), ['First', 'Second'])
  assert.equal(items[1].questions?.length, 1)
})
