import { snapshotPlanningDraft, PLANNING_CONTEXT_RECORD, PLANNING_TURN_CONTEXT_RECORD } from '../src/planning-draft-context.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { parseBuilderProposalCandidate, completedProposalReply, readBuilderProposalCandidate } from '../src/builder-proposal-candidate.js'
import { registerBuilderProposal, saveBuilderProposal } from '../src/builder-proposal-route.js'
import { NATIVE_PLANNING_RECORD } from '../src/native-planning-session.js'
import { createBuilderPlanningResources } from '../src/builder-planning-resources.js'
import { BUILDER_PLANNING_PROMPT_V2_VERSION } from '../src/builder-planning-prompt-v2.js'
const spec = { name: 'Review team', purpose: 'Review changes', kind: 'coordinator', workspace_refs: [], execution_targets: [], coordinator_targets: [], workflow_pack_refs: [],
  grant_id: null, budget_policy_id: null, scheduling_policy_id: null, limits: { max_active_assignments: 1, max_active_runs: 1 }, proactive_mode: 'off',
  coordinator_prompt: 'Coordinate and report evidence.', workers: [{ id: 'review', role: 'review', responsibilities: ['Review'], allowed_target_ids: [], required_capabilities: [], workspace_refs: [], max_parallel: 1, role_prompt: 'Review without implementing.' }] }
