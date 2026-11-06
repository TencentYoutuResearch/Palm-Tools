import test from 'node:test'
import assert from 'node:assert/strict'
import { executionEvidence, registerExecutionEvidence } from '../src/execution-evidence.js'
import { quotaObservation } from '../src/codex-quota.js'

test('execution evidence reads cold metadata without exposing profile or implying dispatch eligibility', async () => {
  let route, owner = false, reads = 0
  const binding = { profile: { env: { PRIVATE_VALUE: 'not-for-output' } }, selectionEvidence: { model: { status: 'acknowledged', requested: 'fixture' } }, quotaObservation: quotaObservation(null) }
  registerExecutionEvidence({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'agent' } } }) }, get: () => ({ adapter: { profiles: { binding: id => { reads++; return id === 'worker' ? binding : undefined } } } }) })
  const call = async input => {
    const res = { writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body) } }
    await route.handler({ method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(input) } }, res)
    return res
  }
  assert.equal((await call({ session_id: 'worker' })).status, 403)
  assert.equal(reads, 0)
  owner = true
  const result = await call({ session_id: 'worker' })
  assert.equal(result.status, 200)
  assert.equal(result.body.selection.model.status, 'acknowledged')
  assert.equal(result.body.quota.eligible_for_dispatch, false)
  assert.ok(!JSON.stringify(result.body).includes('not-for-output'))
  assert.equal((await call({ session_id: 'missing' })).status, 400)
  assert.equal((await call({ session_id: 'x'.repeat(5000) })).status, 400)
  assert.deepEqual(executionEvidence({}).selection, null)
})


test('owner evidence exposes pending quota fences through an allowlisted view', () => {
  const view = executionEvidence({ quotaFenceRevision: 2, quotaFenceReconciledRevision: 1, remoteQuotaFences: [{ home: 'home', profile: 'p', revision: 5, operation_id: 'op', attempt: 2, reconciled: false, privateField: 'exclude-this' }] })
  assert.equal(view.quota_fences.local_revision, 2)
  assert.deepEqual(view.quota_fences.remote, [{ home_node: 'home', profile: 'p', binding_revision: 5, operation_id: 'op', attempt: 2, reconciled: false }])
  assert.ok(!JSON.stringify(view).includes('exclude-this'))
})
