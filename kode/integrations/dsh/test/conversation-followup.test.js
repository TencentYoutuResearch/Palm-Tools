import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'

test('human follow-up requires same-team terminal work and preserves exact receipts across Hub restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('conversation-followup')
  const call = (path, body) => hub.client.call(`/api/v1/messaging/${path}`, body)
  try {
    const team = await conversationTeam(hub), path = `conversations/${team.conversation_id}/messages`
    const body = { request_id: 'followup', content: '按反馈修改', prior_run_id: 'prior' }
    await assert.rejects(call(path, body), /terminal work from this team/)
    const run = await call('work-runs', { id: 'prior', request_id: 'prior', team_id: team.id, team_revision: 1, binding_id: 'local', inputs: { request: 'Original requirement' }, prior_run_id: null })
    await assert.rejects(call(path, body), /terminal work from this team/)
    await call('work-runs/prior', { action: 'cancel', request_id: 'stop', expected_revision: run.revision })
    const registration = await call('sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(registration.owner_token).call(`/api/v1/messaging/${path}`, body), /403/)
    const accepted = await call(path, body)
    assert.equal(accepted.prior_run_id, 'prior')
    await assert.rejects(call(path, { ...body, prior_run_id: 'different' }), /identity conflict/)
    const { prior_run_id, ...unlinked } = body
    await assert.rejects(call(path, unlinked), /identity conflict/)
    const other = await call('teams', { id: 'other', request_id: 'other', expected_revision: 0, spec: team.spec })
    await assert.rejects(call(`conversations/${other.conversation_id}/messages`, body), /terminal work from this team/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await call(path, body), accepted)
    assert.deepEqual((await call(`conversations/${team.conversation_id}/requests/followup`)).message, accepted)
    assert.equal((await call(path)).items.length, 1)
  } finally { await hub.close() }
})
