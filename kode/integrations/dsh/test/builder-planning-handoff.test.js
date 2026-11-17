import test from 'node:test'
import assert from 'node:assert/strict'
import { readHandoffScope, prepareHandoff, confirmHandoff, verifyHandoff, pendingHandoff, validHandoffReceipt, handoffKey, handoffError, planningSelection } from '../packages/collab/builder-planning-handoff.js'
import { resolveDefaultSelection } from '../src/model-alias.js'

// Fixture data only: no Hub, no model, no Session. The storage keeps createOutboxStorage's save/reserve contract.
const draft = { id: 'draft-1', home_hub: 'hub', revision: 4 }
const scope = { home_hub: 'hub', draft_id: 'draft-1', session_id: 'source', context_epoch: 2, draft_revision: 4, context_sha256: 'c'.repeat(64), state: 'active' }
const prepared = { action: 'handoff', sessionId: 'source', profileId: 'kode-frontend', selection: { model: 'opus-5.5', reasoningEffort: 'high' },
  planning: { draft_id: 'draft-1', source_epoch: 2, draft_revision: 4, source_context_sha256: 'c'.repeat(64), target_profile_revision: 'f'.repeat(64) } }
const receipt = (extra = {}) => ({ version: 1, mode: 'interactive_planning', kind: 'planning', state: 'ready', home_hub: 'hub', draft_id: 'draft-1', session_id: 'successor',
  context_epoch: 3, disposition: 'fresh', initial_selection: { provider: 'kode-agent-kode-frontend', model: 'opus-5.5', reasoningEffort: 'high' }, source_session_id: 'source', source_epoch: 2, request_id: 'req-1', automatic_input: false, execution_authorized: false, ...extra })
const memory = () => { const rows = new Map(); return { rows, read: async key => structuredClone(rows.get(key) ?? null),
  save: async (key, value) => { if (rows.get(key)?.request_id !== value.request_id) throw Error('Request changed'); rows.set(key, structuredClone(value)) },
  reserve: async (key, value, replace) => { const current = rows.get(key); if (!(current && current.state !== 'accepted' && !replace?.(current))) rows.set(key, structuredClone(value)); return structuredClone(rows.get(key)) } } }
const recorder = reply => { const calls = []; const request = async (path, options = {}) => { calls.push({ path, ...options }); return reply(path, options, calls.length) }; return { calls, request } }
const key = handoffKey(draft, 'source')

test('the handoff scope is read from agent-hub GET, must name this draft and source, and offers only a matching retry_command', async () => {
  const { calls, request } = recorder(() => ({ planning_handoff: null }))
  assert.equal(await readHandoffScope({ draft, sessionId: 'source', request }), null)
  assert.deepEqual(calls.map(row => [row.path, row.method ?? 'GET', row.body]), [['/api/kode/agent-hub?session_id=source', 'GET', undefined]])
  for (const patch of [{ draft_id: 'other' }, { home_hub: 'other' }, { session_id: 'other' }, { context_epoch: 0 }, { context_sha256: '' }, { state: 'done' }])
    await assert.rejects(readHandoffScope({ draft, sessionId: 'source', request: async () => ({ planning_handoff: { ...scope, ...patch } }) }), error => error.code === 'handoff_scope_mismatch', JSON.stringify(patch))
  const retry = { ...prepared, requestId: 'kept' }
  const read = pending => readHandoffScope({ draft, sessionId: 'source', request: async () => ({ planning_handoff: { ...scope, state: 'handoff_pending', pending } }) })
  assert.deepEqual((await read({ request_id: 'kept', reserved_session_id: 'successor', retry_command: retry })).retry, retry)
  assert.equal((await read({ request_id: 'other', retry_command: retry })).retry, null, 'retry_command must be the pending request')
  assert.equal((await read({ request_id: 'kept', retry_command: { ...retry, sessionId: 'elsewhere' } })).retry, null, 'another source is never resent')
})

