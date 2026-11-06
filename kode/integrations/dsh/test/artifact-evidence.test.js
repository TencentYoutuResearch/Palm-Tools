import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'

test('artifact observations pin snapshots, require independent review and never complete operations', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('artifact-home')
  try {
    const root = '/api/v1/messaging'
    const endpoint = `${root}/artifact-evidence`
    const register = async id => {
      const r = await hub.client.call(`${root}/sessions`, { session_id: id, title: id, runtime: 'external' })
      return hub.client.forSession(r.owner_token)
    }
    const author = await register('author'); const reviewer = await register('reviewer')
    const prepare = (key, worker, owner = 'owner') => hub.client.call(`${root}/operations`, { owner_session: owner, request_key: key, worker: { node_id: hub.node, session_id: worker } })
    const claim = (op, client) => client.call(`${root}/operations/${op.id}`, { attempt: 1, epoch: 1, expected_revision: 1, action: { kind: 'claim', lease_ms: 60000 } })
    const op = await prepare('implementation', 'author')
    const snapshot = { repository_id: 'repository', base_revision: 'a'.repeat(40), tree_hash: 'b'.repeat(64), patch_hash: 'c'.repeat(64), artifact_hashes: { binary: 'd'.repeat(64) } }
    const artifact = { id: 'snapshot-1', operation_id: op.id, attempt: 1, epoch: 1, payload: { kind: 'artifact', snapshot } }
    await assert.rejects(author.call(endpoint, artifact), /403/)
    await assert.rejects(hub.client.call(endpoint, artifact), /admitted attempt/)
    await claim(op, author)
    const receipt = await hub.client.call(endpoint, artifact)
    assert.equal(receipt.completion_authorized, false)
    const other = await prepare('review', 'reviewer'); await claim(other, reviewer)
    const review = { id: 'review-1', operation_id: other.id, attempt: 1, epoch: 1, payload: { kind: 'review', artifact_sequence: receipt.sequence, snapshot_hash: receipt.record.snapshot_hash, verdict: 'passed', findings: [] } }
    await assert.rejects(hub.client.call(endpoint, { ...review, operation_id: op.id }), /independent/)
    const sameContext = await prepare('another-assignment', 'author'); await claim(sameContext, author)
    await assert.rejects(hub.client.call(endpoint, { ...review, operation_id: sameContext.id }), /independent/)
    await assert.rejects(hub.client.call(endpoint, { ...review, payload: { ...review.payload, snapshot_hash: '0'.repeat(64) } }), /source mismatch/)
    await assert.rejects(hub.client.call(endpoint, { ...review, payload: { ...review.payload, findings: [{ id: 'bug', blocking: true, evidence_ref: 'log:bug' }] } }), /invalid review/)
    const reviewed = await hub.client.call(endpoint, review)
    assert.equal(reviewed.completion_authorized, false)
    const verification = { id: 'verify-1', operation_id: other.id, attempt: 1, epoch: 1, payload: { kind: 'verification', artifact_sequence: receipt.sequence, snapshot_hash: receipt.record.snapshot_hash, verdict: 'passed', environment_hash: 'e'.repeat(64), command_id: 'regression', command_revision: '1', scenario_ids: ['acceptance'], exit_code: 0, log_ref: 'log:regression' } }
    await assert.rejects(hub.client.call(endpoint, { ...verification, payload: { ...verification.payload, exit_code: 1 } }), /invalid verification/)
    await assert.rejects(hub.client.call(endpoint, { ...verification, epoch: 2 }), /admitted attempt/)
    const verified = await hub.client.call(endpoint, verification)
    const stage = (id, requires, produces, independent_from = []) => ({ id, role: 'fixture', requires, produces, independent_from })
    const workflow = await hub.client.call(`${root}/workflows`, { id: 'evidence-gate', version: '1', inputs: ['request'],
      stages: [stage('build', ['request'], ['snapshot']), stage('review', ['build'], ['review'], ['build']), stage('verify', ['review'], ['checks'])], completion_stages: ['verify'],
      evidence_rules: { snapshot: { kind: 'artifact', repository_binding: 'primary' }, review: { kind: 'review', artifact_output: 'snapshot' }, checks: { kind: 'verification', artifact_output: 'snapshot', command_binding: 'test', environment_binding: 'local', required_scenarios: ['acceptance'] } } })
    const check = { workflow: { id: workflow.id, version: workflow.version, hash: workflow.hash }, stage_id: 'verify',
      assignments: { build: { operation_id: op.id, attempt: 1, epoch: 1 }, review: { operation_id: other.id, attempt: 1, epoch: 1 }, verify: { operation_id: other.id, attempt: 1, epoch: 1 } },
      outputs: { snapshot: receipt.sequence, review: reviewed.sequence, checks: verified.sequence }, repositories: { primary: 'repository' }, commands: { test: { id: 'regression', revision: '1' } }, environments: { local: 'e'.repeat(64) } }
    const checkPath = `${root}/workflows/check-evidence`
    const matched = await hub.client.call(checkPath, check)
    assert.equal(matched.evidence_matches, true); assert.equal(matched.completion_authorized, false)
    assert.equal((await hub.client.call(checkPath, { ...check, stage_id: 'review' })).evidence_matches, true)
    const stricter = structuredClone(workflow.pack); stricter.version = '2'
    stricter.evidence_rules.checks.required_scenarios.push('additional-acceptance')
    const stricterVersion = await hub.client.call(`${root}/workflows`, stricter)
    assert.equal((await hub.client.call(checkPath, { ...check, workflow: { id: stricterVersion.id, version: stricterVersion.version, hash: stricterVersion.hash } })).evidence_matches, false, 'zero exit cannot replace missing required acceptance scenarios')
    await assert.rejects(author.call(checkPath, check), /403/)
    for (const mutate of [
      c => { c.commands.test.revision = '2' }, c => { c.environments.local = 'a'.repeat(64) },
      c => { c.repositories.primary = 'foreign' }, c => { c.assignments.verify.epoch = 2 },
      c => { c.outputs.checks = reviewed.sequence }, c => { delete c.outputs.snapshot },
    ]) {
      const wrong = structuredClone(check); mutate(wrong)
      assert.equal((await hub.client.call(checkPath, wrong)).evidence_matches, false)
    }
    const foreign = await prepare('foreign-review', 'reviewer', 'other-owner'); await claim(foreign, reviewer)
    await assert.rejects(hub.client.call(endpoint, { ...review, operation_id: foreign.id }), /source mismatch/)
    const changed = structuredClone(artifact); changed.id = 'snapshot-2'; changed.payload.snapshot.patch_hash = 'f'.repeat(64)
    const newSnapshot = await hub.client.call(endpoint, changed)
    assert.notEqual(newSnapshot.record.snapshot_hash, receipt.record.snapshot_hash)
    assert.equal((await hub.client.call(checkPath, { ...check, outputs: { ...check.outputs, snapshot: newSnapshot.sequence } })).evidence_matches, false, 'new selected artifact invalidates old verification')
    await assert.rejects(hub.client.call(endpoint, { ...review, id: 'stale-review', payload: { ...review.payload, artifact_sequence: newSnapshot.sequence } }), /source mismatch/)
    await hub.stop('SIGKILL'); await hub.start()
    const retry = await hub.client.call(endpoint, review)
    assert.equal(retry.sequence, reviewed.sequence); assert.equal(retry.duplicate, true)
    assert.deepEqual(retry.record, reviewed.record)
    await assert.rejects(hub.client.call(endpoint, { ...review, payload: { ...review.payload, verdict: 'failed' } }), /identity conflict/)
    const audit = await hub.client.call(`${root}/operations/${other.id}/events`)
    assert.equal(audit.events.filter(e => e.data.kind === 'artifact_evidence').length, 2)
    assert.notEqual((await hub.client.call(`${root}/operations/${other.id}`)).state, 'reported')
  } finally { await hub.close() }
})
