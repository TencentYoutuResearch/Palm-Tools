import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionExecutionState as state, trackSessionWaiting } from '../src/session-runtime-state.js'
const ended = kind => [{ type: 'turn/start' }, { type: 'turn/end', data: { reason: { kind } } }]
test('presence and idle do not fabricate completion', () => {
  assert.equal(state({ agent: { status: 'idle' } }), 'unknown')
  assert.equal(state({ events: [], unavailable: true }), 'unknown')
  assert.equal(state({ events: [], saved: true }), 'unknown')
  assert.equal(state({ events: [] }), 'not_started')
  assert.equal(state({ events: [{ type: 'turn/start' }] }), 'unknown')
  assert.equal(state({ events: [{ type: 'assistant/message' }] }), 'unknown')
})
test('live waiting and running outrank past results; outcomes require explicit evidence', () => {
  for (const [kind, expected] of [['completed','completed'],['error','failed'],['aborted','interrupted'],['interrupted','interrupted'],['other','unknown']]) assert.equal(state({ events: ended(kind) }), expected)
  assert.equal(state({ agent: { status: 'running' }, events: ended('completed') }), 'running')
  assert.equal(state({ waiting: true, agent: { status: 'running' } }), 'waiting')
  assert.equal(state({ agent: { inbox: { nextTurn: [{}] } }, events: ended('completed') }), 'waiting')
  assert.equal(state({ agent: { disposed: true }, events: ended('completed') }), 'unknown')
  assert.equal(state({ agent: { parked: true, lastError: new Error('startup failure'), inbox: { nextTurn: [{}] } } }), 'failed')
})
test('blocking prompt observation is reference counted and preserves policy outcomes', async () => {
  const callbacks = new Map(), disposed = []
  const tracker = trackSessionWaiting({ on: (name, callback) => { callbacks.set(name, callback); return () => disposed.push(name) } })
  let release
  const first = callbacks.get('approval/request')({ agent: { id: 'a' } }, () => new Promise(resolve => { release = resolve }))
  assert.equal(tracker.has('a'), true)
  await assert.rejects(callbacks.get('user-questions/request')({ agent: { id: 'a' } }, async () => { throw new Error('cancelled') }), /cancelled/)
  assert.equal(tracker.has('a'), true)
  release('rejected'); assert.equal(await first, 'rejected'); assert.equal(tracker.has('a'), false)
  tracker.dispose(); assert.equal(disposed.length, 2)
})

test('direct insert capability requires a bound ordinary interrupt-capable agent', async () => {
  const { RuntimeBridge } = await import('../src/runtime-bridge.js')
  let binding = { profile: { id: 'fixture', name: 'Fixture' } }
  const bridge = new RuntimeBridge({ kodeAgents: { profiles: { binding: () => binding } } }, {})
  const row = { sessionId: 'fixture' }, agent = { session: { header: {}, snapshotEvents: () => [] }, interruptAndInsert() {} }
  assert.equal(bridge.projection(row, agent).direct_insert_supported, true)
  assert.equal(bridge.projection(row, { session: agent.session }).direct_insert_supported, false)
  for (const role of ['managedOperation', 'managedAssignment', 'managedCoordinator', 'managedBuilder']) {
    binding[role] = {}; assert.equal(bridge.projection(row, agent).direct_insert_supported, false); delete binding[role]
  }
  binding = undefined
  assert.equal(bridge.projection(row, agent).direct_insert_supported, false)
})