test('prepare is a read-only POST and must return exactly the chosen target for the current context', async () => {
  const { calls, request } = recorder(() => ({ kind: 'planning', prepared, automatic_input: false, execution_authorized: false }))
  assert.deepEqual(await prepareHandoff({ scope, choice: { profileId: 'kode-frontend', model: 'opus-5.5', reasoningEffort: 'high' }, request }), prepared)
  assert.deepEqual(calls[0].body, { action: 'prepare-handoff', sessionId: 'source', profileId: 'kode-frontend', selection: { model: 'opus-5.5', reasoningEffort: 'high' } })
  const choice = { profileId: 'kode-frontend', model: 'opus-5.5' }
  const variants = [{ kind: 'session' }, { automatic_input: true }, { execution_authorized: true }, { prepared: { ...prepared, requestId: 'x' } }, { prepared: { ...prepared, action: 'select' } },
    { prepared: { ...prepared, sessionId: 'other' } }, { prepared: { ...prepared, profileId: 'claude' } }, { prepared: { ...prepared, selection: { model: 'other' } } },
    { prepared: { ...prepared, planning: { ...prepared.planning, source_epoch: 1 } } }, { prepared: { ...prepared, planning: { ...prepared.planning, draft_revision: 3 } } },
    { prepared: { ...prepared, planning: { ...prepared.planning, source_context_sha256: 'd'.repeat(64) } } }, { prepared: { ...prepared, planning: { ...prepared.planning, draft_id: 'other' } } }]
  for (const patch of [...variants, { prepared: { ...prepared, planning: { ...prepared.planning, target_profile_revision: 7 } } }, { prepared: { ...prepared, planning: { ...prepared.planning, target_profile_revision: 'F'.repeat(64) } } },
    { prepared: { ...prepared, planning: { ...prepared.planning, target_profile_revision: 'f'.repeat(63) } } }, { prepared: { ...prepared, selection: null } }])
    await assert.rejects(prepareHandoff({ scope, choice, request: async () => ({ kind: 'planning', prepared, automatic_input: false, execution_authorized: false, ...patch }) }), error => error.code === 'handoff_prepare_mismatch', JSON.stringify(patch))
  // Every explicitly requested field must come back unchanged: effort and Fast, not only the model.
  const explicit = { profileId: 'kode-frontend', model: 'opus-5.5', reasoningEffort: 'high', fast: true }
  const reply = selection => async () => ({ kind: 'planning', automatic_input: false, execution_authorized: false, prepared: { ...prepared, selection } })
  const fast = recorder(reply({ model: 'opus-5.5', reasoningEffort: 'high', fast: true }))
  assert.deepEqual((await prepareHandoff({ scope, choice: explicit, request: fast.request })).selection, { model: 'opus-5.5', reasoningEffort: 'high', fast: true })
  assert.deepEqual(fast.calls[0].body.selection, { model: 'opus-5.5', reasoningEffort: 'high', fast: true })
  assert.deepEqual((await prepareHandoff({ scope, choice: { ...explicit, fast: false }, request: reply({ model: 'opus-5.5', reasoningEffort: 'high', fast: false }) })).selection.fast, false)
  for (const selection of [{ model: 'opus-5.5', reasoningEffort: 'low', fast: false }, { model: 'opus-5.5', reasoningEffort: 'low', fast: true }, { model: 'opus-5.5', reasoningEffort: 'high', fast: false },
    { model: 'opus-5.5', reasoningEffort: 'high' }, { model: 'opus-5.5', fast: true }, { model: 'sonnet-5.5', reasoningEffort: 'high', fast: true }])
    await assert.rejects(prepareHandoff({ scope, choice: explicit, request: reply(selection) }), error => error.code === 'handoff_prepare_mismatch', JSON.stringify(selection))
})

test('a model-variant Fast pair uses the native conversion, so prepare and receipt match the server-resolved selection exactly', async () => {
  // Same shape withModelVariantFast advertises; the stub server resolves exactly as prepareNativeHandoff does.
  const capability = defaultEnabled => ({ transport: 'model-variant', defaultEnabled, fastModelId: 'gpt-x-fast', standardModelId: 'gpt-x' })
  const models = [{ id: 'gpt-x', reasoningEfforts: [{ id: 'low' }, { id: 'xhigh' }], defaultReasoningEffort: 'low', fastCapability: capability(false) },
    { id: 'gpt-x-fast', reasoningEfforts: [{ id: 'low' }], defaultReasoningEffort: 'low', fastCapability: capability(true) }]
  const on = planningSelection(models, { model: 'gpt-x', reasoningEffort: 'low', fast: true }), off = planningSelection(models, { model: 'gpt-x-fast', reasoningEffort: 'low', fast: false })
  assert.deepEqual(on, { model: 'gpt-x-fast', reasoningEffort: 'low', fast: true })
  assert.deepEqual(off, { model: 'gpt-x', reasoningEffort: 'low', fast: false })
  assert.deepEqual(planningSelection(models, { model: 'gpt-x', reasoningEffort: 'xhigh', fast: true }), on, 'an effort the fast variant does not offer falls back to its default')
  assert.deepEqual(planningSelection(models, { model: 'gpt-x', reasoningEffort: 'xhigh' }), { model: 'gpt-x', reasoningEffort: 'xhigh', fast: false })
  assert.equal(planningSelection(models, { model: 'unadvertised', fast: true }), null)
  const server = recorder((path, { body }) => ({ kind: 'planning', automatic_input: false, execution_authorized: false,
    prepared: { ...prepared, profileId: body.profileId, selection: resolveDefaultSelection(models, body.selection) } }))
  for (const canonical of [on, off]) {
    const result = await prepareHandoff({ scope, choice: { profileId: 'kode-frontend', ...canonical }, request: server.request })
    assert.deepEqual(server.calls.at(-1).body.selection, canonical)
    assert.deepEqual(result.selection, canonical)
    const command = { ...result, requestId: 'req-1' }
    assert.equal(validHandoffReceipt(receipt({ initial_selection: { provider: 'kode-agent-kode-frontend', ...canonical } }), command, draft), true)
    const other = canonical.fast ? { model: 'gpt-x', reasoningEffort: 'low', fast: true } : { model: 'gpt-x-fast', reasoningEffort: 'low', fast: false }
    assert.equal(validHandoffReceipt(receipt({ initial_selection: { provider: 'kode-agent-kode-frontend', ...other } }), command, draft), false, 'the receipt stays exact')
  }
  // The raw standard model with Fast on (or the fast model with Fast off) is what the server renames: refused, never relaxed.
  for (const raw of [{ model: 'gpt-x', reasoningEffort: 'low', fast: true }, { model: 'gpt-x-fast', reasoningEffort: 'low', fast: false }])
    await assert.rejects(prepareHandoff({ scope, choice: { profileId: 'kode-frontend', ...raw }, request: server.request }), error => error.code === 'handoff_prepare_mismatch', JSON.stringify(raw))
})

