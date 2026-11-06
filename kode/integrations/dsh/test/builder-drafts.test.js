/** Real HTTP + SQLite recovery; interview writes must never activate a team. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
test('Builder interviews survive concurrent edits, lost replies and Hub restart without execution', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('builder-home')
  try {
    const path = '/api/v1/messaging/superagents/drafts'
    const registered = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registered.owner_token)
    const command = { id: 'interview', request_id: 'start', expected_revision: 0, revoked: false,
      interview: { purpose: 'Configure a project team', workspace_refs: [], answers: {}, questions: [{ id: 'delivery', prompt: 'Where should delivery stop?' }], proposed_team: null } }
    await assert.rejects(worker.call(path, command), /403/)
    for (const interview of [
      { ...command.interview, questions: Array.from({ length: 4 }, (_, n) => ({ id: `q${n}`, prompt: 'Question' })) },
      { ...command.interview, questions: [command.interview.questions[0], command.interview.questions[0]] },
      { ...command.interview, answers: { delivery: 'x'.repeat(8193) } },
      { ...command.interview, activate: true },
    ]) await assert.rejects(hub.client.call(path, { ...command, interview }), /400|422/)
    const first = await hub.client.call(path, command)
    assert.equal(first.revision, 1); assert.equal(first.home_hub, hub.node); assert.equal(first.eligible_for_execution, false)
    const malformed={...command,request_id:'malformed',expected_revision:1,
      interview:{...command.interview,proposed_team:{name:'Incomplete'}}}
    await assert.rejects(worker.call(path,malformed),error=>error.status===403)
    await assert.rejects(hub.client.call(path,malformed),error=>error.status===422&&error.path===path&&/missing field/.test(error.message))
    assert.deepEqual(await hub.client.call(`${path}/interview`),first)
    assert.equal((await hub.client.call(`${path}/interview/commands/malformed`)).receipt,null)
    assert.deepEqual(await hub.client.call(path, command), first)
    await assert.rejects(worker.call(`${path}/interview`), /403/)
    await assert.rejects(hub.client.call(path, { ...command, revoked: true }), /identity conflict/)
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'stale' }), /revision conflict/)
    const answers = await Promise.allSettled(['local', 'review_request'].map(endpoint => hub.client.call(path, {
      ...command, request_id: endpoint, expected_revision: 1,
      interview: { ...command.interview, answers: { delivery: endpoint }, questions: [] },
    })))
    assert.equal(answers.filter(r => r.status === 'fulfilled').length, 1)
    assert.match(answers.find(r => r.status === 'rejected').reason.message, /revision conflict/)
    const latest = answers.find(r => r.status === 'fulfilled').value
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/interview`), latest)
    assert.deepEqual(await hub.client.call(path, command), first, 'historical retry is immutable')
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items, [], 'interview cannot create even an inactive team')
    await assert.rejects(hub.client.call(path, { ...command, expected_revision: 2, request_id: 'reask', interview: { ...command.interview, answers: { delivery: 'local' } } }), /invalid Builder draft/)
    const revoke = { ...command, expected_revision: 2, request_id: 'revoke', revoked: true, interview: latest.interview }
    const terminal = await hub.client.call(path, revoke)
    assert.equal(terminal.status, 'revoked'); assert.equal(terminal.revision, 3)
    await assert.rejects(hub.client.call(path, { ...command, expected_revision: 3, request_id: 'resurrect' }), /revoked/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path, revoke), terminal)
    assert.deepEqual(await hub.client.call(`${path}/interview`), terminal)
    await hub.client.call(path, { ...command, id: 'second' })
    const page = await hub.client.call(`${path}?limit=1`)
    assert.equal(page.items.length, 1); assert.equal(page.items[0].revision, 3)
    assert.equal(page.items[0].status, 'revoked'); assert.equal(page.next_cursor, 'interview')
    assert.equal(page.items[0].interview, undefined, 'directory does not expose full answers')
    const next = await hub.client.call(`${path}?limit=1&after=${page.next_cursor}`)
    assert.equal(next.items[0].id, 'second'); assert.equal(next.next_cursor, null)
    await assert.rejects(worker.call(path), /403/)
  } finally { await hub.close() }
})
