import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareConfiguration } from '../packages/collab/team-configuration.js'
import { readProposalCandidate, saveProposalCandidate, applyCandidateForm, candidateProblems, candidateError } from '../packages/collab/builder-candidate.js'
import { utf8Bytes, withPrompt } from '../packages/collab/role-prompt.js'

// Pure frontend contract checks; fetch is a stub, nothing reaches a Hub or a model.
const team = { id: 't', home_hub: 'h', revision: 3, superagent_id: 'a', conversation_id: 'c', spec: { name: 'T', coordinator_prompt: 'Lead.', execution_targets: [{ id: 'one' }],
  workers: [{ id: 'w', role: 'Backend', responsibilities: ['Implement'], allowed_target_ids: ['one'], max_parallel: 1, role_prompt: 'Old.' }] } }

test('role instructions: blank clears by omission, untouched keeps, oversize is refused before any request', () => {
  const kept = prepareConfiguration(team, structuredClone(team.spec.workers), 'r')
  assert.equal(kept.spec.coordinator_prompt, 'Lead.'); assert.equal(kept.spec.workers[0].role_prompt, 'Old.')
  const cleared = prepareConfiguration(team, [{ ...team.spec.workers[0], role_prompt: '  \n' }], 'r', '')
  assert.equal('coordinator_prompt' in cleared.spec, false); assert.equal('role_prompt' in cleared.spec.workers[0], false)
  assert.equal(JSON.stringify(cleared).includes('""'), false, 'never sends an empty string')
  const set = prepareConfiguration(team, [{ ...team.spec.workers[0], role_prompt: '  Review first.\n' }], 'r', 'New lead.')
  assert.equal(set.spec.workers[0].role_prompt, '  Review first.\n', 'text is kept verbatim'); assert.equal(set.spec.coordinator_prompt, 'New lead.')
  assert.equal(utf8Bytes('团'), 3)
  assert.throws(() => prepareConfiguration(team, [{ ...team.spec.workers[0], role_prompt: '团'.repeat(5334) }], 'r'), 'over 16000 UTF-8 bytes')
  prepareConfiguration(team, [{ ...team.spec.workers[0], role_prompt: '团'.repeat(5333) }], 'r')
  assert.throws(() => prepareConfiguration(team, structuredClone(team.spec.workers), 'r', 'x'.repeat(16001)))
  assert.deepEqual(withPrompt({ a: 1, p: 'x' }, 'p', null), { a: 1 })
})

const draft = { id: 'd', home_hub: 'h', revision: 4, status: 'draft' }
const candidate = { name: 'Review team', purpose: 'Ship', workspace_refs: [{ host_id: 'h', workspace_id: 'ws' }], grant_id: 'g',
  workers: [{ id: 'tester', role: 'Tester', responsibilities: ['Verify'], allowed_target_ids: ['one'], max_parallel: 1 }] }
const response = extra => ({ format: 'kode.team-proposal.v1', draft_id: 'd', draft_revision: 4, home_hub: 'h', prompt_max_bytes: 16000, team_max_bytes: 65536,
  saved_proposal: null, saved_workflow: null, candidate: { proposed_team: candidate }, source: { session_id: 's', message_id: 'm', turn: 3, sha256: 'x' },
  state: 'candidate', owner_review_required: true, eligible_for_execution: false, ...extra })
const reply = (body, status = 200) => async () => ({ ok: status < 300, status, json: async () => body })

test('candidate read accepts only the exact owner-review shape for this draft', async () => {
  assert.equal((await readProposalCandidate(draft, { fetcher: reply(response()) })).state, 'candidate')
  for (const state of ['no_candidate', 'no_completed_reply', 'not_created', 'uncertain'])
    assert.equal((await readProposalCandidate(draft, { fetcher: reply(response({ state, candidate: null, source: null })) })).state, state)
  for (const wrong of [{ eligible_for_execution: true }, { owner_review_required: false }, { draft_id: 'other' }, { home_hub: 'x' }, { format: 'v0' },
    { state: 'ready' }, { state: 'no_candidate' }, { candidate: null }, { candidate: { proposed_team: [] } }])
    await assert.rejects(readProposalCandidate(draft, { fetcher: reply(response(wrong)) }), error => error.code === 'PROPOSAL_RESPONSE_INVALID')
  await assert.rejects(readProposalCandidate(draft, { fetcher: reply({ code: 'PROPOSAL_AMBIGUOUS' }, 409) }), error => error.code === 'PROPOSAL_AMBIGUOUS')
  assert.match(candidateError({ code: 'PROPOSAL_AMBIGUOUS' }), /不止一份/)
  assert.match(candidateError({ status: 404 }), /尚未部署/)
})