test('confirm stores the full prepared command with one request id before its single POST; only the exact successor receipt is accepted', async () => {
  const storage = memory(), seen = []
  const { calls, request } = recorder((path, { body }) => { seen.push(structuredClone(storage.rows.get(key))); return receipt() })
  assert.equal((await confirmHandoff({ storage, draft, prepared, uuid: () => 'req-1', request })).session_id, 'successor')
  assert.deepEqual(calls.map(row => [row.path, row.method, row.body]), [['/api/kode/agent-hub', 'POST', { ...prepared, requestId: 'req-1' }]])
  assert.deepEqual(seen[0], { request_id: 'req-1', state: 'sent', command: { ...prepared, requestId: 'req-1' } }, 'persisted before the POST')
  assert.equal(storage.rows.get(key).state, 'accepted')
  const command = { ...prepared, requestId: 'req-1' }
  assert.equal(validHandoffReceipt(receipt(), command, draft), true)
  assert.equal(validHandoffReceipt(receipt({ disposition: 'recovered' }), command, draft), true)
  // A Fast command needs the same Fast on the successor route.
  const fastCommand = { ...command, selection: { ...command.selection, fast: false } }
  assert.equal(validHandoffReceipt(receipt({ initial_selection: { provider: 'kode-agent-kode-frontend', model: 'opus-5.5', reasoningEffort: 'high', fast: false } }), fastCommand, draft), true)
  assert.equal(validHandoffReceipt(receipt(), fastCommand, draft), false, 'Fast dropped')
  assert.equal(validHandoffReceipt(receipt({ initial_selection: { provider: 'kode-agent-kode-frontend', model: 'opus-5.5', reasoningEffort: 'high', fast: true } }), fastCommand, draft), false, 'Fast flipped')
  for (const patch of [{ source_session_id: 'other' }, { draft_id: 'other' }, { home_hub: 'other' }, { context_epoch: 2 }, { context_epoch: 4 }, { source_epoch: 1 }, { request_id: 'req-2' },
    { session_id: 'source' }, { session_id: '' }, { kind: undefined },
    { initial_selection: { provider: 'WRONG', model: 'opus-5.5', reasoningEffort: 'high' } }, { initial_selection: { provider: 'kode-agent-claude', model: 'opus-5.5', reasoningEffort: 'high' } },
    { initial_selection: { provider: 'kode-agent-kode-frontend', model: 'WRONG', reasoningEffort: 'high' } }, { initial_selection: { provider: 'kode-agent-kode-frontend', model: 'opus-5.5', reasoningEffort: 'low' } },
    { initial_selection: { provider: 'kode-agent-kode-frontend', model: 'opus-5.5' } }, { initial_selection: { provider: 'kode-agent-kode-frontend', model: 'opus-5.5', reasoningEffort: 'high', fast: true } },
    { initial_selection: { model: 'opus-5.5', reasoningEffort: 'high' } }, { state: 'uncertain' }, { automatic_input: true }, { execution_authorized: true }, { initial_selection: null }, { version: 2 }, { mode: 'team_execution' }])
    assert.equal(validHandoffReceipt(receipt(patch), command, draft), false, JSON.stringify(patch))
})

