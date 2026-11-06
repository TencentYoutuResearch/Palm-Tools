/** Actual home-Hub team draft revisions: no runtime/session creation or implicit activation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
const spec = name => ({ name, purpose: 'Deliver configured project work', kind: 'coordinator', workspace_refs: [], execution_targets: [], workers: [], coordinator_targets: [], workflow_pack_refs: [], grant_id: null, budget_policy_id: null, scheduling_policy_id: null, limits: { max_active_assignments: 4, max_active_runs: 2 }, proactive_mode: 'off' })
test('team identities survive edits/retries and home restart while drafts remain non-executable', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('team-home')
  try {
    const path = '/api/v1/messaging/teams'
    const registration = await hub.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Worker', runtime: 'external' })
    const worker = hub.client.forSession(registration.owner_token)
    const command = { id: 'team-a', expected_revision: 0, request_id: 'create-a', spec: spec('Project A') }
    await assert.rejects(worker.call(path, command), /403/)
    await assert.rejects(worker.call(path), /403/)
    await assert.rejects(hub.client.call(path, { ...command, home_hub: 'foreign' }), /422/)
    const first = await hub.client.call(path, command)
    assert.equal(first.home_hub, hub.node); assert.equal(first.revision, 1)
    assert.equal(first.status, 'draft'); assert.equal(first.eligible_for_execution, false)
    assert.equal(first.active_revision, null)
    assert.ok(first.superagent_id); assert.ok(first.conversation_id)
    assert.notEqual(first.superagent_id, first.conversation_id)
    assert.deepEqual(await hub.client.call(path, command), first, 'lost-response retry returns exact first identity')
    assert.deepEqual(await hub.client.call(path, { ...command, spec: { ...command.spec, delivery_bindings: [] } }), first, 'empty binding field preserves legacy request identity')
    await assert.rejects(hub.client.call(path, { ...command, spec: spec('conflict') }), /request identity conflict/)
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'stale' }), /revision conflict/)
    await assert.rejects(hub.client.call(path, { ...command, expected_revision: 1, request_id: 'kind-change', spec: { ...spec('Builder'), kind: 'builder' } }), /kind is immutable/)
    await assert.rejects(hub.client.call(path, { id: 'invalid', expected_revision: 0, request_id: 'invalid', spec: { ...spec('Invalid'), coordinator_targets: ['missing'] } }), /unknown.*target/)
    await assert.rejects(hub.client.call(path, { id: 'invalid-revision', request_id: 'bad', expected_revision: 0, spec: { ...spec('Invalid'), execution_targets: [
      { id: 't', host_id: 'host', executor_profile_id: 'profile', executor_profile_revision: 'capability-version-1', provider_id: 'fixture', model_id: 'model', effort: null, account_binding_id: 'account', capability_profile_revision: '1' },
    ] } }), /execution target/)
    for (const startup of [{workspace_id:'missing',task_tag:'coordination'},{workspace_id:'workspace',task_tag:''}]) {
      await assert.rejects(hub.client.call(path,{id:'invalid-startup',request_id:'bad',expected_revision:0,spec:{...spec('Invalid startup'),coordinator_startup:startup}}),/Coordinator startup/)
    }
    const second = await hub.client.call(path, { ...command, expected_revision: 1, request_id: 'edit-a', spec: spec('Renamed A') })
    assert.equal(second.revision, 2)
    assert.equal(second.superagent_id, first.superagent_id); assert.equal(second.conversation_id, first.conversation_id)
    assert.deepEqual(await hub.client.call(`${path}/team-a/revisions/1`), first)
    assert.deepEqual(await hub.client.call(`${path}/team-a`), second)
    await hub.client.call(path, { id: 'team-b', expected_revision: 0, request_id: 'create-b', spec: spec('Project B') })
    const page = await hub.client.call(`${path}?limit=1`)
    assert.deepEqual(page.items.map(row => row.id), ['team-a']); assert.equal(page.next_cursor, 'team-a')
    assert.deepEqual((await hub.client.call(`${path}?limit=1&after=${page.next_cursor}`)).items.map(row => row.id), ['team-b'])
    await assert.rejects(worker.call(`${path}/team-a/revisions/1`), /403/)
    const race = await Promise.allSettled(['left', 'right'].map(name => hub.client.call(path, {
      ...command, expected_revision: 2, request_id: `race-${name}`, spec: spec(name),
    })))
    assert.equal(race.filter(result => result.status === 'fulfilled').length, 1)
    assert.match(race.find(result => result.status === 'rejected').reason.message, /revision conflict/)
    const latest = race.find(result => result.status === 'fulfilled').value
    assert.equal(latest.revision, 3); assert.equal(latest.superagent_id, first.superagent_id)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/team-a`), latest)
    assert.deepEqual(await hub.client.call(path, command), first, 'old idempotent reply stays stable after a newer edit/restart')
    const audit = await hub.client.call(`${path}/team-a/events?after=0`)
    assert.deepEqual(audit.events.map(event => event.data.revision), [1, 2, 3])
    assert.ok(audit.events.every(event => event.data.actor.kind === 'human' && event.data.home_hub === hub.node))
    assert.deepEqual((await hub.client.call(`${path}/team-a/events?after=${audit.events[0].seq}`)).events.map(event => event.data.revision), [2, 3])
    await assert.rejects(worker.call(`${path}/team-a/events?after=0`), /403/)
  } finally { await hub.close() }
})
