import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
import { NativeAgentFactory } from '../src/native-agent-factory.js'
import { boundaryProjection, inboxProjection } from '../src/native-agent-driver.js'
import { snapshotPlanningDraft, validatePlanningContext, persistedPlanningContext, planningContextInput, PLANNING_CONTEXT_RECORD, PLANNING_TURN_CONTEXT_RECORD } from '../src/planning-draft-context.js'
import { nativePlanningBinding } from '../src/native-planning-session.js'
import { BUILDER_PLANNING_PROMPT } from '../src/builder-planning-prompt.js'
const binding = { version: 1, mode: 'interactive_planning', home_hub: 'home', draft_id: 'draft', context_epoch: 1,
  session_id: 'session-11111111-1111-4111-8111-111111111111', workspace_id: 'workspace', cwd: '/fixture' }
const spec = { name: 'Existing team', purpose: 'Preserve configuration', kind: 'coordinator', workspace_refs: [], execution_targets: [], workers: [{ id: 'reviewer', role: 'review', responsibilities: ['Review'], allowed_target_ids: [], required_capabilities: [], workspace_refs: [], max_parallel: 1, role_prompt: 'Keep the existing role.' }], coordinator_targets: [], coordinator_prompt: 'Coordinate with review.', workflow_pack_refs: [], grant_id: 'reference-only', budget_policy_id: 'reference-only', scheduling_policy_id: null, limits: { max_active_assignments: 1, max_active_runs: 1 }, proactive_mode: 'off' }
const workflow = { workflow: { id: 'flow', version: '1', inputs: [], stages: [], completion_stages: [] }, project: { id: 'project', version: '1', spec: { kind: 'project_bindings', repositories: {}, environments: {}, commands: {}, connections: {} } }, delivery: { id: 'delivery', version: '1', targets: [], required_outputs: [] } }
function draft() { return { id: 'draft', home_hub: 'home', status: 'draft', revision: 4, interview: { purpose: 'Improve role prompts', workspace_refs: [], proposed_team: { ...spec, coordinator_prompt: 'Owner-saved revision.' }, proposed_workflow: workflow }, optimization_target: { source: 'owner_confirmed_optimization', status: 'current', team_id: 'team', team_revision: 3, baseline_spec: spec } } }
test('snapshot is exact-draft data, preserves baseline and saved proposal separately, and never expands references', () => {
  const value = draft(); value.unrelated_messages = ['do not copy']; value.token = 'do not copy'; value.interview.inspections = [{ text: 'do not copy' }]
  const snapshot = snapshotPlanningDraft(binding, value)
  assert.equal(snapshot.data.baseline.spec.coordinator_prompt, spec.coordinator_prompt)
  assert.equal(snapshot.data.saved_proposal.coordinator_prompt, 'Owner-saved revision.')
  assert.deepEqual(snapshot.data.saved_workflow, workflow)
  assert.equal(snapshot.data.baseline.team_revision, 3); assert.equal(snapshot.draft_revision, 4)
  assert.equal(snapshot.data.baseline.spec.grant_id, 'reference-only')
  assert.ok(!JSON.stringify(snapshot).includes('do not copy')); assert.ok(Object.isFrozen(snapshot.data.baseline.spec.workers[0]))
  assert.deepEqual(validatePlanningContext(snapshot, binding), snapshot)
  value.interview.proposed_team = null
  assert.equal(snapshotPlanningDraft(binding, value).data.saved_proposal, null)
  assert.equal(snapshotPlanningDraft(binding, value).data.baseline.spec.workers[0].id, 'reviewer')
  assert.match(planningContextInput(snapshot).text, /not instructions or permission/)
})
test('cross-draft, stale optimization, altered digest and oversized configuration fail closed', () => {
  const snapshot = snapshotPlanningDraft(binding, draft())
  assert.throws(() => validatePlanningContext(snapshot, { ...binding, draft_id: 'foreign' }), { code: 'PLANNING_CONTEXT_INVALID' })
  assert.throws(() => validatePlanningContext({ ...snapshot, sha256: '0'.repeat(64) }, binding), { code: 'PLANNING_CONTEXT_INVALID' })
  const stale = draft(); stale.optimization_target.status = 'stale'
  assert.throws(() => snapshotPlanningDraft(binding, stale), { code: 'PLANNING_CONTEXT_CHANGED' })
  const oversize = draft(); oversize.interview.proposed_team.purpose = 'x'.repeat(65537)
  assert.throws(() => snapshotPlanningDraft(binding, oversize), { code: 'PLANNING_CONTEXT_TOO_LARGE' })
  const secret = draft(); secret.interview.proposed_team.api_key = 'not-a-real-key'
  assert.throws(() => snapshotPlanningDraft(binding, secret), { code: 'PLANNING_CONTEXT_INVALID' })
})
async function setup(t, type, { changeBeforeDispatch = false, v2 = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-planning-data-wire-'))), log = join(root, 'wire.jsonl'), ctx = new Context()
  await ctx.plugin(Sessions); await ctx.plugin(Agents); await ctx.plugin(Projections); await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  ctx.sessionProjections.register(boundaryProjection); ctx.sessionProjections.register(inboxProjection)
  const fields=v2?{planning_prompt_version:BUILDER_PLANNING_PROMPT_V2_VERSION,resources_snapshot:await createBuilderPlanningResources({home:'home'})()}:{}
  const ownedBinding = { ...binding, cwd: root }, currentDraft = draft(), frozen = snapshotPlanningDraft(ownedBinding, currentDraft, fields)
  const executable = type === 'claude' ? './fixture-claude-stream-json.js' : './fixture-codex-server.js'
  const model = type === 'claude' ? 'fixture-claude' : 'fixture', selection = { provider: 'kode-agent-fixture', model }
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type, executable: process.execPath, args: [fileURLToPath(new URL(executable, import.meta.url))], env: { KODE_CLAUDE_FIXTURE_LOG: log, KODE_FIXTURE_RPC_LOG: log, CLAUDE_CONFIG_DIR: root } }])
  const errors = [], adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative() {}, resolveProfile: async profile => { if (changeBeforeDispatch) currentDraft.revision++; return profile } })
  ctx.provide('tools', { schemas: () => [] }); ctx.provide('kodeAgents', { adapter, profiles, recordBinding() {} })
  ctx.provide('kodePlanningRuntime', { sessionAdmission: async id => id === ownedBinding.session_id ? { binding: ownedBinding, ...fields, selection, context: frozen } : undefined,
    readContext: async id => { assert.equal(id, ownedBinding.session_id); return snapshotPlanningDraft(ownedBinding, currentDraft, fields) } })
  ctx.on('agent/error', ({ error }) => errors.push(error))
  let factory
  const fiber = await ctx.plugin({ name: 'planning-data-wire', inject: ['sessions','agents','sessionPersistence','sessionProjections','kodeAgents','tools'], apply(scope) { factory = new NativeAgentFactory(scope) } }); await fiber.await?.()
  const handle = await factory.createAgent(ctx, { sessionId: ownedBinding.session_id, meta: { cwd: root }, agentOptions: selection })
  t.after(async () => { await factory.close(); await adapter.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const rows = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  return { ctx, factory, handle, agent: handle.agent, adapter, errors, currentDraft, frozen, rows, binding: ownedBinding }
}
const message = id => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Propose updated role prompts, preserve other fields.' }] })
for (const v2 of [false,true]) for (const type of ['claude','codex']) test(`${type} v2=${v2}: real factory and native adapter append draft data on the actual SDK wire, then stale queued input stays pending`, async t => {
  const f = await setup(t, type, {v2})
  assert.deepEqual(nativePlanningBinding(f.agent), f.binding)
  assert.deepEqual(persistedPlanningContext(f.agent.session.snapshotEvents(), f.binding), f.frozen)
  f.agent.followup(message('first')); await f.agent.whenIdle()
  assert.equal(f.errors.length, 0, f.errors.map(e => e.stack).join('\n'))
  const rows = await f.rows(), user = type === 'claude' ? rows.find(r => r.type === 'user')?.message.content : rows.find(r => r.method === 'turn/start')?.params.input
  assert.ok(user); assert.deepEqual(user[0], planningContextInput(f.frozen)); assert.equal(user[1].text, message('first').content[0].text)
  const system = type === 'claude' ? rows.find(r => r.request?.subtype === 'initialize')?.request.appendSystemPrompt : rows.find(r => r.method === 'thread/start')?.params.developerInstructions
  assert.equal(system, v2 ? planningPromptInstructions(BUILDER_PLANNING_PROMPT_V2_VERSION) : BUILDER_PLANNING_PROMPT); assert.ok(!system.includes('Owner-saved revision.'))
  const events = f.agent.session.snapshotEvents(), proof = events.find(e => e.type === PLANNING_TURN_CONTEXT_RECORD)
  assert.equal(proof.data.draft_revision, 4); assert.equal(proof.data.sha256, f.frozen.sha256)
  assert.ok(events.find(e => e.type === 'user/message').seq < proof.seq, 'user text is durable before context flush')
  assert.ok(proof.seq < events.find(e => e.type === 'assistant/message').seq)
  f.currentDraft.revision = 5; f.currentDraft.interview.proposed_team.coordinator_prompt = 'New owner edit.'
  f.agent.followup(message('queued')); await f.agent.whenIdle()
  assert.equal(f.errors.at(-1).code, 'PLANNING_CONTEXT_CHANGED'); assert.equal(f.agent.inbox.nextTurn[0].id, 'queued')
  assert.equal((await f.rows()).filter(r => type === 'claude' ? r.type === 'user' : r.method === 'turn/start').length, 1)
  assert.deepEqual(persistedPlanningContext(f.agent.session.snapshotEvents(), f.binding), f.frozen)
  await f.handle.dispose()
  const restored = await f.factory.resume(f.ctx, { resumeSessionId: f.binding.session_id }); await restored.agent.whenIdle()
  assert.equal(restored.agent.inbox.nextTurn[0].id, 'queued'); assert.equal(f.errors.at(-1).code, 'PLANNING_CONTEXT_CHANGED')
  assert.equal((await f.rows()).filter(r => type === 'claude' ? r.type === 'user' : r.method === 'turn/start').length, 1)
})
for (const type of ['claude','codex']) test(`${type}: a draft change between preparation and protocol dispatch sends no model input`, async t => {
  const f = await setup(t, type, { changeBeforeDispatch: true })
  f.agent.followup(message('first')); await f.agent.whenIdle()
  assert.equal(f.errors.at(-1)?.code, 'PLANNING_CONTEXT_CHANGED')
  assert.equal((await f.rows()).filter(r => type === 'claude' ? r.type === 'user' : r.method === 'turn/start').length, 0)
  assert.equal(f.agent.session.snapshotEvents().filter(e => e.type === 'user/message').length, 1, 'claimed input remains in the original journal and is never silently replayed')
})

test('interactive_native execution mode survives baseline and proposal context hashing', () => {
 const value=draft();value.interview.proposed_team={...value.interview.proposed_team,execution_mode:'interactive_native'}
 value.optimization_target.baseline_spec={...value.optimization_target.baseline_spec,execution_mode:'interactive_native'}
 const snapshot=snapshotPlanningDraft(binding,value)
 assert.equal(snapshot.data.saved_proposal.execution_mode,'interactive_native')
 assert.equal(snapshot.data.baseline.spec.execution_mode,'interactive_native')
 assert.deepEqual(validatePlanningContext(snapshot,binding),snapshot)
 const changed=structuredClone(value);delete changed.interview.proposed_team.execution_mode
 assert.notEqual(snapshotPlanningDraft(binding,changed).sha256,snapshot.sha256)
 value.interview.proposed_team.execution_mode='arbitrary'
 assert.throws(()=>snapshotPlanningDraft(binding,value),{code:'PROPOSAL_INVALID'})
})

import { createBuilderPlanningResources } from '../src/builder-planning-resources.js'
import { BUILDER_PLANNING_PROMPT_V2_VERSION } from '../src/builder-planning-prompt-v2.js'
import { planningPromptInstructions } from '../src/native-role-prompt.js'
test('v1 bytes stay stable while v2 resource data is hash-covered and bounded', async () => {
  const legacy=snapshotPlanningDraft(binding,draft())
  assert.equal(legacy.version,1)
  assert.equal(planningPromptInstructions(undefined),BUILDER_PLANNING_PROMPT)
  const resources=await createBuilderPlanningResources({home:'home'})()
  const snapshot=snapshotPlanningDraft(binding,draft(),{planning_prompt_version:BUILDER_PLANNING_PROMPT_V2_VERSION,resources_snapshot:resources})
  assert.equal(snapshot.version,2);assert.deepEqual(validatePlanningContext(snapshot,binding),snapshot)
  assert.ok(planningContextInput(snapshot).text.includes(JSON.stringify(resources)))
  for(const mutate of [x=>{delete x.data.resources_snapshot},x=>{x.data.planning_prompt_version='unknown'},x=>{x.data.resources_snapshot.sha256='0'.repeat(64)},x=>{x.version=1}]){
    const bad=structuredClone(snapshot);mutate(bad);assert.throws(()=>validatePlanningContext(bad,binding))
  }
  assert.deepEqual(snapshotPlanningDraft(binding,draft()),legacy)
  assert.throws(()=>planningPromptInstructions('unknown'),/Unknown frozen/)
})
