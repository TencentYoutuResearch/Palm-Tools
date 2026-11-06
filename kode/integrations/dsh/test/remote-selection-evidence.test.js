/** Real paired Hubs; selection evidence must return to its sole home ledger. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub, pairHubs } from './support/isolated-hub.js'

test('remote selection evidence authenticates its assigned Host and deduplicates after home restart', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  let home, remote, foreign
  try {
    home = await isolatedHub('selection-home'); remote = await isolatedHub('selection-worker'); foreign = await isolatedHub('selection-foreign')
    await pairHubs(home, remote); await pairHubs(home, foreign)
    const registration = await remote.client.call('/api/v1/messaging/sessions', { session_id: 'worker', title: 'Fixture', runtime: 'external' })
    const worker = remote.client.forSession(registration.owner_token)
    const op = await home.client.call('/api/v1/messaging/operations', { owner_session: 'owner', request_key: 'selection', worker: { node_id: remote.node, session_id: 'worker' } })
    const route = `/api/v1/messaging/operation-accounting-relay/${home.node}`
    const input = {
      record_id: 'observation', operation_id: op.id, worker_session: 'worker', attempt: 1, epoch: 1,
      profile_revision: 'revision', thread_id: 'thread', turn_id: 'turn', input_ids: ['input'],
      scope: 'executor_configuration', observed_at: 1, rejected: false,
      model: { requested: 'chosen', observed: 'different', status: 'reported', source: 'session/set_config_option' },
      effort: { requested: null, observed: null, status: 'unverifiable', source: null },
    }
    const envelope = evidence => ({ operation_id: op.id, worker_session: 'worker', command: null, accounting: { attempt: 1, action: { kind: 'selection_evidence', evidence } } })
    await assert.rejects(worker.call(route, envelope(input)), /403/)
    await assert.rejects(remote.client.call(route, envelope(input)), /admitted attempt/)
    const operationRoute = `/api/v1/messaging/operation-relay/${home.node}`
    const active = await worker.call(operationRoute, { operation_id: op.id, worker_session: 'worker', command: { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } } })
    await assert.rejects(foreign.client.call(route, envelope(input)), /foreign remote operation/)
    await assert.rejects(remote.client.call(route, envelope({ ...input, worker_session: 'other' })), /foreign selection evidence/)
    await assert.rejects(remote.client.call(route, envelope({ ...input, operation_id: 'other' })), /foreign selection evidence envelope/)
    await assert.rejects(remote.client.call(route, envelope({ ...input, attempt: 2 })), /foreign selection evidence envelope/)
    await assert.rejects(remote.client.call(route, envelope({ ...input, epoch: 2 })), /foreign selection evidence/)
    await assert.rejects(home.client.call('/api/v1/messaging/selection-evidence', input), /remote call collector/)
    await assert.rejects(worker.call(operationRoute, envelope(input)), /403/)
    const receipt = await remote.client.call(route, envelope(input))
    assert.equal(receipt.rejected, true)
    await home.stop('SIGKILL'); await home.start()
    const retry = await remote.client.call(route, envelope(input))
    assert.equal(retry.duplicate, true); assert.equal(retry.sequence, receipt.sequence)
    await assert.rejects(remote.client.call(route, envelope({ ...input, rejected: true })), /identity conflict/)
    const reported = await worker.call(operationRoute, { operation_id: op.id, worker_session: 'worker', command: { attempt: 1, epoch: 1, expected_revision: active.operation.revision, action: { kind: 'report', report_id: 'result', content: 'done' } } })
    assert.equal(reported.applied, false); assert.equal(reported.reason, 'selection_rejected')
    const audit = await home.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`)
    assert.equal(audit.events.filter(row => row.data.kind === 'selection_evidence').length, 1)
    await assert.rejects(remote.client.call(`/api/v1/messaging/operations/${op.id}/events?after=0`), /404/)
  } finally { await foreign?.close(); await remote?.close(); await home?.close() }
})
