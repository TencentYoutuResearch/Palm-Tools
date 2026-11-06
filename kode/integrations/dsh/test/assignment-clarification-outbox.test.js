import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AssignmentClarificationOutbox } from '../src/assignment-clarification-outbox.js'
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'kode-question-outbox-'))
 t.after(() => rm(root, { recursive: true, force: true }))
 const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'profile', name: 'Worker', type: 'dsh' }])
 await profiles.bind('worker', 'profile')
 const operation = { id: 'operation', attempt: 1, epoch: 1 }
 await profiles.patchBinding('worker', { managedOperation: operation, managedAssignment: { id: 'assignment' } })
 const assignment = { id: 'assignment', run_id: 'run', team_id: 'team', stage_id: 'implement', stage_attempt: 1, context_hash: 'context', worker: { node_id: 'home', session_id: 'worker' }, dispatch: { command: { operation } } }
 let saved, posts = 0, drop = false
 const runtime = { host: 'home', profiles, client: { async call(path, body) {
  if (path.endsWith('/work-assignments/assignment')) return assignment
  if (!body) return { clarification: saved ?? null }
  posts++
  saved = { snapshot: 'assignment_clarification_receipt.v1', request: body, assignment_id: 'assignment', run_id: 'run', team_id: 'team', stage_id: 'implement', stage_attempt: 1, context_hash: 'context', run_revision: 2, worker: assignment.worker, home_hub: 'home', state: 'pending', completion_authorized: false }
  if (drop) throw Error('fixture committed response lost')
  return saved
 } } }
 return { runtime, operation, agent: { id: 'worker' }, posts: () => posts, drop: () => { drop = true }, saved: () => saved }
}
test('clarification intent recovers lost Home response from disk without repeating its POST', async t => {
 const f = await fixture(t), box = new AssignmentClarificationOutbox(f.runtime)
 f.drop()
 await assert.rejects(box.record(f.agent, { call_id: 'call', operation: f.operation }, [{ id: 'scope', question: 'Which scope?' }]), /pending Home/)
 assert.equal(f.posts(), 1)
 await box.close()
 const profiles = await new AgentProfiles(f.runtime.profiles.path).open()
 const restored = new AssignmentClarificationOutbox({ ...f.runtime, profiles })
 t.after(() => restored.close())
 await restored.tick()
 assert.equal(profiles.binding('worker').clarificationOutbox.call.acknowledged, true)
 assert.deepEqual(profiles.binding('worker').clarificationOutbox.call.receipt, f.saved())
 assert.equal(f.posts(), 1)
})
test('clarification refuses a foreign binding and a conflicting question identity', async t => {
 const f = await fixture(t), box = new AssignmentClarificationOutbox(f.runtime)
 t.after(() => box.close())
 await assert.rejects(box.record(f.agent, { call_id: 'call', operation: { ...f.operation, epoch: 2 } }, [{ id: 'q', question: 'Scope?' }]), /binding/)
 assert.equal(f.posts(), 0)
 await box.record(f.agent, { call_id: 'call', operation: f.operation }, [{ id: 'q', question: 'Scope?' }])
 await assert.rejects(box.record(f.agent, { call_id: 'call', operation: f.operation }, [{ id: 'q', question: 'Different?' }]), /conflict/)
 assert.equal(f.posts(), 1)
})


test('a fabricated cross-run Home receipt stays pending until its exact scoped receipt is read', async t => {
 const f = await fixture(t), box = new AssignmentClarificationOutbox(f.runtime)
 t.after(() => box.close())
 const call = f.runtime.client.call
 f.runtime.client.call = async (...args) => {
  const result = await call(...args)
  return args[1] ? { ...result, run_id: 'foreign' } : result
 }
 await assert.rejects(box.record(f.agent, { call_id: 'call', operation: f.operation }, [{ id: 'q', question: 'Scope?' }]), /pending Home/)
 assert.equal(f.runtime.profiles.binding('worker').clarificationOutbox.call.acknowledged, false)
 f.runtime.client.call = call
 await box.tick()
 assert.equal(f.runtime.profiles.binding('worker').clarificationOutbox.call.acknowledged, true)
 assert.equal(f.posts(), 1)
})