test('an unknown outcome, a 409 or a mismatched receipt keeps the original; a new confirm never posts and verify resends it verbatim', async () => {
  for (const failure of [() => { throw Object.assign(Error('lost'), {}) }, () => { throw Object.assign(Error('refused'), { status: 409, code: 'PLANNING_HANDOFF_CONFLICT' }) }, () => receipt({ source_session_id: 'other' }), () => receipt({ context_epoch: 2 })]) {
    const storage = memory()
    const { calls, request } = recorder(failure)
    await assert.rejects(confirmHandoff({ storage, draft, prepared, uuid: () => 'req-1', request }))
    const kept = structuredClone(storage.rows.get(key)); assert.equal(kept.state, 'sent'); assert.deepEqual(kept.command, { ...prepared, requestId: 'req-1' })
    await assert.rejects(confirmHandoff({ storage, draft, prepared: { ...prepared, profileId: 'claude' }, uuid: () => 'req-2', request }), error => error.code === 'handoff_previous_unconfirmed')
    assert.equal(calls.length, 1, 'no new command is posted'); assert.deepEqual(storage.rows.get(key), kept)
    assert.deepEqual(await pendingHandoff(storage, draft, 'source'), kept)
    const verify = recorder(() => receipt({ disposition: 'recovered' }))
    assert.equal((await verifyHandoff({ storage, draft, sessionId: 'source', request: verify.request })).session_id, 'successor')
    assert.deepEqual(verify.calls.map(row => row.body), [kept.command])
  }
})

test('without a local record only the server retry_command is reconciled; storage failures never post', async () => {
  const storage = memory(), retry = { ...prepared, requestId: 'server-kept' }
  const { calls, request } = recorder(() => receipt({ request_id: 'server-kept', disposition: 'recovered' }))
  await verifyHandoff({ storage, draft, sessionId: 'source', retry, request })
  assert.deepEqual(calls.map(row => row.body), [retry])
  await assert.rejects(verifyHandoff({ storage: memory(), draft, sessionId: 'source', retry: { ...retry, sessionId: 'elsewhere' }, request }), error => error.code === 'handoff_previous_unreadable')
  await assert.rejects(verifyHandoff({ storage: memory(), draft, sessionId: 'source', retry: null, request }), error => error.code === 'handoff_previous_unreadable')
  assert.equal(calls.length, 1)
  const broken = { ...memory(), reserve: async () => { throw Error('quota') } }
  await assert.rejects(confirmHandoff({ storage: broken, draft, prepared, uuid: () => 'x', request }), error => error.code === 'handoff_storage_failed' && error.reserved === false)
  const unmarked = memory(); unmarked.save = async () => { throw Error('quota') }
  await assert.rejects(confirmHandoff({ storage: unmarked, draft, prepared, uuid: () => 'y', request }), error => error.code === 'handoff_storage_failed' && error.reserved === true)
  assert.equal(unmarked.rows.get(key).state, 'prepared'); assert.equal(calls.length, 1, 'nothing posted without a stored, marked command')
  assert.match(handoffError({ code: 'handoff_storage_failed', reserved: false }), /没有发送请求/)
  assert.match(handoffError(Error('lost'), 'send'), /原请求已保存在本机[\s\S]*不会自动重试/)
})

test('latest-draft preparation is explicit and verifies both old and new frozen contexts', async () => {
 const latest={...scope,draft_revision:5,source_draft_revision:4,latest_context_sha256:'e'.repeat(64)}
 const next={...prepared,planning:{...prepared.planning,draft_revision:5,refresh_context:{source_draft_revision:4,target_context_sha256:'e'.repeat(64)}}}
 const reply={kind:'planning',prepared:next,automatic_input:false,execution_authorized:false}
 const choice={profileId:prepared.profileId,...prepared.selection}
 const {calls,request}=recorder(()=>reply)
 assert.deepEqual(await prepareHandoff({scope:latest,choice,refreshContext:true,request}),next)
 assert.equal(calls[0].body.refreshContext,true)
 await assert.rejects(prepareHandoff({scope:latest,choice,request}),{code:'handoff_prepare_mismatch'})
 for(const refresh_context of [undefined,{source_draft_revision:3,target_context_sha256:'e'.repeat(64)},{source_draft_revision:4,target_context_sha256:'0'.repeat(64)}])
  await assert.rejects(prepareHandoff({scope:latest,choice,refreshContext:true,request:async()=>({...reply,prepared:{...next,planning:{...next.planning,refresh_context}}})}),{code:'handoff_prepare_mismatch'})
})
