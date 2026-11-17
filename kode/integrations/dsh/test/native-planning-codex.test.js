import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILDER_PLANNING_PROMPT } from '../src/builder-planning-prompt.js'
import { CodexSession } from '../src/codex-session.js'
test('planning preserves original native project and approval settings without automatic peer instructions', async () => {
  for (const planning of [true, false]) {
    const calls = [], s = new CodexSession({ defaultModel: 'native-model' }, '/fixture/project', {
      nativePlanning: planning, policy: () => ({ mode: 'workspace-write' }), approvalPolicy: () => 'ask',
    })
    s.initialize = async () => {}; s.readQuota = async () => {}
    s.rpc = { request: async (method, params) => { calls.push({ method, params }); return { thread: { id: 'new-thread' } } } }
    await s.open({}, [])
    const start = calls.find(c => c.method === 'thread/start').params
    assert.equal(start.cwd, '/fixture/project'); assert.equal(start.approvalPolicy, 'on-request')
    assert.equal(start.sandbox, 'workspace-write'); assert.equal(start.model, 'native-model')
    assert.equal(Object.hasOwn(start, 'baseInstructions'), false)
    if (planning) { assert.equal(start.developerInstructions, BUILDER_PLANNING_PROMPT); assert.doesNotMatch(start.developerInstructions, /shared session directory/) }
    else assert.match(start.developerInstructions, /shared session directory/)
  }
})
