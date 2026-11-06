import test from 'node:test'
import assert from 'node:assert/strict'
import { workRunExecutionStatus } from '../src/work-run-execution-status.js'
const run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 5, state: 'running', completion_authorized: false }
const service = (row = { revision: 5, state: 'progression_failed', blocked: true }) => ({ runtime: { host: 'home' }, stop: new AbortController(), rows: { run: row } })
test('execution fence stays a Host observation and never changes authoritative Run state', () => {
  const original = structuredClone(run), host = service()
  host.rows.run.error = 'untrusted raw error must not reach the interface'
  const result = workRunExecutionStatus(host, run, 'home')
  assert.equal(result.state, 'progression_failed'); assert.equal(result.authority, 'host_observation')
  assert.equal(result.retry_allowed, true); assert.deepEqual(run, original)
  assert.ok(!JSON.stringify(result).includes('untrusted'))
})
test('changed revision, unavailable service and unknown states cannot authorize recovery', () => {
  for (const [host, state] of [[service({revision:4,state:'progression_failed',blocked:true}),'stale'], [undefined,'unavailable'], [service({revision:5,state:'future_internal_state',blocked:true}),'unrecognized']]) {
    const result=workRunExecutionStatus(host,run,'home'); assert.equal(result.state,state);assert.equal(result.retry_allowed,false)
  }
  const stopped=service();stopped.stop.abort();assert.equal(workRunExecutionStatus(stopped,run,'home').state,'unavailable')
  const foreign=service();foreign.runtime.host='other';assert.equal(workRunExecutionStatus(foreign,run,'home').state,'unavailable')
})
test('terminal, cancellation and human decision states cannot become retry buttons', () => {
  for (const state of ['completed','failed','cancelled','cancelling','cancel_unconfirmed','waiting_user']) {
    const result=workRunExecutionStatus(service(),{...run,state},'home')
    assert.equal(result.retry_allowed,false)
    if (['completed','failed','cancelled'].includes(state))assert.equal(result.state,'terminal')
  }
  assert.throws(()=>workRunExecutionStatus(service(),{...run,home_hub:'other'},'home'),/scope/)
})
test('ordinary remote waiting is an observation, not a recovery authorization', () => {
  const result=workRunExecutionStatus(service({revision:5,state:'waiting_remote_report',blocked:false}),run,'home')
  assert.equal(result.state,'waiting_remote_report');assert.equal(result.blocked,false);assert.equal(result.retry_allowed,false)
  assert.throws(()=>workRunExecutionStatus(service({revision:5,state:'progression_failed',blocked:false}),run,'home'),/fence/)
})
