import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexSession } from '../src/codex-session.js'
import { snapshotTeamRolePrompt } from '../src/team-role-prompts.js'

const snapshot = revision => snapshotTeamRolePrompt({
  home_hub: 'home', team_id: 'team', team_revision: revision,
  spec: { coordinator_prompt: 'Coordinate this Team only.' },
})
function fixture(handlers = {}, acceptedRolePrompt = null) {
  const calls = [], session = new CodexSession({}, '/fixture', handlers)
  session.threadId = 'thread'
  session.active = { turnId: 'turn', done: false }
  session.acceptedRolePrompt = acceptedRolePrompt
  session.rpc = { closed: false, request: async (method, params) => {
    calls.push({ method, params })
    return { turnId: 'turn' }
  } }
  return { session, calls }
}
test('Codex steering refuses role revision drift before any RPC', async () => {
  const f = fixture({ resolveRolePrompt: async () => snapshot(2) }, snapshot(1))
  await assert.rejects(f.session.steer([{ type: 'text', text: 'Do not send' }]), /Role prompt changed/)
  assert.deepEqual(f.calls, [])
})
test('Codex steering preserves an unchanged exact role snapshot', async () => {
  let checks = 0
  const f = fixture({ resolveRolePrompt: async ({ mode }) => {
    assert.equal(mode, 'check'); checks++; return snapshot(1)
  } }, snapshot(1))
  const input = [{ type: 'text', text: 'Continue' }]
  assert.deepEqual(await f.session.steer(input), { turnId: 'turn' })
  assert.equal(checks, 1)
  assert.deepEqual(f.calls, [{ method: 'turn/steer', params: { threadId: 'thread', expectedTurnId: 'turn', input } }])
})
test('ordinary Codex steering without role configuration stays compatible', async () => {
  const f = fixture()
  assert.deepEqual(await f.session.steer([{ type: 'text', text: 'Continue' }]), { turnId: 'turn' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].method, 'turn/steer')
})
for (const change of ['ended', 'next-turn']) test(`Codex steering rejects ${change} during role verification without sending`, async () => {
  const f = fixture({ resolveRolePrompt: async () => {
    if (change === 'ended') f.session.active.done = true
    else f.session.active = { turnId: 'next-turn', done: false }
    return snapshot(1)
  } }, snapshot(1))
  await assert.rejects(f.session.steer([{ type: 'text', text: 'Do not redirect' }]), error => error.rpcRejected === true)
  assert.deepEqual(f.calls, [])
})
