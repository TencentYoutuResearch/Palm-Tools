import test from 'node:test'
import assert from 'node:assert/strict'
import { createBuilderPlanningSessions } from '../src/builder-planning-session.js'
import { registerBuilderPlanning } from '../src/builder-planning-route.js'
import { mkdtemp, rm, readdir, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builderPromptSnapshot } from '../src/builder-settings.js'
function fixture({ initialIndex = null, conflictOnce = false } = {}) {
  const draft = { id: 'draft', home_hub: 'fixture', status: 'draft', revision: 3,
    interview: { purpose: 'Fixture team', workspace_refs: [{ host_id: 'fixture', workspace_id: 'workspace', root_ref: '/tmp/fixture' }] } }
  const selected = { draft_id: 'draft', home_hub: 'fixture', runtime_binding: null, record: null }
  let state = structuredClone(initialIndex), revision = 0, created = 0, inspected = 0
  const paths = []
  const backendClient = { async call(path, input) {
    paths.push(path)
    if (path.endsWith('/selection')) return structuredClone(selected)
    if (path.endsWith('/drafts/draft')) return structuredClone(draft)
    if (!path.endsWith('/documents/session-index')) throw Object.assign(Error('kode backend (400): unknown workbench document'), { status: 400 })
    if (input) {
      if (conflictOnce) { conflictOnce = false; state = { ...state, externalUpdate: { preserved: true } }; revision++; throw Error('configuration changed') }
      if (input.expected_revision !== revision) throw Error('configuration changed')
      state = structuredClone(input.value); revision++
    }
    return { revision, value: structuredClone(state) }
  } }
  const ctx = { get: key => key === 'workspaceRegistry' ? { get: id => id === 'workspace' ? { id, path: '/tmp/fixture' } : undefined } : undefined }
  const service = { profiles: { list: () => [{ id: 'original-cli', type: 'codex' }], defaultProfileId: 'original-cli', defaultModelFor: () => ({ model: 'original-model' }) },
    hasRuntime: () => true, adapter: { listModels: async () => [{ id: 'original-model' }, { id: 'other-model' }] } }
  let sessions
  const createdSessions = new Map()
  const bridge = { async create(input) {
    created++; const admission = await sessions.sessionAdmission(input.session_id, { mode: 'fresh' })
    assert.equal(admission.binding.draft_id, 'draft')
    const value = { session_id: input.session_id, cwd: admission.binding.cwd }; createdSessions.set(input.session_id, value); return value
  }, async inspect(id) { inspected++; return createdSessions.get(id) ?? { session_id: id, cwd: '/tmp/fixture' } } }
  const deps = { ctx, backendClient, home: 'fixture', service, bridge }
  sessions = createBuilderPlanningSessions(deps)
  const input = { draft_id: 'draft', draft_revision: 3, request_id: 'request', workspace_id: 'workspace' }
  return { sessions, deps, input, draft, selected, bridge, paths, index: () => structuredClone(state), counts: () => ({ created, inspected }) }
}
test('new reservations freeze local Builder settings across updates and unknown outcomes', async () => {
  const f = fixture(); let text = 'Original owner instructions', revision = 1
  f.deps.service.profiles.localPreferences = { async open() {}, snapshot: () => ({ builderSystemPrompt: text, revision }) }
  const create = f.bridge.create
  f.bridge.create = async input => { await create(input); throw Error('Lost response') }
  await assert.rejects(f.sessions.open(f.input), /Lost response/)
  const record = Object.values(f.index().builderPlanning.sessions)[0]
  assert.deepEqual(record.builder_prompt, builderPromptSnapshot(text, revision))
  text = 'New owner instructions'; revision = 2
  assert.deepEqual((await f.sessions.sessionAdmission(record.binding.session_id, { mode: 'fresh' })).builder_prompt, record.builder_prompt)
  f.bridge.proveExisting = async ({ binding }) => ({ verified: true, session_id: binding.session_id, cwd: binding.cwd })
  await f.sessions.open(f.input)
  assert.deepEqual((await f.sessions.sessionAdmission(record.binding.session_id, { mode: 'restore' })).builder_prompt, record.builder_prompt)
  assert.equal(f.counts().created, 1)
})
test('new planning needs no project or Host choice and never mutates draft workspace refs', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-private-planning-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const f = fixture(); f.deps.service.profiles.path = join(root, 'profiles.json')
  f.draft.interview.workspace_refs = []
  const before = structuredClone(f.draft), { workspace_id, ...request } = f.input
  const opened = await f.sessions.open(request)
  assert.equal(opened.workspace_id, null); assert.deepEqual(opened.location, { kind: 'private_planning' })
  const bound = Object.values(f.index().builderPlanning.sessions)[0].binding
  assert.equal(bound.cwd.startsWith(join(root, 'planning-sessions') + '/'), true)
  assert.deepEqual(await readdir(bound.cwd), []); assert.equal((await stat(bound.cwd)).mode & 0o777, 0o700)
  assert.deepEqual(f.draft, before); assert.equal(opened.cwd, undefined)
  assert.equal(typeof bound.location.inode, 'string'); assert.equal(opened.location.inode, undefined)
  f.draft.interview.workspace_refs = [{ host_id: 'fixture', workspace_id: 'workspace', root_ref: '/tmp/fixture' }]
  const recovered = await f.sessions.open(request)
  assert.equal(Object.values(f.index().builderPlanning.sessions)[0].binding.cwd, bound.cwd)
  assert.equal(recovered.session_id, opened.session_id)
})
test('omitted workspace never silently reuses an existing saved project selection', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-private-planning-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const f = fixture(); f.deps.service.profiles.path = join(root, 'profiles.json')
  f.selected.record = { selection: { profile_id: 'original-cli', model: 'original-model', workspace: f.draft.interview.workspace_refs[0] } }
  const before = structuredClone(f.draft), { workspace_id, ...request } = f.input
  const opened = await f.sessions.open(request)
  assert.equal(opened.workspace_id, null); assert.notEqual(Object.values(f.index().builderPlanning.sessions)[0].binding.cwd, before.interview.workspace_refs[0].root_ref)
  assert.deepEqual(f.draft, before)
})
test('uses supported session-index and preserves all other owners through a CAS conflict', async () => {
  const initialIndex = { native_sessions: [{ dsh_session_id: 'existing-native' }], gui: { tabs: ['existing-tab'] }, creations: { existing: { stage: 'ready' } }, presentation: { sessionAvatars: { existing: 'avatar' } } }
  const f = fixture({ initialIndex, conflictOnce: true })
  assert.equal(await f.sessions.sessionAdmission('ordinary-session', { mode: 'restore' }), undefined)
  assert.deepEqual(f.index(), initialIndex)
  await f.sessions.open(f.input)
  const saved = f.index()
  for (const [key, value] of Object.entries(initialIndex)) assert.deepEqual(saved[key], value)
  assert.deepEqual(saved.externalUpdate, { preserved: true })
  assert.equal(saved.builderPlanning.version, 1)
  assert.equal(Object.values(saved.builderPlanning.sessions).length, 1)
  assert.ok(f.paths.filter(path => path.includes('/documents/')).every(path => path.endsWith('/documents/session-index')))
})
test('ordinary planning uses native defaults and one durable session, never funding or input', async () => {
  const f = fixture()
  assert.equal((await f.sessions.inspect('draft')).state, 'not_created')
  const [a, b] = await Promise.all([f.sessions.open(f.input), f.sessions.open(f.input)])
  assert.deepEqual(a, b); assert.equal(a.disposition, 'fresh'); assert.equal(a.execution_authorized, false)
  assert.match(a.session_id, /^session-/); assert.equal(a.initial_selection.provider, 'kode-agent-original-cli')
  assert.deepEqual(f.counts(), { created: 1, inspected: 0 })
  const restart = createBuilderPlanningSessions(f.deps)
  f.draft.revision++
  const recovered = await restart.open({ ...f.input, draft_revision: 4, request_id: 'reopen' })
  assert.equal(recovered.session_id, a.session_id); assert.equal(recovered.disposition, 'recovered')
  assert.deepEqual(f.counts(), { created: 1, inspected: 1 })
})
test('rejects controlled conflicts, revision drift and user-supplied session adoption', async () => {
  const f = fixture()
  await assert.rejects(f.sessions.open({ ...f.input, session_id: 'old' }), /Invalid planning/)
  await assert.rejects(f.sessions.open({ ...f.input, draft_revision: 2 }), /Draft changed/)
  f.selected.runtime_binding = { state: 'pending_start' }
  await assert.rejects(f.sessions.open(f.input), /controlled Builder/)
  assert.equal(f.counts().created, 0)
})
test('uncertain create never retries or silently opens another conversation', async () => {
  const f = fixture(); let calls = 0
  f.bridge.create = async () => { calls++; throw Error('connection lost after creation') }
  await assert.rejects(f.sessions.open(f.input), /connection lost/)
  assert.equal((await f.sessions.inspect('draft')).state, 'uncertain')
  await assert.rejects(f.sessions.open(f.input), /uncertain/)
  assert.equal(calls, 1)
})
test('lost create response reconciles only exact original request and proven unique identity', async () => {
  const f = fixture(); let created
  f.bridge.create = async input => { created = input; throw Error('response lost') }
  await assert.rejects(f.sessions.open(f.input), /response lost/)
  assert.deepEqual((await f.sessions.inspect('draft')).retry_request, f.input)
  let proofs = 0
  f.bridge.proveExisting = async input => { proofs++; assert.equal(input.binding.session_id, created.session_id); return { verified: true, session_id: created.session_id, cwd: '/tmp/fixture' } }
  await assert.rejects(f.sessions.open({ ...f.input, request_id: 'replacement' }), /exact original request/)
  assert.equal(proofs, 0)
  const recovered = await f.sessions.open(f.input)
  assert.equal(recovered.session_id, created.session_id); assert.equal(recovered.state, 'ready'); assert.equal(recovered.disposition, 'recovered')
  assert.equal(proofs, 1); assert.equal(recovered.retry_request, undefined)
})
test('wrong or incomplete recovery proof never changes uncertain association', async () => {
  const f = fixture()
  f.bridge.create = async () => { throw Error('response lost') }
  await assert.rejects(f.sessions.open(f.input))
  f.bridge.proveExisting = async () => ({ verified: true, session_id: 'another-session', cwd: '/tmp/fixture' })
  await assert.rejects(f.sessions.open(f.input), /insufficient recovery evidence/)
  assert.equal((await f.sessions.inspect('draft')).state, 'uncertain')
})
test('same draft cannot rebind workspace or model; changed draft workspace denies recovery', async () => {
  const f = fixture(); await f.sessions.open(f.input)
  await assert.rejects(f.sessions.open({ ...f.input, model: 'other-model' }), /binding will not be replaced/)
  f.draft.interview.workspace_refs[0].root_ref = '/tmp/other'
  await assert.rejects(f.sessions.open(f.input), /workspace changed/)
})
test('two registry writers reserve a draft through backend CAS only once', async () => {
  const f = fixture(), second = createBuilderPlanningSessions(f.deps)
  const results = await Promise.allSettled([f.sessions.open(f.input), second.open(f.input)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(f.counts().created, 1)
})
test('planning route rejects nonowner before reading and GET does not restore', async () => {
  let handler, reads = 0
  const ctx = { webServer: { register: route => { handler = route.handler } }, connection: { admit: () => ({ peer: { principal: { kind: 'agent' } } }) } }
  registerBuilderPlanning(ctx, { inspect: async () => { reads++; return { state: 'not_created' } } })
  let status, body; const res = { writeHead: code => { status = code }, end: value => { body = JSON.parse(value) } }
  await handler({ method: 'GET', url: '/api/kode/builder/planning?draft_id=draft' }, res)
  assert.equal(status, 403); assert.equal(reads, 0)
  ctx.connection.admit = () => ({ peer: { principal: { kind: 'owner' } } })
  await handler({ method: 'GET', url: '/api/kode/builder/planning?draft_id=draft' }, res)
  assert.equal(status, 200); assert.equal(body.state, 'not_created'); assert.equal(reads, 1)
})

import { createBuilderPlanningResources } from '../src/builder-planning-resources.js'
import { BUILDER_PLANNING_PROMPT_V2_VERSION } from '../src/builder-planning-prompt-v2.js'
test('v2 reservations freeze resource observation across retry, restore and draft reads', async () => {
  const f = fixture(); let reads = 0
  const resources = await createBuilderPlanningResources({home:'fixture'})()
  const sessions = createBuilderPlanningSessions({...f.deps, readResources: async () => { reads++; return resources }})
  f.bridge.create = async () => { throw Error('Lost response') }
  await assert.rejects(sessions.open(f.input), /Lost response/)
  const record = Object.values(f.index().builderPlanning.sessions)[0]
  assert.equal(record.planning_prompt_version, BUILDER_PLANNING_PROMPT_V2_VERSION)
  const admitted = await sessions.sessionAdmission(record.binding.session_id, {mode:'fresh'})
  assert.equal(admitted.context.version, 2); assert.deepEqual(admitted.context.data.resources_snapshot, resources)
  f.bridge.proveExisting = async ({binding}) => ({verified:true, session_id:binding.session_id, cwd:binding.cwd})
  await sessions.open(f.input)
  assert.deepEqual((await sessions.sessionAdmission(record.binding.session_id, {mode:'restore'})).resources_snapshot, resources)
  assert.deepEqual(await sessions.readContext(record.binding.session_id), admitted.context)
  assert.equal(reads, 1)
  const cold = createBuilderPlanningSessions({...f.deps, readResources: async () => { throw Error('Must not rediscover old reservation') }})
  assert.deepEqual(await cold.readContext(record.binding.session_id), admitted.context)
})