const envelope = { format: 'kode.team-proposal.v1', proposed_team: spec }
const text = 'Please review this proposal.\n```json\n' + JSON.stringify(envelope) + '\n```'
function fixture(record) {
  const binding = { version: 1, mode: 'interactive_planning', home_hub: 'home', draft_id: 'draft', context_epoch: 1, session_id: 'session-11111111-1111-4111-8111-111111111111', workspace_id: 'workspace', cwd: '/fixture' }
  const draft = { id: 'draft', home_hub: 'home', revision: 3, status: 'draft', interview: { purpose: 'Goal', workspace_refs: [], answers: {}, questions: [], proposed_team: null } }
  const events = [
    { seq: 0, type: NATIVE_PLANNING_RECORD, data: binding },
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, message: { id: 'reply', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'HIDDEN' }, { type: 'text', text }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const context = snapshotPlanningDraft(binding, draft, record)
  events.splice(1, 0, { type: PLANNING_CONTEXT_RECORD, data: context })
  events.splice(3, 0, { type: PLANNING_TURN_CONTEXT_RECORD, data: { version: 1, session_id: binding.session_id, turn: 1, draft_revision: 3, sha256: context.sha256, input_ids: ['owner-input'] } })
  events.forEach((event, seq) => { event.seq = seq })
  let writes = 0, receipt = null
  const backend = { async call(path, command) {
    if (command) { writes++; receipt = { ...structuredClone(draft), revision: 4, request_id: command.request_id, interview: command.interview, eligible_for_execution: false }; return receipt }
    if (path.endsWith('/commands/save')) return { receipt }
    if (path.endsWith('/selection')) return { draft_id: 'draft', home_hub: 'home', runtime_binding: null }
    return structuredClone(draft)
  } }
  const planning = { inspect: async () => ({ ...binding, state: 'ready' }), sessionAdmission: async () => ({ binding: structuredClone(binding) }), readContext: async () => snapshotPlanningDraft(binding, draft, record) }
  const agent = { session: { header: { id: binding.session_id, cwd: binding.cwd }, snapshotEvents: () => events } }
  const ctx = { get(name) { return { kodePlanningRuntime: planning, agents: new Map([[binding.session_id, agent]]) }[name] } }
  return { binding, draft, events, ctx, backend, planning, agent, writes: () => writes }
}
test('candidate parser handles the exact envelope, preserves role ids and never creates authority', () => {
  assert.deepEqual(parseBuilderProposalCandidate(text), { proposed_team: spec })
  assert.equal(parseBuilderProposalCandidate('Plain response without a proposal'), null)
  assert.throws(() => parseBuilderProposalCandidate(text + '\n' + text), { code: 'PROPOSAL_AMBIGUOUS' })
  assert.throws(() => parseBuilderProposalCandidate(text + '\n```json\n{"format":"kode.team-proposal.v1",\n```'), { code: 'PROPOSAL_INVALID' })
  assert.throws(() => parseBuilderProposalCandidate(JSON.stringify({ ...envelope, accept: true })), { code: 'PROPOSAL_INVALID' })
  assert.throws(() => parseBuilderProposalCandidate(JSON.stringify({ ...envelope, proposed_team: { ...spec, coordinator_prompt: 'x'.repeat(16001) } })), { code: 'ROLE_PROMPT_INVALID' })
  assert.throws(() => parseBuilderProposalCandidate('x'.repeat(131073)), { code: 'PROPOSAL_INVALID' })
})
test('only the latest completed public assistant reply is eligible, never tool or hidden output', () => {
  const f = fixture(), reply = completedProposalReply(f.events)
  assert.equal(reply.text, text); assert.equal(reply.text.includes('HIDDEN'), false)
  f.events.push({ seq: 4, type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'OTHER' }] } } })
  assert.equal(completedProposalReply(f.events).text, text)
  f.events.push({ seq: 5, type: 'turn/start', data: { turn: 2 } })
  assert.equal(completedProposalReply(f.events), null)
  f.events.push({ seq: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'failed' } } })
  assert.equal(completedProposalReply(f.events), null)
})
test('read preview is exact-draft only and performs zero writes or native execution', async () => {
  const f = fixture(), result = await readBuilderProposalCandidate(f.ctx, f.backend, 'draft')
  assert.equal(result.state, 'candidate'); assert.deepEqual(result.candidate, { proposed_team: spec })
  assert.equal(result.source.session_id, f.binding.session_id); assert.equal(result.source.message_id, 'reply')
  assert.equal(result.draft_revision, 3); assert.equal(result.owner_review_required, true); assert.equal(result.eligible_for_execution, false); assert.equal(f.writes(), 0)
  f.events[0].data = { ...f.binding, draft_id: 'other' }
  await assert.rejects(readBuilderProposalCandidate(f.ctx, f.backend, 'draft'), { code: 'PROPOSAL_SOURCE_UNAVAILABLE' })
})
test('v2 planning candidate preserves frozen resources and rejects changed context or forged turn proof', async () => {
  const record = { planning_prompt_version: BUILDER_PLANNING_PROMPT_V2_VERSION, resources_snapshot: await createBuilderPlanningResources({ home: 'home' })() }
  const f = fixture(record), context = f.events.find(event => event.type === PLANNING_CONTEXT_RECORD).data
  assert.equal(context.version, 2)
  assert.deepEqual(context.data.resources_snapshot, record.resources_snapshot)
  const result = await readBuilderProposalCandidate(f.ctx, f.backend, 'draft')
  assert.equal(result.state, 'candidate'); assert.deepEqual(result.candidate, { proposed_team: spec })
  assert.equal(result.source.context_sha256, context.sha256); assert.equal(result.source.draft_revision, 3)
  assert.equal(result.owner_review_required, true); assert.equal(result.eligible_for_execution, false); assert.equal(f.writes(), 0)
  const changedDraft = structuredClone(f.draft); changedDraft.interview.purpose = 'Changed goal'
  f.planning.readContext = async () => snapshotPlanningDraft(f.binding, changedDraft, record)
  await assert.rejects(readBuilderProposalCandidate(f.ctx, f.backend, 'draft'), { code: 'PROPOSAL_DRAFT_CHANGED' })
  f.planning.readContext = async () => snapshotPlanningDraft(f.binding, f.draft, record)
  f.draft.revision++
  await assert.rejects(readBuilderProposalCandidate(f.ctx, f.backend, 'draft'), { code: 'PROPOSAL_DRAFT_CHANGED' })
  f.draft.revision--
  f.events.find(event => event.type === PLANNING_TURN_CONTEXT_RECORD).data.sha256 = '0'.repeat(64)
  await assert.rejects(readBuilderProposalCandidate(f.ctx, f.backend, 'draft'), { code: 'PLANNING_CONTEXT_MISSING' })
  assert.equal(f.writes(), 0)
})
test('read preview rejects scope or draft revision changes and does not substitute another session', async () => {
  const f = fixture(); let calls = 0
  f.planning.sessionAdmission = async () => ({ binding: { ...f.binding, context_epoch: ++calls === 1 ? 1 : 2 } })
  await assert.rejects(readBuilderProposalCandidate(f.ctx, f.backend, 'draft'), { code: 'PROPOSAL_SOURCE_UNAVAILABLE' })
  const g = fixture(), original = g.backend.call; let reads = 0
  g.backend.call = async (...args) => { const row = await original(...args); if (++reads > 1) row.revision++; return row }
  await assert.rejects(readBuilderProposalCandidate(g.ctx, g.backend, 'draft'), { code: 'PROPOSAL_DRAFT_CHANGED' })
})
test('owner-reviewed edits save a candidate revision through the existing CAS, not activation', async () => {
  const f = fixture(), preview = await readBuilderProposalCandidate(f.ctx, f.backend, 'draft')
  const edited = structuredClone(preview.candidate.proposed_team); edited.workers[0].role_prompt = 'Owner edited role.'
  const command = { draft_id: 'draft', request_id: 'save', expected_revision: preview.draft_revision, proposed_team: edited }
  const saved = await saveBuilderProposal(f.backend, command)
  assert.equal(saved.revision, 4); assert.equal(saved.interview.proposed_team.workers[0].role_prompt, 'Owner edited role.'); assert.equal(saved.eligible_for_execution, false)
  assert.deepEqual(await saveBuilderProposal(f.backend, command), saved); assert.equal(f.writes(), 1)
  await assert.rejects(saveBuilderProposal(f.backend, { ...command, proposed_team: spec }), /identity conflict/)
})
test('GET and POST remain owner-only, malformed or excessive prompts never reach the backend write', async () => {
  const f = fixture(); let handler, kind = 'agent', status, result
  const ctx = { ...f.ctx, connection: { admit: () => ({ peer: { principal: { kind } } }) }, webServer: { register: row => { handler = row.handler } } }
  registerBuilderProposal(ctx, { backendClient: f.backend })
  const invoke = async (method, body) => { const req = Readable.from(body ? [JSON.stringify(body)] : []); Object.assign(req, { method, url: '/api/kode/builder/proposal?draft_id=draft', headers: { 'content-type': 'application/json' } }); await handler(req, { writeHead: c => { status = c }, end: raw => { result = JSON.parse(raw) } }) }
  await invoke('GET'); assert.equal(status, 403)
  kind = 'owner'; await invoke('GET'); assert.equal(status, 200); assert.equal(result.state, 'candidate'); assert.equal(f.writes(), 0)
  await invoke('POST', { draft_id: 'draft', request_id: 'save', expected_revision: 3, proposed_team: { ...spec, coordinator_prompt: ' ' } })
  assert.equal(status, 400); assert.equal(result.code, 'ROLE_PROMPT_INVALID'); assert.equal(f.writes(), 0)
  const call = f.backend.call.bind(f.backend)
  f.backend.call = async (...args) => {
    const result = await call(...args)
    if (args[1]) throw Object.assign(Error('lost response after commit'), { code: 'ROLE_PROMPT_INVALID' })
    return result
  }
  const command = { draft_id: 'draft', request_id: 'save', expected_revision: 3, proposed_team: spec }
  await invoke('POST', command)
  assert.equal(status, 409); assert.equal(result.retry, 'same_request'); assert.equal(result.code, 'PROPOSAL_SAVE_UNCONFIRMED'); assert.equal(f.writes(), 1)
  await invoke('POST', command)
  assert.equal(status, 200); assert.equal(f.writes(), 1, 'committed exact receipt is recovered, never recast as a safe rejection')
})

