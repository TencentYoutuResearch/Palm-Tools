import test from 'node:test'
import assert from 'node:assert/strict'
import { readPlanning, pendingPlanning, startPlanning, verifyPlanning, retryPlanning, completePlanning, confirmPlanning, validPlanning, planningError, planningDiagnostic, openPlanningSession, planningRequestKey } from '../packages/collab/builder-planning.js'

const draft = { id: 'draft-1', home_hub: 'hub', revision: 3 }
const receipt = (extra = {}) => ({ version: 1, state: 'ready', mode: 'interactive_planning', home_hub: 'hub', draft_id: 'draft-1', context_epoch: 1,
  session_id: 'native-session', workspace_id: 'project', cwd: '/fixture/kode', disposition: 'fresh', execution_authorized: false, ...extra })
// Same contract as createOutboxStorage: save only rewrites the same request id; reserve atomically places or keeps.
const memory = () => { const rows = new Map(); return { rows, read: async key => structuredClone(rows.get(key) ?? null),
  save: async (key, value) => { if (rows.get(key)?.request_id !== value.request_id) throw Error('Request changed'); rows.set(key, structuredClone(value)) },
  reserve: async (key, value, replace) => { const current = rows.get(key); if (!(current && current.state !== 'accepted' && !replace?.(current))) rows.set(key, structuredClone(value)); return structuredClone(rows.get(key)) } } }
const respond = (status, body) => async () => ({ ok: status < 300, status, json: async () => body })
const rejected = (status, code) => Object.assign(Error('rejected'), { status, code })

test('planning receipts must be the exact non-executing native Session contract', () => {
  assert.equal(validPlanning(receipt(), draft), true)
  assert.equal(validPlanning(receipt({ disposition: 'recovered', initial_selection: { model: 'x' } }), draft), true)
  for (const patch of [{ execution_authorized: true }, { draft_id: 'other' }, { home_hub: 'other' }, { mode: 'team_execution' }, { session_id: '' }, { disposition: 'adopted' }, { context_epoch: 0 }, { context_epoch: -1 }, { context_epoch: 1.5 }, { context_epoch: '2' }, { context_epoch: undefined }, { state: 'uncertain' }])
    assert.equal(validPlanning(receipt(patch), draft), false, JSON.stringify(patch))
  // A successor planning Session (after a handoff) carries a later epoch.
  assert.equal(validPlanning(receipt({ context_epoch: 2 }), draft), true)
})

test('GET separates not_created, ready, uncertain and an undeployed endpoint', async () => {
  assert.deepEqual(await readPlanning(draft, { fetcher: respond(200, { version: 1, mode: 'interactive_planning', state: 'not_created', home_hub: 'hub', draft_id: 'draft-1', execution_authorized: false }) }), { state: 'not_created' })
  assert.equal((await readPlanning(draft, { fetcher: respond(200, receipt({ disposition: 'recovered' })) })).value.session_id, 'native-session')
  const original = { draft_id: 'draft-1', draft_revision: 2, request_id: 'orig-1', profile_id: 'codex', model: 'gpt-6.1-sol' }
  const uncertain = await readPlanning(draft, { fetcher: respond(200, receipt({ state: 'uncertain', disposition: 'recovered', retry_request: original })) })
  assert.equal(uncertain.state, 'uncertain'); assert.deepEqual(uncertain.retry, original)
  const bare = await readPlanning(draft, { fetcher: respond(200, receipt({ state: 'uncertain', disposition: 'recovered' })) })
  assert.equal(bare.state, 'uncertain'); assert.equal('retry' in bare, false)
  await assert.rejects(readPlanning(draft, { fetcher: respond(200, receipt({ execution_authorized: true })) }))
  await assert.rejects(readPlanning(draft, { fetcher: respond(200, { state: 'not_created', home_hub: 'hub', draft_id: 'other', execution_authorized: false }) }))
  await assert.rejects(readPlanning(draft, { fetcher: respond(200, { state: 'unbound', home_hub: 'hub', draft_id: 'draft-1' }) }))
  await assert.rejects(readPlanning(draft, { fetcher: respond(404, {}) }), error => error.code === 'planning_unavailable')
  await assert.rejects(readPlanning(draft, { fetcher: respond(409, { code: 'CONTROLLED_BUILDER_CONFLICT' }) }), error => error.code === 'CONTROLLED_BUILDER_CONFLICT')
})

