import test from 'node:test'
import assert from 'node:assert/strict'
import { acpSubagents, codexSubagents, foldNativeSubagent, nativeSubagentRecord, nativeSubagentsProjection, subagentStatus } from '../src/native-subagents.js'

test('native child statuses follow execution evidence and tolerate new states', () => {
  assert.equal(subagentStatus('idle'), 'idle')
  assert.equal(subagentStatus('pendingInit'), 'running')
  assert.equal(subagentStatus('completed'), 'completed')
  assert.equal(subagentStatus('errored'), 'failed')
  assert.equal(subagentStatus('notFound'), 'disconnected')
  assert.equal(subagentStatus('future-status'), 'unknown')
})
test('Claude AIR, ACP draft, CodeBuddy teams and Codex preserve distinct child identities', () => {
  assert.equal(acpSubagents({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'claude-child', name: 'Verifier' })[0].status, 'running')
  assert.equal(acpSubagents({ sessionUpdate: 'subagent_update', sessionId: 'draft-child', state: { state: 'completed' } })[0].status, 'completed')
  assert.equal(acpSubagents({ _meta: { 'codebuddy.ai/teamUpdate': { members: [{ sessionId: 'buddy-child', name: 'Reviewer', status: 'idle' }] } } })[0].status, 'idle')
  const [child] = codexSubagents({ type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['codex-child'], agentsStates: { 'codex-child': { status: 'running' } } })
  assert.equal(child.status, 'running', 'a successful spawn does not mean the child completed')
  assert.equal(codexSubagents({ type: 'collabAgentToolCall', tool: 'closeAgent', status: 'completed', receiverThreadIds: ['codex-child'] })[0].status, 'cancelled')
  assert.equal(codexSubagents({ type: 'collabAgentToolCall', tool: 'closeAgent', status: 'completed', agentsStates: { 'codex-child': { status: 'idle' } } })[0].status, 'cancelled')
  assert.deepEqual(codexSubagents({ type: 'commandExecution' }), [])
})
test('child projection bounds output, retains running state across deltas, and restores from persisted observations', () => {
  let state = foldNativeSubagent({}, { id: 'child', name: 'Reviewer', status: 'running', delta: 'first' })
  state = foldNativeSubagent(state, { id: 'child', delta: ' second' })
  assert.equal(state.child.output, 'first second')
  assert.equal(state.child.status, 'running')
  state = foldNativeSubagent(state, { id: 'child', text: 'x'.repeat(40000), status: 'completed' })
  assert.equal(state.child.output.length, 32768)
  assert.equal(state.child.status, 'completed')
  assert.deepEqual(nativeSubagentRecord({ id: 'child', delta: 'text', unrecognized: 'ignored' }), { id: 'child', delta: 'text' })
  assert.equal(nativeSubagentRecord({ id: '' }), undefined)
})

test('only live parent connections project active child status after a restart or history replay', () => {
  const records = [
    { id: 'old', status: 'running', delta: 'Retained output' },
    nativeSubagentRecord({ id: 'replayed', status: 'running', replay: true }),
    nativeSubagentRecord({ id: 'live', status: 'awaiting' }),
  ]
  const state = records.reduce(foldNativeSubagent, {})
  const view = nativeSubagentsProjection.wire.view(state)
  assert.equal(view.old.status, 'disconnected')
  assert.equal(view.old.output, 'Retained output')
  assert.equal(view.replayed.status, 'disconnected')
  assert.equal(view.live.status, 'awaiting')
  const stopped = foldNativeSubagent(state, nativeSubagentRecord({ id: 'live', status: 'cancelled' }))
  assert.equal(nativeSubagentsProjection.wire.view(stopped).live.status, 'cancelled')
})