test('safe POST validation codes are emitted only before any write is attempted', async () => {
  const f=fixture(), command={draft_id:'draft',request_id:'save',expected_revision:3,proposed_team:spec}
  await assert.rejects(saveBuilderProposal(f.backend,{...command,expected_revision:2}),{code:'PROPOSAL_DRAFT_CHANGED'})
  await assert.rejects(saveBuilderProposal(f.backend,{...command,proposed_team:{...spec,workspace_refs:[{host_id:'foreign',workspace_id:'root'}]}}),{code:'PROPOSAL_INVALID'})
  await assert.rejects(saveBuilderProposal(f.backend,{...command,proposed_team:{...spec,coordinator_prompt:' '}}),{code:'ROLE_PROMPT_INVALID'})
  assert.equal(f.writes(),0)
})

test('a completed older-revision reply cannot become a fresh candidate after the draft changes', async () => {
  const f = fixture(); f.draft.revision++
  await assert.rejects(readBuilderProposalCandidate(f.ctx, f.backend, 'draft'), { code: 'PROPOSAL_DRAFT_CHANGED' })
  assert.equal(f.writes(), 0)
})
test('unbound historical output or a forged turn digest cannot become a candidate', async () => {
  const f = fixture(); f.events.splice(f.events.findIndex(e => e.type === PLANNING_TURN_CONTEXT_RECORD), 1)
  await assert.rejects(readBuilderProposalCandidate(f.ctx, f.backend, 'draft'), { code: 'PLANNING_CONTEXT_MISSING' })
  const g = fixture(); g.events.find(e => e.type === PLANNING_TURN_CONTEXT_RECORD).data.sha256 = '0'.repeat(64)
  await assert.rejects(readBuilderProposalCandidate(g.ctx, g.backend, 'draft'), { code: 'PLANNING_CONTEXT_MISSING' })
})
