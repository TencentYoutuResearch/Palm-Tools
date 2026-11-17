import test from 'node:test'
import assert from 'node:assert/strict'
import { needsDecision, runPresentation } from '../packages/collab/run-presentation.js'

test('only Hub delivery authorization earns success; terminal execution and unknown states stay neutral', () => {
  for (const state of ['completed', 'cancelled', 'future_state']) {
    assert.equal(runPresentation({ state, completion_authorized: false }).tone, 'neutral')
  }
  assert.equal(runPresentation({ state: 'completed', completion_authorized: true }).tone, 'success')
})
test('attention, stop uncertainty, active work and failure remain distinct', () => {
  assert.equal(needsDecision({ state: 'waiting_user' }), true)
  assert.equal(needsDecision({ state: 'blocked', waiting_reason: 'rework_limit_exhausted' }), true)
  assert.equal(needsDecision({ state: 'running' }), false)
  for (const state of ['waiting_user', 'cancelling', 'cancel_unconfirmed', 'taking_over']) assert.equal(runPresentation({ state }).tone, 'warning')
  assert.equal(runPresentation({ state: 'running' }).tone, 'active')
  for (const state of ['failed', 'blocked']) assert.equal(runPresentation({ state }).tone, 'error')
})
