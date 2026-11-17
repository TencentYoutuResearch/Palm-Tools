import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativePlanningBridge } from '../src/native-planning-bridge.js'
import { snapshotPlanningDraft, PLANNING_CONTEXT_RECORD } from '../src/planning-draft-context.js'
import { NATIVE_PLANNING_RECORD } from '../src/native-planning-session.js'
function fixture() {
  const binding = { version: 1, mode: 'interactive_planning', home_hub: 'home', draft_id: 'draft', context_epoch: 1,
    session_id: 'session-11111111-1111-4111-8111-111111111111', workspace_id: 'workspace', cwd: '/fixture' }
  const context = snapshotPlanningDraft(binding, {id:'draft',home_hub:'home',status:'draft',revision:1,interview:{purpose:'Plan',workspace_refs:[]}})
  const profile = { id: 'native', type: 'claude' }, selection = { provider: 'kode-agent-native', model: 'model' }
  const state = { bound: { profile, seenInputs: [] }, header: { id: binding.session_id, cwd: binding.cwd }, inherited: 0,
    events: [{ type: NATIVE_PLANNING_RECORD, data: binding }, { type: 'model/selection', data: selection }, {type: PLANNING_CONTEXT_RECORD,data:context}], opened: 0, closed: 0 }
  const forbidden = () => { throw Error('Recovery must not create, resolve, change settings, or call CLI') }
  const service = { profiles: { list: () => [profile], binding: () => state.bound, bind: forbidden, patchBinding: forbidden }, adapter: { listModels: forbidden } }
  const ctx = { get: name => ({
    kodePlanningRuntime: { sessionAdmission: async () => ({ binding, selection, context }) },
    workspaceRegistry: { get: () => ({ path: '/fixture' }) },
    sessionController: { create: forbidden, resolveAgent: forbidden },
    sessionPersistence: { open: async (id, mode) => {
      assert.equal(id, binding.session_id); assert.equal(mode, 'read'); state.opened++
      return { header: state.header, inheritedEventCount: state.inherited, read: async () => ({ events: state.events }), close: async () => { state.closed++ } }
    } },
  })[name] }
  return { state, input: { binding, profile_id: profile.id, selection }, bridge: createNativePlanningBridge({ ctx, service }) }
}
test('blank creation proof reads only exact durable identity and closes its reader', async () => {
  const f = fixture(), before = structuredClone(f.state.events)
  assert.equal((await f.bridge.proveExisting(f.input)).verified, true)
  assert.deepEqual(f.state.events, before); assert.equal(f.state.opened, 1); assert.equal(f.state.closed, 1)
})
test('history, inbox, model drift, inherited lineage, and wrong draft cannot reconcile', async () => {
  for (const mutate of [
    f => f.state.events.push({ type: 'user/message', data: {} }),
    f => f.state.events.push({ type: 'agent/inbox/spliced', data: {} }),
    f => f.state.events.push({ type: 'turn/start', data: {} }),
    f => f.state.events.push({ type: 'model/selection', data: { ...f.input.selection, model: 'other' } }),
    f => { f.state.inherited = 1 },
    f => { f.state.header.parentSession = 'other' },
    f => { f.state.events[0] = { type: NATIVE_PLANNING_RECORD, data: { ...f.input.binding, draft_id: 'other' } } },
    f => { f.state.events.splice(1,1) },
    f => { f.state.events.pop() },
  ]) {
    const f = fixture(); mutate(f)
    await assert.rejects(f.bridge.proveExisting(f.input))
    assert.equal(f.state.opened, f.state.closed)
  }
})
test('managed authority or preexisting native thread rejects before reading journal', async () => {
  for (const patch of [{ managedOperation: { id: 'op' } }, { threadId: 'old' }, { inFlight: { inputIds: [] } }, { seenInputs: ['user'] }]) {
    const f = fixture(); Object.assign(f.state.bound, patch)
    await assert.rejects(f.bridge.proveExisting(f.input)); assert.equal(f.state.opened, 0)
  }
})
