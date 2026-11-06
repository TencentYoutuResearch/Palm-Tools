import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkRunService } from '../src/work-run-service.js'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kode-run-service-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runs = new Map(['a', 'b', 'c'].map(id => [id, { id, team_id: 'team', home_hub: 'home', revision: 1, state: 'running' }]))
  const calls = [], starts = [], callbacks = new Map()
  let accountingBlocked = false, accountingFailure = null
  const accounting = run => { if (accountingFailure) throw accountingFailure
    return { home_hub: 'home', run_id: run.id, team_id: run.team_id, run_revision: run.revision,
    authority: 'home_accounting_observation', read_only: true, blocked: accountingBlocked,
    state: accountingBlocked ? 'waiting_accounting' : 'no_usage_blocker',
    reason: accountingBlocked ? 'usage_reconciliation_required' : null,
    recovery: accountingBlocked ? 'blocked_until_trusted_usage_is_reconciled' : null,
    retry_allowed: false, unresolved_calls: accountingBlocked ? [{ operation_id: 'op', attempt: 1, epoch: 1, assignment_id: 'assignment', stage_id: 'build', call_id: 'call', state: 'finished', accounting_status: 'usage_unresolved', budget: { reservation_id: 'reservation', unit: 'credits', held: 8, charged: 2, finalized: false, frozen: true } }] : [], truncated: false } }
  const controller = { watches: new Map(), runtime: { host: 'home', profiles: { path: join(dir, 'profiles.json') }, client: {
    async call(path) {
      calls.push(path)
      if (path.includes('/active')) {
        const after = new URL(path, 'http://fixture.invalid').searchParams.get('after')
        return { items: [...runs.values()].filter(r => !after || r.id > after).map(r => ({ ...r })), next_cursor: null }
      }
      if (path.endsWith('/accounting-status')) return accounting(runs.get(path.split('/').at(-2)))
      return { ...runs.get(path.split('/').at(-1)) }
    },
  } }, watch(id, { onState, once }) { starts.push(id); const lease = {}; this.watches.set(id, lease); callbacks.set(id, async result => {
    try { await onState(result) } finally { if (once && this.watches.get(id) === lease) this.watches.delete(id) }
  }) },
  unwatch(id) { this.watches.delete(id) }, async close() { this.watches.clear() } }
  const service = await new WorkRunService(controller, { intervalMs: 100, ...options }).open()
  t.after(() => service.close())
  return { service, controller, runs, calls, starts, callbacks, setAccountingBlocked(value) { accountingBlocked = value }, setAccountingFailure(value) { accountingFailure = value } }
}

test('known Home usage blocker becomes a durable waiting-accounting fence and does not blind-retry after reopen', async t => {
  const f = await fixture(t, { maxWatches: 1 })
  await f.service.scan()
  f.setAccountingBlocked(true)
  await f.callbacks.get('a')({ state: 'progression_failed', error: new Error('generic begin refused') })
  assert.equal(f.service.rows.a.state, 'waiting_accounting')
  assert.equal(f.service.rows.a.blocked, true)
  assert.equal(f.controller.watches.has('a'), false)
  await f.service.close()
  const restored = await new WorkRunService(f.controller, { intervalMs: 100, maxWatches: 1 }).open()
  t.after(() => restored.close())
  await restored.scan()
  assert.deepEqual(f.starts, ['a', 'b'], 'same revision blocker stays fenced while another run remains discoverable after Host restart')
  await assert.rejects(restored.retry('a'), /usage reconciliation required; retry is not authorized/)
  assert.equal(f.controller.watches.has('a'), false)
})

for (const [failureLabel, makeFailure] of [
  ['403', () => Object.assign(new Error('forbidden'), { status: 403 })],
  ['network', () => new Error('fixture network failure')],
]) test(`failed Home accounting read (${failureLabel}) is not misreported as definite missing usage and leaves other runs available`, async t => {
  const f = await fixture(t, { maxWatches: 2 })
  await f.service.scan()
  f.setAccountingFailure(makeFailure())
  await f.callbacks.get('a')({ state: 'progression_failed', error: new Error('generic progression error') })
  assert.equal(f.service.rows.a.state, 'progression_failed')
  assert.equal(f.service.rows.a.blocked, true)
  assert.equal(f.service.stop.signal.aborted, false, 'one run accounting-read failure must not stop the whole Host service')
  f.setAccountingFailure(null)
  await f.service.scan()
  assert.ok(f.controller.watches.has('c'), 'unrelated run remains discoverable/progressable')
  assert.notEqual(f.service.rows.a.state, 'waiting_accounting', 'transport/authorization failure is not proof of usage_unresolved')
})

test('service bounds watches and durably fences recovery across restart until explicit retry', async t => {
  const f = await fixture(t, { maxWatches: 1 })
  await Promise.all([f.service.scan(), f.service.scan()])
  assert.deepEqual(f.starts, ['a']); assert.equal(f.calls.length, 1)
  await f.callbacks.get('a')({ state: 'recovery_required' })
  assert.equal(f.controller.watches.size, 0)
  await f.service.close()
  const restored = await new WorkRunService(f.controller, { intervalMs: 100, maxWatches: 1 }).open()
  t.after(() => restored.close())
  await restored.scan()
  assert.deepEqual(f.starts, ['a', 'b'], 'same revision recovery remains fenced after process reconstruction')
  f.controller.unwatch('b')
  await restored.retry('a')
  assert.deepEqual(f.starts, ['a', 'b', 'a'])
})

