import test from 'node:test'
import assert from 'node:assert/strict'
import { stageEvidence } from '../packages/collab/stage-evidence.js'
test('selected evidence never implies stage completion or delivery', () => {
  const run = { id: 'run', context_hash: 'hash', context: { binding: { workflow: { pack: { evidence_rules: { report: { kind: 'review' } } } } } } }
  const stage = { stage_id: 'review', assignment_id: 'assignment', attempt: 2 }
  assert.equal(stageEvidence(run, stage).state, 'absent')
  stage.evidence = { assignment_id: 'assignment', stage_attempt: 2, context_hash: 'hash', outputs: { report: 42 } }
  assert.deepEqual(stageEvidence(run, stage), { state: 'selected', outputs: [{ name: 'report', seq: 42, kind: 'review' }] })
  stage.completion = { run_id: 'run', stage_id: 'review', assignment_id: 'assignment', stage_passed: false }
  assert.equal(stageEvidence(run, stage).state, 'rejected')
  stage.completion.stage_passed = true
  assert.equal(stageEvidence(run, stage).state, 'passed')
  stage.completion.assignment_id = 'old-assignment'
  assert.equal(stageEvidence(run, stage).state, 'selected')
  stage.evidence.stage_attempt = 1
  assert.deepEqual(stageEvidence(run, stage), { state: 'invalid', outputs: [] })
  stage.evidence.stage_attempt = 2; stage.evidence.outputs.report = Number.MAX_SAFE_INTEGER + 1
  assert.equal(stageEvidence(run, stage).state, 'invalid')
})
