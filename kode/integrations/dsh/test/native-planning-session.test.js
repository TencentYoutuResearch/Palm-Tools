import { snapshotPlanningDraft } from '../src/planning-draft-context.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeAgentFactory } from '../src/native-agent-factory.js'
import { boundaryProjection, inboxProjection } from '../src/native-agent-driver.js'
import { nativePlanningBinding, nativePlanningPrompt, NATIVE_PLANNING_RECORD } from '../src/native-planning-session.js'
import { builderPromptSnapshot, BUILDER_PROMPT_RECORD } from '../src/builder-settings.js'
import { createBuilderPlanningSessions } from '../src/builder-planning-session.js'
import { createNativePlanningBridge } from '../src/native-planning-bridge.js'
import { isolatedHub } from './support/isolated-hub.js'
import { readBuilderProposalCandidate } from '../src/builder-proposal-candidate.js'
import { saveBuilderProposal } from '../src/builder-proposal-route.js'
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-native-planning-'))), ctx = new Context()
  await ctx.plugin(Sessions); await ctx.plugin(Agents); await ctx.plugin(Projections); await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  ctx.sessionProjections.register(boundaryProjection); ctx.sessionProjections.register(inboxProjection)
  const calls = [], announces = [], binding = { version: 1, mode: 'interactive_planning', home_hub: 'fixture', draft_id: 'draft', context_epoch: 1,
    session_id: 'session-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', workspace_id: 'workspace', cwd: root }
  const selection = { provider: 'kode-agent-original-cli', model: 'original-model' }, state = { admitted: true }
  const context = snapshotPlanningDraft(binding, { id: 'draft', home_hub: 'fixture', status: 'draft', revision: 1, interview: { purpose: 'Fixture team', workspace_refs: [] } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('kodeAgents', { adapter: { async *stream(options) {
    calls.push(options); yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: state.reply ?? 'native' } }; yield { type: 'finish', reason: { kind: 'stop' } }
  }, async closeSession() {}, hasContinuation: () => false } })
  ctx.provide('kodePlanningRuntime', { inspect: id => state.registry.inspect(id), readContext: id => state.registry ? state.registry.readContext(id) : context, sessionAdmission: (...args) => state.registry ? state.registry.sessionAdmission(...args) : state.admitted ? { binding, selection, context } : undefined })
  ctx.on('agent/created', ({ agent }) => { announces.push(nativePlanningBinding(agent)) })
  let factory
  const fiber = await ctx.plugin({ name: 'fixture-native-planning', inject: ['sessions', 'agents', 'sessionPersistence', 'sessionProjections', 'kodeAgents', 'tools'], apply(scope) { factory = new NativeAgentFactory(scope) } })
  await fiber.await?.()
  t.after(async () => { await factory.close(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { ctx, factory, calls, announces, binding, state, options: { sessionId: binding.session_id, meta: { cwd: root } } }
}
test('planning marker is durable before announcement and original native input/restore are reused', async t => {
  const f = await fixture(t), handle = await f.factory.createAgent(f.ctx, f.options), agent = handle.agent
  assert.deepEqual(nativePlanningBinding(agent), f.binding)
  assert.deepEqual(f.announces, [f.binding]); assert.equal(agent.session.snapshotEvents()[0].type, NATIVE_PLANNING_RECORD)
  assert.equal(f.calls.length, 0)
  agent.followup({ id: 'owner-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Plan a team' }] })
  await agent.whenIdle(); assert.equal(f.calls.length, 1)
  await handle.dispose()
  const restored = await f.factory.resume(f.ctx, { resumeSessionId: agent.id })
  assert.deepEqual(nativePlanningBinding(restored.agent), f.binding); assert.equal(f.calls.length, 1)
  await restored.dispose()
})
test('reserved Builder instructions are journaled, restored unchanged, and reject a changed reservation', async t => {
  const f = await fixture(t), original = f.ctx.get('kodePlanningRuntime').sessionAdmission
  let snapshot = builderPromptSnapshot('Discuss verification before proposing roles', 7)
  f.ctx.get('kodePlanningRuntime').sessionAdmission = async (...args) => ({ ...await original(...args), builder_prompt: snapshot })
  const handle = await f.factory.createAgent(f.ctx, f.options)
  assert.deepEqual(nativePlanningPrompt(handle.agent), snapshot)
  const record = handle.agent.session.snapshotEvents().find(event => event.type === BUILDER_PROMPT_RECORD)
  assert.deepEqual(record.data, snapshot)
  await handle.dispose()
  const restored = await f.factory.resume(f.ctx, { resumeSessionId: f.binding.session_id })
  assert.deepEqual(nativePlanningPrompt(restored.agent), snapshot)
  assert.equal(restored.agent.session.snapshotEvents().filter(event => event.type === BUILDER_PROMPT_RECORD).length, 1)
  await restored.dispose()
  snapshot = builderPromptSnapshot('Different later preference', 8)
  await assert.rejects(f.factory.resume(f.ctx, { resumeSessionId: f.binding.session_id }), /Frozen Builder prompt journal changed/)
})
test('planning cannot adopt seeded or inherited context and registry loss cannot restore ordinary', async t => {
  const f = await fixture(t)
  for (const extra of [{ seed: [] }, { inheritedEventCount: 0 }, { parentAgent: {} }, { meta: { ...f.options.meta, parentSession: 'other' } }]) await assert.rejects(f.factory.createAgent(f.ctx, { ...f.options, ...extra }), /fresh conversation/)
  const handle = await f.factory.createAgent(f.ctx, f.options)
  handle.agent.session.append('turn/start', { turn: 1 })
  await handle.agent.ctx.sessions.flush(handle.agent.session); await handle.dispose()
  const before = await f.ctx.get('sessionPersistence').open(f.binding.session_id, 'read')
  const expected = (await before.read()).events; await before.close()
  f.state.admitted = false
  await assert.rejects(f.factory.resume(f.ctx, { resumeSessionId: f.binding.session_id }), /registry unavailable/)
  const after = await f.ctx.get('sessionPersistence').open(f.binding.session_id, 'read')
  assert.deepEqual((await after.read()).events, expected); await after.close()
})
test('ordinary native resume works with planning installed and the real Hub document allowlist', async t => {
  const f = await fixture(t)
  f.state.admitted = false
  const original = await f.factory.createAgent(f.ctx, { ...f.options, agentOptions: { provider: 'kode-agent-original-cli', model: 'original-model' } })
  original.agent.followup({ id: 'ordinary-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Original ordinary session' }] })
  await original.agent.whenIdle()
  const events = original.agent.session.snapshotEvents()
  assert.equal(events.some(e => e.type === NATIVE_PLANNING_RECORD), false)
  await original.dispose()
  const paths = [], originalIndex = { version: 1, native_sessions: [{ dsh_session_id: f.binding.session_id }], gui: { tabs: [] }, creations: {} }
  const backendClient = { async call(path, input) {
    paths.push(path); assert.equal(input, undefined, 'ordinary resume must not write a planning association')
    if (path !== '/api/v1/messaging/workbench/documents/session-index') throw Object.assign(Error('kode backend (400): unknown workbench document'), { status: 400 })
    return { revision: 7, value: structuredClone(originalIndex) }
  } }
  f.state.registry = createBuilderPlanningSessions({ ctx: f.ctx, backendClient, home: 'fixture', service: {}, bridge: {} })
  const restored = await f.factory.resume(f.ctx, { resumeSessionId: f.binding.session_id })
  assert.equal(nativePlanningBinding(restored.agent), undefined)
  assert.equal(restored.agent.options.model, 'original-model')
  const restoredEvents = restored.agent.session.snapshotEvents()
  assert.deepEqual(restoredEvents.slice(0, events.length), events)
  assert.ok(restoredEvents.slice(events.length).every(event => event.type === 'session/end-seed'))
  assert.equal(f.calls.length, 1, 'resume does not replay input')
  assert.deepEqual(paths, ['/api/v1/messaging/workbench/documents/session-index'])
  await restored.dispose()
})
for (const realHub of [false, ...(process.env.KODE_TEST_HUB_BIN ? [true] : [])]) for (const privateCwd of [false, true]) for (const loseCreationResponse of [false, true]) test(`owner registry and native bridge join real factory, JSONL and cold recovery (real Hub: ${realHub}, private cwd: ${privateCwd}, lost response: ${loseCreationResponse})`, async t => {
  const f = await fixture(t), service = f.ctx.get('kodeAgents'), bound = new Map(), ids = new Set(), handles = new Map()
  const profile = { id: 'original-cli', type: 'codex' }
  service.profiles = { path: join(f.binding.cwd, 'profiles.json'), list: () => [profile], defaultProfileId: profile.id, defaultModelFor: () => ({ model: 'original-model' }),
    binding: id => bound.get(id), async bind(id, profileId) { assert.equal(profileId, profile.id); bound.set(id, { profile }) } }
  service.hasRuntime = type => type === 'codex'; service.recordBinding = () => {}
  service.adapter.listModels = async () => [{ id: 'original-model' }, { id: 'another-model' }]
  f.ctx.provide('workspaceRegistry', { get: id => id === 'workspace' ? { id, path: f.binding.cwd } : undefined })
  // Controller fixture delegates every lifecycle operation to the real factory.
  f.ctx.provide('sessionController', {
    async list() { return { items: [...ids].map(sessionId => ({ sessionId })) } },
    async create({ sessionId, agentPreset, workspaceId, cwd }) {
      assert.equal(agentPreset, 'kode-native')
      if (privateCwd) { assert.equal(workspaceId, undefined); assert.equal(cwd.startsWith(join(f.binding.cwd, 'planning-sessions') + '/'), true) }
      else { assert.equal(workspaceId, 'workspace'); assert.equal(cwd, undefined) }
      handles.set(sessionId, await f.factory.createAgent(f.ctx, { sessionId, meta: { cwd: cwd ?? f.binding.cwd, agentPreset } }))
      ids.add(sessionId); return { sessionId }
    },
    async resolveAgent(id) {
      if (!handles.has(id)) handles.set(id, await f.factory.resume(f.ctx, { resumeSessionId: id }))
      return { agent: handles.get(id).agent }
    }, async rename() {},
  })
  let document = null, revision = 0
  let backendClient = { async call(path, input) {
    if (path.endsWith('/selection')) return { draft_id: 'draft', home_hub: 'fixture', runtime_binding: null, record: null }
    if (path.endsWith('/drafts/draft')) return { id: 'draft', home_hub: 'fixture', revision: 1, status: 'draft', interview: { purpose: 'Fixture team', workspace_refs: privateCwd ? [] : [{ host_id: 'fixture', workspace_id: 'workspace', root_ref: f.binding.cwd }] } }
    if (!path.endsWith('/documents/session-index')) throw Object.assign(Error('kode backend (400): unknown workbench document'), { status: 400 })
    if (input) { assert.equal(input.expected_revision, revision); document = structuredClone(input.value); revision++ }
    return { revision, value: structuredClone(document) }
  } }
  if (realHub) {
    const hub = await isolatedHub('fixture'); t.after(() => hub.close()); backendClient = hub.client
    await backendClient.call('/api/v1/messaging/superagents/drafts', { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false,
      interview: { purpose: 'Fixture team', workspace_refs: privateCwd ? [] : [{ host_id: 'fixture', workspace_id: 'workspace', root_ref: f.binding.cwd }], answers: {}, questions: [], proposed_team: null } })
    f.state.reply = JSON.stringify({ format: 'kode.team-proposal.v1', proposed_team: { name: 'Fixture team', purpose: 'Plan only', kind: 'coordinator', workspace_refs: [], execution_targets: [], workers: [], coordinator_targets: [], workflow_pack_refs: [],
      coordinator_prompt: 'Owner reviews this role.', grant_id: null, budget_policy_id: null, scheduling_policy_id: null, limits: { max_active_assignments: 1, max_active_runs: 1 }, proactive_mode: 'off' } })
  }
  const nativeBridge = createNativePlanningBridge({ ctx: f.ctx, service })
  const deps = { ctx: f.ctx, backendClient, home: 'fixture', service, bridge: { ...nativeBridge, async create(input) {
    const result = await nativeBridge.create(input)
    if (loseCreationResponse) throw Error('Fixture lost creation response')
    return result
  } } }
  f.state.registry = createBuilderPlanningSessions(deps)
  const request = { draft_id: 'draft', draft_revision: 1, request_id: 'open', ...(privateCwd ? {} : { workspace_id: 'workspace' }) }
  if (loseCreationResponse) {
    await assert.rejects(f.state.registry.open(request), /lost creation response/)
    assert.equal((await f.state.registry.inspect('draft')).state, 'uncertain')
    assert.equal(f.calls.length, 0); assert.equal(ids.size, 1)
  }
  const opened = await f.state.registry.open(request), agent = handles.get(opened.session_id).agent
  assert.equal(opened.disposition, loseCreationResponse ? 'recovered' : 'fresh'); assert.equal(f.calls.length, 0)
  assert.equal(nativePlanningBinding(agent).draft_id, 'draft'); assert.equal(bound.get(agent.id).managedOperation, undefined)
  agent.followup({ id: 'first', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Planning only' }] })
  await agent.whenIdle(); assert.equal(f.calls.length, 1)
  agent.selectModel({ provider: 'kode-agent-original-cli', model: 'another-model' })
  await agent.ctx.sessions.flush(agent.session); await handles.get(agent.id).dispose(); handles.delete(agent.id)
  f.state.registry = createBuilderPlanningSessions(deps)
  const reopened = await f.state.registry.open(request), restored = handles.get(opened.session_id).agent
  assert.equal(reopened.session_id, opened.session_id); assert.equal(reopened.disposition, 'recovered')
  assert.equal(reopened.initial_selection.model, 'original-model'); assert.equal(restored.options.model, 'another-model')
  assert.equal(f.calls.length, 1); assert.equal(ids.size, 1)
  restored.followup({ id: 'second', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue' }] })
  await restored.whenIdle(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].model, 'another-model')
  if (realHub) {
    const preview = await readBuilderProposalCandidate(f.ctx, backendClient, 'draft')
    assert.equal(preview.state, 'candidate'); assert.equal(preview.source.session_id, restored.id)
    assert.equal(preview.candidate.proposed_team.coordinator_prompt, 'Owner reviews this role.')
    assert.deepEqual((await backendClient.call('/api/v1/messaging/teams')).items, [])
    const saved = await saveBuilderProposal(backendClient, { draft_id: 'draft', expected_revision: preview.draft_revision, request_id: 'reviewed-save', proposed_team: preview.candidate.proposed_team })
    assert.equal(saved.revision, 2); assert.equal(saved.eligible_for_execution, false)
    assert.deepEqual((await backendClient.call('/api/v1/messaging/teams')).items, [], 'saving a reviewed proposal does not accept or activate')
  }
})

import { createBuilderPlanningResources } from '../src/builder-planning-resources.js'
import { BUILDER_PLANNING_PROMPT_V2_VERSION, BUILDER_PLANNING_PROMPT_V2 } from '../src/builder-planning-prompt-v2.js'
import { nativePlanningPromptVersion } from '../src/native-planning-session.js'
import { nativeRoleInstructions } from '../src/native-role-prompt.js'
test('v2 journal restores exact frozen version and rejects changed or removed registry resources', async t => {
  const f = await fixture(t), original = f.ctx.get('kodePlanningRuntime').sessionAdmission
  const resources = await createBuilderPlanningResources({home:'fixture'})()
  let fields = {planning_prompt_version:BUILDER_PLANNING_PROMPT_V2_VERSION,resources_snapshot:resources}
  f.ctx.get('kodePlanningRuntime').sessionAdmission = async (...args) => {
    const old = await original(...args)
    const draft = {id:'draft',home_hub:'fixture',status:'draft',revision:1,interview:{purpose:'Fixture team',workspace_refs:[]}}
    return {...old,...fields,context:snapshotPlanningDraft(f.binding,draft,fields)}
  }
  const handle = await f.factory.createAgent(f.ctx,f.options)
  assert.equal(nativePlanningPromptVersion(handle.agent),BUILDER_PLANNING_PROMPT_V2_VERSION)
  assert.equal(nativeRoleInstructions(null,{nativePlanning:true,planningPromptVersion:nativePlanningPromptVersion(handle.agent)}),BUILDER_PLANNING_PROMPT_V2)
  const prefix=structuredClone(handle.agent.session.snapshotEvents());await handle.dispose()
  const restored=await f.factory.resume(f.ctx,{resumeSessionId:f.binding.session_id})
  assert.equal(nativePlanningPromptVersion(restored.agent),BUILDER_PLANNING_PROMPT_V2_VERSION)
  assert.deepEqual(restored.agent.session.snapshotEvents().slice(0,prefix.length),prefix);await restored.dispose()
  const changed=await createBuilderPlanningResources({home:'fixture',workspaceRegistry:{list:async()=>[]}})()
  fields={planning_prompt_version:BUILDER_PLANNING_PROMPT_V2_VERSION,resources_snapshot:changed}
  await assert.rejects(f.factory.resume(f.ctx,{resumeSessionId:f.binding.session_id}),/prompt version or resources changed/)
  fields={}
  await assert.rejects(f.factory.resume(f.ctx,{resumeSessionId:f.binding.session_id}),/prompt version or resources changed/)
  fields={planning_prompt_version:'unknown',resources_snapshot:resources}
  await assert.rejects(f.factory.resume(f.ctx,{resumeSessionId:f.binding.session_id}),/Unknown frozen/)
})