test('form edits only shown fields, keyed by worker.id; blank instruction is omitted', () => {
  const form = { name: ' Renamed ', purpose: 'Ship', coordinator_prompt: '', workers: [{ id: 'tester', role: 'QA', responsibilities: 'Verify\n\nReport', role_prompt: 'Be strict.' }] }
  const next = applyCandidateForm(candidate, form)
  assert.equal(next.name, 'Renamed'); assert.equal(next.grant_id, 'g'); assert.deepEqual(next.workspace_refs, candidate.workspace_refs)
  assert.deepEqual(next.workers[0], { ...candidate.workers[0], role: 'QA', responsibilities: ['Verify', 'Report'], role_prompt: 'Be strict.' })
  assert.equal('coordinator_prompt' in next, false)
  assert.deepEqual(candidateProblems(candidate, form, { prompt: 16000, team: 65536 }), [])
  assert.equal(candidateProblems(candidate, { ...form, workers: [{ ...form.workers[0], role_prompt: 'x'.repeat(11) }] }, { prompt: 10, team: 65536 }).length, 1)
  assert.match(candidateProblems(candidate, form, { prompt: 16000, team: 100 })[0], /KiB/)
})

test('save is one original POST per revision; lost response resends it, a confirmed rejection frees the slot', async () => {
  let record = null
  const storage = { read: async () => record, reserve: async (k, v, replace) => { if (!record || replace?.(record)) record = v; return record }, save: async (k, v) => { record = v } }
  const command = { draft_id: 'd', request_id: 'r1', expected_revision: 4, proposed_team: candidate }
  const bodies = []
  const post = outcome => async (path, init) => { assert.equal(path, '/api/kode/builder/proposal'); assert.equal(init.method, 'POST'); bodies.push(JSON.parse(init.body)); return outcome() }
  await assert.rejects(saveProposalCandidate({ draft, command, storage, fetcher: post(() => { throw Error('lost') }) }))
  await assert.rejects(saveProposalCandidate({ draft, command: { ...command, request_id: 'r2' }, storage, fetcher: post(() => assert.fail()) }), error => error.code === 'PENDING_SAVE')
  const saved = { id: 'd', home_hub: 'h', revision: 5, eligible_for_execution: false, interview: { proposed_team: candidate } }
  assert.equal((await saveProposalCandidate({ draft, command, storage, fetcher: post(() => ({ ok: true, status: 200, json: async () => saved })) })).revision, 5)
  assert.deepEqual(bodies.map(body => body.request_id), ['r1', 'r1'])
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['draft_id', 'expected_revision', 'proposed_team', 'request_id'])

  record = null; bodies.length = 0
  await assert.rejects(saveProposalCandidate({ draft, command, storage, fetcher: post(() => ({ ok: false, status: 400, json: async () => ({ code: 'ROLE_PROMPT_INVALID' }) })) }), error => error.code === 'ROLE_PROMPT_INVALID')
  assert.equal(record.state, 'rejected')
  await saveProposalCandidate({ draft, command: { ...command, request_id: 'r3' }, storage, fetcher: post(() => ({ ok: true, status: 200, json: async () => saved })) })
  assert.deepEqual(bodies.map(body => body.request_id), ['r1', 'r3'])
  record = null
  await assert.rejects(saveProposalCandidate({ draft, command, storage, fetcher: post(() => ({ ok: true, status: 200, json: async () => ({ ...saved, eligible_for_execution: true }) })) }))
})
