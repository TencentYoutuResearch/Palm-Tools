import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentRuntimeAdapter } from '../src/agent-runtime.js'
import { readAssignmentRolePrompt, mountAssignmentRolePrompt, assertAssignmentRolePrompt, assertAssignmentRolePromptDurable } from '../src/assignment-role-prompt.js'
function fixture() {
  const binding = { managedAssignment: { id: 'assignment' }, managedOperation: { id: 'operation', attempt: 1, epoch: 2 } }
  const team = { id: 'team', home_hub: 'home', revision: 3, spec: { coordinator_prompt: 'COORDINATOR_NOT_FOR_WORKER', workers: [{ id: 'review', role_prompt: 'WORKER_FROZEN_V3' }, { id: 'other', role_prompt: 'OTHER_WORKER' }] } }
  const assignment = { id: 'assignment', state: 'prepared', worker: { node_id: 'home', session_id: 'worker-session' }, bundle: { operation: binding.managedOperation },
    run_id: 'run', team_id: 'team', context_hash: 'context', authorization_hash: 'authority', candidate: { worker_id: 'review' } }
  const run = { id: 'run', home_hub: 'home', team_id: 'team', team_revision: 3, context_hash: 'context', authorization: { snapshot_hash: 'authority' }, context: { team } }
  const sections = [], session = Session.create('worker-session'), agent = { id: session.id, session }
  const ctx = { sessions: { flush: async () => true }, get: name => name === 'systemPrompt' ? { section: value => { sections.push(value); return () => {} } } : undefined }
  const runtime = { host: 'home', profiles: { binding: () => binding }, client: { call: async path => structuredClone(path.endsWith('/assignment') ? assignment : run) } }
  return { binding, assignment, run, team, runtime, agent, ctx, sections }
}
test('Worker resolves only the frozen selected role and rejects wrong Team, epoch or Worker', async () => {
  const f = fixture(), snapshot = await readAssignmentRolePrompt(f.runtime, f.agent, f.binding)
  assert.equal(snapshot.text, 'WORKER_FROZEN_V3'); assert.equal(snapshot.team_revision, 3); assert.deepEqual(snapshot.role, { kind: 'worker', worker_id: 'review' })
  for (const change of [() => { f.run.team_revision = 4 }, () => { f.assignment.bundle.operation = { ...f.binding.managedOperation, epoch: 9 } }, () => { f.assignment.candidate.worker_id = 'missing' }]) {
    const originalRun = structuredClone(f.run), originalAssignment = structuredClone(f.assignment); change()
    await assert.rejects(readAssignmentRolePrompt(f.runtime, f.agent, f.binding)); Object.assign(f.run, originalRun); Object.assign(f.assignment, originalAssignment)
  }
})
test('official fixed prompt is supplemented with exact durable role and prepared-input attestation', async () => {
  const f = fixture(); await mountAssignmentRolePrompt(f.ctx, f.agent, f.runtime)
  assert.equal(f.sections.length, 1); assert.equal(f.sections[0].name, 'kode.assignment.owner-role'); assert.equal(f.sections[0].order, 81)
  assert.match(f.sections[0].text, /WORKER_FROZEN_V3/); assert.doesNotMatch(f.sections[0].text, /COORDINATOR_NOT_FOR_WORKER|OTHER_WORKER/)
  const snapshot = await readAssignmentRolePrompt(f.runtime, f.agent, f.binding), options = { messages: [{ role: 'system', content: [{ type: 'text', text: 'FIXED PROCEDURE\n' + f.sections[0].text }] }] }
  await assertAssignmentRolePrompt(f.runtime, f.agent, f.binding, f.assignment, { role_prompt: snapshot }, options)
  await assert.rejects(assertAssignmentRolePrompt(f.runtime, f.agent, f.binding, f.assignment, {}, options), /differs/)
  await assert.rejects(assertAssignmentRolePrompt(f.runtime, f.agent, f.binding, f.assignment, { role_prompt: snapshot }, { messages: [] }), /omits/)
  await mountAssignmentRolePrompt(f.ctx, f.agent, f.runtime)
  f.team.spec.workers[0].role_prompt = 'Changed frozen record'
  await assert.rejects(mountAssignmentRolePrompt(f.ctx, f.agent, f.runtime), /changed/)
})
test('legacy absent role leaves no custom section, and an old journal cannot silently adopt one', async () => {
  const f = fixture(); delete f.team.spec.workers[0].role_prompt
  await mountAssignmentRolePrompt(f.ctx, f.agent, f.runtime); assert.equal(f.sections.length, 0)
  f.agent.session.append('user/message', { id: 'old', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Old input' }] }, { surfaceOp: 'append' })
  f.team.spec.workers[0].role_prompt = 'New prompt'
  await assert.rejects(mountAssignmentRolePrompt(f.ctx, f.agent, f.runtime), /cannot adopt/)
})
test('real AgentRuntime Worker branch appends the frozen role and rejects authority drift before a native turn', async () => {
  const f = fixture(), root = await mkdtemp(join(tmpdir(), 'kode-worker-role-')), log = join(root, 'wire.jsonl')
  const binding = Object.assign(f.binding, { revision: 'fixed-profile', profile: { id: 'fixture', type: 'cursor', executable: process.execPath,
    args: [fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))], env: { KODE_ACP_ROLE_PROMPT: '1', KODE_ACP_FIXTURE_LOG: log } } })
  const profiles = { binding: () => binding, patchBinding: async (_id, patch) => Object.assign(binding, patch),
    update: async action => action({ bindings: { [f.agent.id]: binding } }) }
  f.runtime.profiles = profiles
  f.agent.ctx = { sessions: { flush: async () => true }, parallel: async () => true, get: () => undefined }
  const ctx = { get: name => name === 'kodeAgents' ? { officialExecution: f.runtime } : undefined }
  const adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: () => {} })
  let native
  try {
    native = await adapter.createRuntime(f.agent, binding, [], new AbortController().signal)
    const opened = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).find(row => row.method === 'session/new')
    assert.match(opened.params.systemPrompt.content[0].text, /WORKER_FROZEN_V3/)
    assert.doesNotMatch(opened.params.systemPrompt.content[0].text, /COORDINATOR_NOT_FOR_WORKER|OTHER_WORKER/)
    f.assignment.bundle.operation = { ...binding.managedOperation, epoch: 99 }
    await assert.rejects(async () => { for await (const event of native.turn([{ type: 'text', text: 'Do not infer' }], { model: 'fixture-fast' })) {} }, /changed/)
    assert.doesNotMatch(await readFile(log, 'utf8'), /"method":"session\/prompt"/)
  } finally { await native?.close(); await rm(root, { recursive: true, force: true }) }
})

test('trusted role setup leaves fresh admission empty and persists only before publication', async () => {
  const f=fixture();f.agent.ctx=f.ctx;let flushes=0;f.ctx.sessions.flush=async()=>{flushes++;return true}
  await mountAssignmentRolePrompt(f.ctx,f.agent,f.runtime,{prepublication:true})
  assert.deepEqual(f.agent.session.snapshotEvents(),[]);assert.equal(flushes,0)
  await assertAssignmentRolePromptDurable(f.agent,f.runtime)
  assert.equal(flushes,1);assert.equal(f.agent.session.snapshotEvents().length,1)
  const g=fixture();g.agent.ctx=g.ctx
  await mountAssignmentRolePrompt(g.ctx,g.agent,g.runtime,{prepublication:true})
  g.team.spec.workers[0].role_prompt='Changed before publication'
  await assert.rejects(assertAssignmentRolePromptDurable(g.agent,g.runtime),/changed before publication/)
  assert.deepEqual(g.agent.session.snapshotEvents(),[])
})
