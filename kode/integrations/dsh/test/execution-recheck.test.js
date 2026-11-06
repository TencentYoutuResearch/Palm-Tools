import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmExecutionRecheck, readExecutionRecheck, executionRecheckKey } from '../packages/collab/execution-recheck.js'
function fixture() {
  const values = new Map(), run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 4, state: 'running', completion_authorized: false }
  const observation = { run_id: 'run', team_id: 'team', home_hub: 'home', run_revision: 4, authority: 'host_observation', state: 'progression_failed', blocked: true, retry_allowed: true }
  let saveFailure = false
  const receipts=new Map(),lookups=[]
  const storage = { read: async key => structuredClone(values.get(key) ?? null), reserve: async (key, value, replace) => { if (!values.has(key) || values.get(key).state === 'accepted' || replace?.(values.get(key))) values.set(key, structuredClone(value)); return structuredClone(values.get(key)) },
    save: async (key, value) => { assert.equal(values.get(key)?.request_id, value.request_id); if (saveFailure) { saveFailure = false; throw Error('saved receipt lost') } values.set(key, structuredClone(value)) } }
  const receipt = input => { const result={ ...run, revision: input.expected_revision + 1, execution_recheck: { request_id: input.request_id, expected_revision: input.expected_revision, reason: input.reason, state: 'requested', actor: { kind: 'human', id: 'local_owner' } } };const request=structuredClone(input);delete request.run_id;receipts.set(input.request_id,{request,result});return result }
  const lookup=async query=>{lookups.push(query);const found=receipts.get(query.request_id);return {snapshot:'work_run_command_receipt.v1',home_hub:'home',run_id:'run',team_id:'team',request_id:query.request_id,run_revision:Math.max(run.revision,found?.result.revision??0),run_state:run.state,receipt:found??null}}

  return { run, observation, storage, values, receipt, lookup, lookups, failSave: () => { saveFailure = true } }
}
for (const failure of ['reply', 'save']) test(`execution recheck recovers exact intent after ${failure} loss and later Home version`, async () => {
  const f = fixture(), sent = []; let first = true, effects = 0, result
  const request = async input => { sent.push(structuredClone(input)); if (!result) { result = f.receipt(input); effects++ } if (first) { first = false; if (failure === 'reply') throw Error('committed reply lost'); f.failSave() } return result }
  await assert.rejects(confirmExecutionRecheck({ ...f, request, uuid: () => 'reviewed' }), /lost/)
  assert.equal((await readExecutionRecheck(f.storage, f.run)).state, 'prepared')
  f.run = { ...f.run, revision: 19, state: 'cancelled' }
  await confirmExecutionRecheck({ ...f, request, recover: true, uuid: () => 'must-not-replace' })
  assert.equal(sent.length,1);assert.equal(f.lookups[0].request_id,sent[0].request_id);assert.equal(effects, 1)
  await confirmExecutionRecheck({ ...f, recover: true, request: () => { throw Error('historical receipt must not send') } })
})
test('only an exact current execution fence can prepare a new recheck', async () => {
  for (const change of [{ run_revision: 3 }, { home_hub: 'foreign' }, { blocked: false }, { retry_allowed: false }, { state: 'waiting_user' }]) {
    const f = fixture(); let sent = 0
    await assert.rejects(confirmExecutionRecheck({ ...f, observation: { ...f.observation, ...change }, request: () => { sent++ } }), /fence/)
    assert.equal(sent, 0); assert.equal(f.values.size, 0)
  }
  for (const change of [{ state: 'waiting_user' }, { cancellation: { stop_confirmed: false } }, { completion_authorized: true }]) {
    const f = fixture(); await assert.rejects(confirmExecutionRecheck({ ...f, run: { ...f.run, ...change } }), /fence/)
  }
  const f = fixture(), stop = new AbortController(); stop.abort()
  await assert.rejects(confirmExecutionRecheck({ ...f, signal: stop.signal }), /Disposed/); assert.equal(f.values.size, 0)
})
test('foreign or completion-claiming replies cannot acknowledge the saved request', async () => {
  for (const change of [r => { r.home_hub = 'foreign' }, r => { r.execution_recheck.actor.kind = 'worker' }, r => { r.completion_authorized = true }, r => { r.revision++ }]) {
    const f = fixture()
    await assert.rejects(confirmExecutionRecheck({ ...f, uuid: () => 'reviewed', request: async input => { const result = f.receipt(input); change(result); return result } }), /confirmed/)
    assert.equal((await readExecutionRecheck(f.storage, f.run)).state, 'prepared')
  }
  const f = fixture(); await f.storage.reserve(executionRecheckKey(f.run), { request_id: 'bad', home_hub: 'foreign', team_id: 'team', state: 'prepared', command: {} })
  await assert.rejects(readExecutionRecheck(f.storage, f.run), /scope/)
})
test('atomic absent receipt at a newer version closes an unsubmitted intent without POST', async () => {
  const f=fixture()
  await assert.rejects(confirmExecutionRecheck({...f,uuid:()=> 'unsubmitted',request:()=>{throw Error('not transmitted')}}),/transmitted/)
  const run={...f.run,revision:5,state:'cancelled'}
  const proof={snapshot:'work_run_command_receipt.v1',home_hub:'home',run_id:'run',team_id:'team',request_id:'unsubmitted',run_revision:5,run_state:'cancelled',receipt:null}
  const result=await confirmExecutionRecheck({...f,run,recover:true,lookup:async()=>proof,request:()=>{throw Error('obsolete command must never POST')}})
  assert.equal(result.outcome,'obsolete');assert.equal((await readExecutionRecheck(f.storage,run)).state,'obsolete')
  await confirmExecutionRecheck({...f,run,recover:true,lookup:()=>{throw Error('durable obsolete proof must not query')},request:()=>{throw Error('must not send')}})
  // A later, independently reviewed current fence may replace only the completed
  // obsolete disposition; it receives a new command and the new revision.
  const next={...run,state:'running'},observation={...f.observation,run_revision:5}
  const fresh=await confirmExecutionRecheck({...f,run:next,observation,uuid:()=> 'new-review',request:async input=>{assert.equal(input.expected_revision,5);return f.receipt(input)}})
  assert.equal(fresh.execution_recheck.request_id,'new-review')
})
test('same-version absence permits only the original retry; unavailable/foreign proof never discards it', async () => {
  const f=fixture()
  await assert.rejects(confirmExecutionRecheck({...f,uuid:()=> 'pending',request:()=>{throw Error('not sent')}}),/not sent/)
  const proof={snapshot:'work_run_command_receipt.v1',home_hub:'home',run_id:'run',team_id:'team',request_id:'pending',run_revision:4,run_state:'running',receipt:null}
  for(const lookup of [async()=>{throw Error('offline')},async()=>({...proof,home_hub:'foreign'}),async()=>({...proof,run_revision:3}),async()=>({...proof,receipt:undefined})]) {
    await assert.rejects(confirmExecutionRecheck({...f,recover:true,lookup,request:()=>{throw Error('must not dispatch with invalid proof')}}))
    assert.equal((await readExecutionRecheck(f.storage,f.run)).state,'prepared')
  }
  const receipt=await confirmExecutionRecheck({...f,recover:true,lookup:async()=>proof,uuid:()=> 'unused',request:async input=>{assert.equal(input.request_id,'pending');return f.receipt(input)}})
  assert.equal(receipt.execution_recheck.request_id,'pending')
})
