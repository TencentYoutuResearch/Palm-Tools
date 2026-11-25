import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithWorkspaceSessionCreation } from '../packages/transport/session-creation.js'

const endpoint = 'api/session/create'
const reason = 'use subagent delivery for this child session'
const childId = 'child-session'
const create = (request, signal) => ({ method: 'POST', signal, body: JSON.stringify({
  type: 'client-request', rpcId: 'fixture-request', method: 'session/create', payload: { args: { request } },
}) })
const response = (result, rpcId = 'fixture-request') => Response.json({ type: 'server-response', rpcId, result })
const failure = (code, details = {}) => response({ ok: false, error: { code, message: 'fixture failure', details } })
const ownershipFailure = () => failure('session/agent-busy', { reason })

test('workspace reuse declined by subagent routing mints a fresh session with the same preset', async () => {
  const signal = new AbortController().signal
  const initialRequest = { workspaceId: 'workspace-fixture', agentPreset: 'kode-native', sessionId: childId }
  const initial = create(initialRequest, signal)
  let seen, attempts = 0
  const created = await fetchWithWorkspaceSessionCreation(endpoint, initial, async (path, init) => {
    assert.equal(path, endpoint)
    assert.equal(init.signal, signal)
    const envelope = JSON.parse(init.body)
    assert.equal(envelope.rpcId, 'fixture-request')
    if (++attempts === 1) { assert.equal(init, initial); return ownershipFailure() }
    seen = envelope.payload.args.request
    return response({ ok: true, value: { sessionId: 'new-session' } })
  })
  assert.equal(attempts, 2)
  assert.deepEqual(seen, { workspaceId: 'workspace-fixture', agentPreset: 'kode-native' })
  assert.equal(JSON.parse(initial.body).payload.args.request.sessionId, childId)
  assert.equal((await created.json()).result.value.sessionId, 'new-session')
})

test('ordinary success and unrelated errors pass through without a second create', async () => {
  for (const [path, request, original] of [
    [endpoint, { workspaceId: 'work', sessionId: childId }, response({ ok: true, value: { sessionId: childId } })],
    [endpoint, { workspaceId: 'work', sessionId: childId }, failure('session/agent-busy')],
    [endpoint, { workspaceId: 'work', sessionId: childId }, failure('session/workspace-attach-failed', { reason })],
    [endpoint, { workspaceId: 'work', sessionId: childId }, response({ ok: false, error: { code: 'session/agent-busy', details: { reason } } }, 'other-rpc')],
    [endpoint, { workspaceId: 'work' }, ownershipFailure()],
    [endpoint, { cwd: '/tmp/example', sessionId: childId }, ownershipFailure()],
    ['api/subagents/prompt', { workspaceId: 'work', sessionId: childId }, ownershipFailure()],
  ]) {
    let attempts = 0
    const returned = await fetchWithWorkspaceSessionCreation(path, create(request), async () => { attempts++; return original })
    assert.equal(returned, original)
    assert.equal(attempts, 1)
    assert.equal(returned.bodyUsed, false)
  }
})

test('cancelling the first create prevents the fallback mutation', async () => {
  const controller = new AbortController()
  const aborted = Error('navigation superseded')
  let attempts = 0
  await assert.rejects(fetchWithWorkspaceSessionCreation(endpoint, create({ workspaceId: 'work', sessionId: childId }, controller.signal), async () => {
    attempts++; controller.abort(aborted); return ownershipFailure()
  }), aborted)
  assert.equal(attempts, 1)
})