test('service follows discovery cursors and resumes a blocked run only after changed revision', async t => {
  const f = await fixture(t)
  let page = 0
  f.controller.runtime.client.call = async path => {
    f.calls.push(path)
    if (path.endsWith('/accounting-status')) return { home_hub: 'home', run_id: 'a', team_id: 'team', run_revision: 1,
      authority: 'home_accounting_observation', read_only: true, blocked: false, state: 'no_usage_blocker', reason: null,
      recovery: null, retry_allowed: false, unresolved_calls: [], truncated: false }
    if (!path.includes('/active')) return { ...f.runs.get('a') }
    return page++ === 0 ? { items: [f.runs.get('a')], next_cursor: 'a' } : { items: [f.runs.get('b')], next_cursor: null }
  }
  await f.service.scan(); await f.service.scan()
  assert.ok(f.calls[1].endsWith('/active?after=a'))
  await f.callbacks.get('a')({ state: 'waiting_adapter' })
  f.runs.get('a').revision++
  page = 0
  await f.service.scan()
  assert.deepEqual(f.starts, ['a', 'b', 'a'])
})

test('service refuses foreign discovery and closes watches when a recovery fence cannot be persisted', async t => {
  const f = await fixture(t)
  f.runs.get('a').home_hub = 'foreign'
  await assert.rejects(f.service.scan(), /identity mismatch/)
  assert.deepEqual(f.starts, [])
  f.runs.get('a').home_hub = 'home'
  await f.service.scan()
  f.service.record = async () => { throw new Error('disk unavailable') }
  await assert.rejects(f.callbacks.get('a')({ state: 'recovery_required' }), /disk unavailable/)
  await assert.rejects(f.service.scan(), /closed/)
  assert.equal(f.controller.watches.size, 0)
})

test('remote waiting yields its slot and legacy remote-wait fences recover without a run revision change', async t => {
  const f = await fixture(t, { maxWatches: 1 })
  await f.service.scan()
  await f.callbacks.get('a')({ state: 'waiting_remote_host' })
  assert.equal(f.controller.watches.has('a'), false)
  assert.equal(f.service.rows.a.blocked, false)
  await f.service.record('a', { revision: 1, state: 'waiting_remote_host', blocked: true })
  await f.service.close()
  const restored = await new WorkRunService(f.controller, { intervalMs: 100, maxWatches: 1 }).open()
  t.after(() => restored.close())
  await restored.scan()
  assert.deepEqual(f.starts, ['a', 'a'])
  await f.callbacks.get('a')({ state: 'waiting_remote_report' })
  assert.equal(f.controller.watches.has('a'), false)
  await f.callbacks.get('a')({ state: 'recovery_required' })
  assert.equal(f.controller.watches.has('a'), false)
})

test('pending cancellation yields its slot and is rediscovered after service reopen', async t => {
  const f = await fixture(t, { maxWatches: 1 })
  f.runs.get('a').state = 'cancelling'
  await f.service.scan()
  await f.callbacks.get('a')({ state: 'progression_failed' })
  assert.equal(f.service.rows.a.blocked, true)
  await f.service.close()
  const restored = await new WorkRunService(f.controller, { intervalMs: 100, maxWatches: 1 }).open()
  t.after(() => restored.close())
  await restored.scan()
  assert.deepEqual(f.starts, ['a', 'a'])
  await f.callbacks.get('a')({ state: 'cancel_unconfirmed' })
  assert.equal(restored.rows.a.blocked, false)
  assert.equal(f.controller.watches.has('a'), false)
})


test('waiting runs yield bounded slots and partial discovery pages never skip later teams', async t => {
  const f = await fixture(t, { maxWatches: 1 })
  for (const row of f.runs.values()) row.team_id = `team-${row.id}`
  let writes = 0
  const record = f.service.record.bind(f.service)
  f.service.record = (...args) => { writes++; return record(...args) }
  for (let i = 0; i < 9; i++) {
    await f.service.scan()
    assert.equal(f.controller.watches.size, 1)
    const id = [...f.controller.watches.keys()][0]
    await f.callbacks.get(id)({ state: 'waiting_remote_host' })
    assert.equal(f.controller.watches.size, 0)
  }
  assert.deepEqual(f.starts, ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c'])
  assert.equal(writes, 6, 'unchanged waiting state is not rewritten on each monitoring lease')
  assert.equal(f.service.rows.a.blocked, false)
})

test('human acceptance remains fenced after Host reconstruction and accepted revision resumes without manual retry', async t => {
  const f = await fixture(t, { maxWatches: 1 })
  const run = f.runs.get('a')
  run.state = 'waiting_user'; run.waiting_reason = 'human_delivery_acceptance_required'
  await f.service.scan()
  await f.callbacks.get('a')({ state: 'waiting_user' })
  await assert.rejects(f.service.retry('a'), /Hub state transition/)
  await f.service.close()
  const restored = await new WorkRunService(f.controller, { intervalMs: 100, maxWatches: 1 }).open()
  t.after(() => restored.close())
  f.runs.delete('b'); f.runs.delete('c')
  await restored.scan()
  assert.deepEqual(f.starts, ['a'], 'pending owner decision must not restart work')
  run.revision++; run.state = 'queued'; run.waiting_reason = 'delivery_finalization_pending'
  await restored.scan()
  assert.deepEqual(f.starts, ['a', 'a'], 'exact accepted Hub revision reopens progression automatically')
})