test('start keeps one request id across unknown outcomes and never sends a browser session id', async () => {
  const storage = memory(), commands = []
  let outcome = 'lost'
  const request = async command => { commands.push(command); if (outcome === 'lost') throw Error('network'); if (outcome === 'unconfirmed') throw rejected(409, 'PLANNING_NOT_CONFIRMED'); return receipt() }
  const choice = { profileId: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
  await assert.rejects(startPlanning({ storage, draft, choice, workspaceId: 'project', request, uuid: () => 'id-1' }))
  outcome = 'unconfirmed'
  await assert.rejects(startPlanning({ storage, draft, choice, workspaceId: 'project', request, uuid: () => 'id-2' }))
  outcome = 'ok'
  const value = await startPlanning({ storage, draft, choice, workspaceId: 'project', request, uuid: () => 'id-3' })
  assert.equal(value.session_id, 'native-session')
  assert.deepEqual(commands.map(row => row.request_id), ['id-1', 'id-1', 'id-1'])
  assert.deepEqual(commands[0], { draft_id: 'draft-1', draft_revision: 3, request_id: 'id-1', profile_id: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'medium', workspace_id: 'project' })
  assert.ok(commands.every(row => !('session_id' in row) && !('budget' in row) && !('grant' in row)))
  assert.equal(storage.rows.get(planningRequestKey(draft)).state, 'accepted')
})

test('a timed-out start freezes the full command: changed pickers, reload and mismatch all resend it unchanged', async () => {
  const storage = memory(), sent = []
  let reply = async () => { throw Object.assign(Error('timeout'), { name: 'AbortError' }) }
  const request = async command => { sent.push(command); return reply() }
  const original = { profileId: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
  await assert.rejects(startPlanning({ storage, draft, choice: original, workspaceId: 'project', request, uuid: () => 'first' }))
  const pending = await pendingPlanning(storage, draft)
  assert.equal(pending.command.request_id, 'first'); assert.equal(pending.command.profile_id, 'codex')
  // The user switched Agent/model and the page reloaded (fresh storage reader, same rows).
  const reloaded = { read: storage.read, save: storage.save, reserve: storage.reserve }
  reply = async () => receipt({ draft_id: 'someone-else' })
  await assert.rejects(startPlanning({ storage: reloaded, draft, choice: { profileId: 'tclaude', model: 'opus-5.5' }, workspaceId: 'other', request, uuid: () => 'second' }),
    error => error.code === 'planning_receipt_mismatch')
  assert.ok(await pendingPlanning(storage, draft), 'a mismatched receipt is not a refusal')
  reply = async () => receipt()
  await startPlanning({ storage: reloaded, draft, choice: { profileId: 'cursor', model: 'auto' }, request, uuid: () => 'third' })
  assert.equal(sent.length, 3)
  for (const command of sent) assert.deepEqual(command, sent[0])
  assert.equal(await pendingPlanning(storage, draft), null)
  // A newer draft revision does not prove the old start created nothing: it stays, blocks a new command, and only it is resent on verify.
  storage.rows.set(planningRequestKey(draft), { ...pending, state: 'sent' })
  const next = { ...draft, revision: 4 }
  assert.deepEqual(await pendingPlanning(storage, next), { ...pending, state: 'sent' })
  await assert.rejects(startPlanning({ storage, draft: next, choice: { profileId: 'cursor', model: 'auto' }, request, uuid: () => 'fourth' }), error => error.code === 'planning_previous_unconfirmed' && error.revision === 3)
  assert.equal(sent.length, 3, 'no new command was sent'); assert.deepEqual(storage.rows.get(planningRequestKey(draft)), { ...pending, state: 'sent' })
  assert.match(planningError({ code: 'planning_previous_unconfirmed', revision: 3 }), /草案第 3 版[\s\S]*没有发送任何请求[\s\S]*先核对原请求/)
  reply = async () => { throw rejected(409, 'DRAFT_REVISION_CHANGED') }
  await assert.rejects(verifyPlanning({ storage, draft: next, request }), error => error.code === 'DRAFT_REVISION_CHANGED')
  assert.deepEqual(sent.at(-1), sent[0], 'verify resends the original verbatim'); assert.equal(await pendingPlanning(storage, next), null, 'only a definite refusal frees the slot')
  storage.rows.set(planningRequestKey(draft), { state: 'sent' })
  assert.deepEqual(await pendingPlanning(storage, next), { unreadable: true }, 'an unresendable unconfirmed record blocks instead of being ignored')
})

test('only the backend-proven pre-creation 409 codes free the request id; every other refusal keeps the original', async () => {
  for (const code of ['DRAFT_REVISION_CHANGED', 'NATIVE_AGENT_UNAVAILABLE', 'PLANNING_WORKSPACE_REQUIRED']) {
    const storage = memory(), ids = []; let next = 0
    const request = async command => { ids.push(command.request_id); if (ids.length === 1) throw rejected(409, code); return receipt() }
    await assert.rejects(startPlanning({ storage, draft, request, uuid: () => 'r' + ++next }), error => error.code === code)
    assert.equal(storage.rows.get(planningRequestKey(draft)).state, 'failed', code)
    await startPlanning({ storage, draft, choice: { profileId: 'cursor', model: 'auto' }, request, uuid: () => 'r' + ++next })
    assert.deepEqual(ids, ['r1', 'r2'], code)
  }
  // May follow an earlier creation, or say nothing about it: the exact original stays and is the only thing resent.
  const kept = [[409, 'PLANNING_REGISTRY_CHANGED'], [409, 'PLANNING_IDENTITY_CHANGED'], [409, 'PLANNING_WORKSPACE_CHANGED'], [409, 'CONTROLLED_BUILDER_CONFLICT'],
    [409, 'PLANNING_RECONCILIATION_REQUIRED'], [409, 'SOMETHING_NEW'], [409, undefined], [403, undefined], [403, 'NATIVE_AGENT_UNAVAILABLE'], [400, undefined], [400, 'DRAFT_REVISION_CHANGED'], [500, undefined]]
  for (const [status, code] of kept) {
    const storage = memory(), sent = []; let next = 0
    const request = async command => { sent.push(command); throw rejected(status, code) }
    await assert.rejects(startPlanning({ storage, draft, choice: { profileId: 'codex', model: 'gpt-6.1-sol' }, request, uuid: () => 'r' + ++next }))
    const original = storage.rows.get(planningRequestKey(draft))
    assert.equal(original.state, 'sent', `${status} ${code}`)
    await assert.rejects(startPlanning({ storage, draft, choice: { profileId: 'cursor', model: 'auto' }, request, uuid: () => 'r' + ++next }))
    assert.deepEqual(sent.map(row => row.request_id), ['r1', 'r1'], `${status} ${code}: no new request`); assert.deepEqual(sent[1], sent[0])
    assert.deepEqual(storage.rows.get(planningRequestKey(draft)), original)
  }
  assert.match(planningError(rejected(403)), /原请求仍保留在本机[\s\S]*不会改发新请求/)
  assert.match(planningError(rejected(400)), /原请求仍保留在本机[\s\S]*只会重发同一请求/)
  assert.match(planningError(rejected(409, 'CONTROLLED_BUILDER_CONFLICT')), /旧版受控搭建会话.*不能自动切换/)
  assert.match(planningError(rejected(409, 'PLANNING_RECONCILIATION_REQUIRED')), /上次开始规划时没有收到确认.*没有重复创建会话/)
  assert.match(planningError(rejected(409, 'PLANNING_NOT_CONFIRMED')), /服务还没有确认这次创建。原请求已保存在本机.*不会重复创建会话/)
  assert.match(planningError({ code: 'planning_unavailable' }), /尚未部署/)
})

test('recovery resends the original request verbatim; reopening confirms without Agent or model', async () => {
  const sent = [], request = async command => { sent.push(command); return receipt({ disposition: 'recovered' }) }
  const original = { draft_id: 'draft-1', draft_revision: 2, request_id: 'orig-1', profile_id: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'high', workspace_id: 'project' }
  await retryPlanning({ draft, retry: original, request })
  await confirmPlanning({ draft, request, uuid: () => 'confirm-1' })
  assert.deepEqual(sent, [original, { draft_id: 'draft-1', draft_revision: 3, request_id: 'confirm-1' }])
  await assert.rejects(retryPlanning({ draft, retry: original, request: async () => receipt({ state: 'uncertain' }) }))
  await assert.rejects(confirmPlanning({ draft, request: async () => { throw rejected(409, 'PLANNING_IDENTITY_CHANGED') } }), error => error.code === 'PLANNING_IDENTITY_CHANGED')
})

test('completing the original Session sends retry_request verbatim plus complete_partial, touches no storage and accepts only that Session', async () => {
  const sent = [], original = { draft_id: 'draft-1', draft_revision: 2, request_id: 'orig-1', profile_id: 'codex', model: 'gpt-6.1-sol', reasoning_effort: 'high', workspace_id: 'project' }
  const frozen = structuredClone(original), bound = receipt({ state: 'uncertain' })
  const request = async command => { sent.push(command); return receipt({ disposition: 'recovered' }) }
  assert.equal((await completePlanning({ draft, binding: bound, retry: original, request })).session_id, 'native-session')
  assert.deepEqual(sent, [{ ...frozen, complete_partial: true }]); assert.deepEqual(original, frozen, 'the retry_request object is not mutated')
  await assert.rejects(completePlanning({ draft, binding: bound, retry: original, request: async () => receipt({ session_id: 'replacement' }) }), error => error.code === 'planning_receipt_mismatch')
  await assert.rejects(completePlanning({ draft, binding: bound, retry: original, request: async () => receipt({ state: 'uncertain' }) }), error => error.code === 'planning_receipt_mismatch')
  await assert.rejects(completePlanning({ draft, binding: bound, retry: original, request: async () => { throw rejected(409, 'PLANNING_NOT_CONFIRMED') } }), error => error.code === 'PLANNING_NOT_CONFIRMED')
  assert.equal(completePlanning.length, 1); assert.doesNotMatch(String(completePlanning), /storage/)
})

test('handoff opens the native Session and offers text to its own input without sending or replacing', async () => {
  globalThis.requestAnimationFrame ??= fn => setTimeout(fn, 0)
  const calls = [], input = { requestDraftInitialization: (binding, options) => { calls.push(['init', binding.sessionId, options]); return 'preserved' }, for: () => ({ focus: () => calls.push(['focus']) }) }
  const host = { sessions: { refresh: async () => calls.push(['refresh']), binding: id => ({ sessionId: id, ctx: { get: name => name === 'conversation' ? { input } : null } }) },
    uiWorkspace: { openSession: async id => calls.push(['open', id]) }, selectMode: mode => calls.push(['mode', mode]) }
  assert.equal(await openPlanningSession(host, 'native-session', '目标\n\n补充'), 'preserved')
  assert.deepEqual(calls, [['refresh'], ['open', 'native-session'], ['mode', 'session'], ['init', 'native-session', { prompt: '目标\n\n补充', whenDraftExists: 'keep' }]])
  assert.ok(!calls.some(([kind]) => kind === 'submit' || kind === 'focus'))
})

test('the failure diagnosis shows only a numeric HTTP status and an identifier-shaped code', () => {
  assert.equal(planningDiagnostic(rejected(409, 'PLANNING_NOT_CONFIRMED')), '诊断：HTTP 409 · PLANNING_NOT_CONFIRMED')
  assert.equal(planningDiagnostic(rejected(403)), '诊断：HTTP 403')
  assert.equal(planningDiagnostic(Error('fetch failed: secret-host:1234')), '诊断：未收到完整的 HTTP 响应')
  assert.equal(planningDiagnostic({ code: 'planning_storage_failed', reserved: false }), '诊断：未收到完整的 HTTP 响应 · planning_storage_failed')
  for (const bad of [{ status: '409', code: 'X' }, { status: 9000 }, { status: 409.5 }])
    assert.doesNotMatch(planningDiagnostic(bad), /HTTP \d/, JSON.stringify(bad))
  for (const code of ['<script>', 'a b', 'token=abc', 'x'.repeat(65), '{"body":1}'])
    assert.equal(planningDiagnostic(rejected(409, code)), '诊断：HTTP 409', code)
})
