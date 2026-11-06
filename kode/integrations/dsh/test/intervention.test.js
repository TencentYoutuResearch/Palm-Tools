import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmIntervention, readIntervention, interventionKey, interventionAllowed } from '../packages/collab/intervention.js'
function fixture() {
  const values = new Map(), receipts = new Map()
  const run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 4, state: 'running', completion_authorized: false }
  const storage = {
    read: async key => structuredClone(values.get(key) ?? null),
    reserve: async (key, value, replace) => {
      const old = values.get(key)
      if (!old || old.state === 'accepted' || replace?.(old)) values.set(key, structuredClone(value))
      return structuredClone(values.get(key))
    },
    save: async (key, value) => { assert.equal(values.get(key).request_id, value.request_id); values.set(key, structuredClone(value)) },
  }
  const result = command => {
    const intent = { request_id: command.request_id, reason: command.reason, actor: { kind: 'human', id: 'local_owner' } }
    const receipt = { ...run, revision: command.expected_revision + 1, state: command.action === 'takeover' ? 'taking_over' : 'waiting_resource',
      stages: [{ stage_id: 'implement', attempt: 1, state: 'pending', assignment_id: null }],
      intervention: command.action === 'takeover' ? intent : { resume: { ...intent, evidence_policy: 'all_stages_revalidate', execution_authorized: false } } }
    const request = { ...command }; delete request.run_id
    receipts.set(command.request_id, { request, result: receipt })
    return receipt
  }
  const lookup = async input => ({ snapshot: 'work_run_command_receipt.v1', home_hub: 'home', team_id: 'team', run_id: 'run',
    request_id: input.request_id, run_revision: Math.max(run.revision, receipts.get(input.request_id)?.result.revision ?? 0),
    run_state: run.state, receipt: receipts.get(input.request_id) ?? null })
  return { run, values, storage, receipts, lookup, result, action: 'takeover', reason: 'Inspect owned workspace', uuid: () => 'decision' }
}
test('lost committed takeover reply recovers by exact receipt after later state without another POST', async () => {
  const f = fixture(); let writes = 0
  const request = async command => { writes++; f.result(command); throw Error('reply lost') }
  await assert.rejects(confirmIntervention({ ...f, request }), /lost/)
  assert.equal((await readIntervention(f.storage, f.run)).state, 'prepared')
  const recovered = await confirmIntervention({ ...f, run: { ...f.run, revision: 19, state: 'paused' }, recover: true,
    request: () => { throw Error('must not resend committed command') } })
  assert.equal(recovered.intervention.request_id, 'decision'); assert.equal(writes, 1)
})
test('newer atomic negative proof preserves obsolete intent without attempting another command', async () => {
  const f = fixture()
  await assert.rejects(confirmIntervention({ ...f, request: () => { throw Error('offline') } }), /offline/)
  f.run.revision = 5
  const result = await confirmIntervention({ ...f, recover: true, request: () => { throw Error('obsolete must not send') } })
  assert.equal(result.outcome, 'obsolete')
  assert.equal((await readIntervention(f.storage, f.run)).state, 'obsolete')
})
test('foreign receipt and scope cannot clear a pending operation', async () => {
  const f = fixture()
  await assert.rejects(confirmIntervention({ ...f, request: () => { throw Error('offline') } }))
  await assert.rejects(confirmIntervention({ ...f, recover: true, lookup: async input => ({ ...await f.lookup(input), home_hub: 'foreign' }) }), /scope/)
  assert.equal((await readIntervention(f.storage, f.run)).state, 'prepared')
  f.values.get(interventionKey(f.run)).command.action = 'activate'
  await assert.rejects(readIntervention(f.storage, f.run), /scope/)
})
test('resume requires confirmed paused work and cleared selected evidence in its receipt', async () => {
  const f = fixture(), run = { ...f.run, state: 'paused', intervention: { stop_confirmed: true, resources_released: true, accounting: 'finalized' } }
  assert.equal(interventionAllowed(run, 'resume'), true)
  for (const change of [{ state: 'taking_over' }, { intervention: { stop_confirmed: false } }, { completion_authorized: true }]) {
    assert.equal(interventionAllowed({ ...run, ...change }, 'resume'), false)
  }
  await assert.rejects(confirmIntervention({ ...f, run, action: 'resume', request: async command => {
    const result = f.result(command); result.stages[0].evidence = { outputs: { old: 1 } }; return result
  } }), /evidence/)
})
test('prepared takeover and resume intents retain independent scopes between Homes', async () => {
  const f = fixture()
  assert.notEqual(interventionKey(f.run), interventionKey({ ...f.run, home_hub: 'other' }))
  for (const state of ['completed', 'failed', 'cancelled', 'paused', 'taking_over']) {
    await assert.rejects(confirmIntervention({ ...f, run: { ...f.run, state }, request: () => { throw Error('must not dispatch') } }), /decision/)
  }
})
