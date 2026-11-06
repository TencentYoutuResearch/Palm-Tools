import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { CodexSession } from '../src/codex-session.js'
import { codexReroutedSelection } from '../src/native-selection.js'
const identity = { threadId: 'thread', turnId: 'turn', model: 'chosen', effort: 'high' }
test('reroute observations require exact turn identity and never infer missing effort', () => {
  for (const params of [{ threadId: 'thread' }, { threadId: 'other', turnId: 'turn' }, { threadId: 'thread', turnId: 'old' }]) assert.equal(codexReroutedSelection({ ...params, toModel: 'other' }, identity), null)
  const mismatch = codexReroutedSelection({ threadId: 'thread', turnId: 'turn', toModel: 'other' }, identity)
  assert.equal(mismatch.model.status, 'mismatch'); assert.equal(mismatch.admission, 'rejected')
  assert.equal(mismatch.effort.observed, null); assert.equal(mismatch.effort.status, 'unverifiable')
  for (const toModel of [null, '', 'x'.repeat(257), 'bad\nmodel']) {
    const unknown = codexReroutedSelection({ threadId: 'thread', turnId: 'turn', toModel }, identity)
    assert.equal(unknown.model.observed, null); assert.equal(unknown.model.status, 'unverifiable'); assert.equal(unknown.admission, undefined)
  }
  const defaults = codexReroutedSelection({ threadId: 'thread', turnId: 'turn', toModel: 'chosen' }, { ...identity, model: 'default' })
  assert.equal(defaults.model.requested, null); assert.equal(defaults.model.status, 'reported')
})
test('real Codex fixture ignores foreign routing events and emits current-turn mismatch', async () => {
  const session = new CodexSession({ executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_SELECTION_REROUTE: '1' } }, process.cwd())
  try {
    await session.open({}, [], AbortSignal.timeout(3000))
    const run = async text => { const rows = []; for await (const event of session.turn([{ type: 'text', text }], { model: 'fixture', effort: 'high', signal: AbortSignal.timeout(3000) })) if (event.method === 'kode/selection_evidence') rows.push(event.params); return rows }
    const first = await run('foreign only')
    assert.equal(first.length, 1); assert.equal(first[0].model.status, 'acknowledged')
    const second = await run('CURRENT_REROUTE')
    assert.equal(second.length, 2); assert.equal(second[1].model.observed, 'other')
    assert.equal(second[1].turnId, second[0].turnId); assert.notEqual(second[1].turnId, first[0].turnId)
    assert.equal(second[1].admission, 'rejected'); assert.equal(second[1].scope, 'executor_configuration')
  } finally { await session.close() }
})
