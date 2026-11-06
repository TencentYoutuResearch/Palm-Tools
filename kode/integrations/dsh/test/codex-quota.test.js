import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { quotaObservation, quotaWindowState } from '../src/codex-quota.js'
import { CodexSession } from '../src/codex-session.js'

test('quota windows preserve unknowns, normalize seconds and do not infer replenishment', () => {
  const sample = quotaObservation({ secret: 'never-retained', rateLimitsByLimitId: {
    a: { primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: 2000 } },
    b: { primary: { usedPercent: '20', resetsAt: -1 }, secondary: { usedPercent: 10 } },
  } }, 1000000)
  assert.equal(sample.account_binding, 'unbound')
  assert.equal(sample.buckets.length, 2)
  const bucket = sample.buckets[0], window = bucket.windows[0]
  assert.equal(window.resets_at_ms, 2000000)
  assert.equal(window.reached, true)
  assert.equal(quotaWindowState(window, bucket, 1000001), 'reported')
  assert.equal(quotaWindowState(window, bucket, 1900000), 'stale')
  assert.equal(quotaWindowState(window, bucket, 2000000), 'reset_passed')
  assert.equal(sample.buckets[1].windows[0].used_percent, null)
  assert.equal(sample.buckets[1].windows[0].reached, null)
  assert.equal(quotaObservation({ rateLimits: null }).status, 'unavailable')
  assert.ok(!JSON.stringify(sample).includes('never-retained'))
})

test('Codex retains idle quota notifications and throttles explicit reads without starting a turn', async () => {
  const observations = []
  let received
  const updated = new Promise(resolve => { received = resolve })
  const session = new CodexSession({ executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))], env: { KODE_FIXTURE_QUOTA: '1' } }, process.cwd(), { quota: sample => { observations.push(sample); if (sample.status === 'reported') received() } })
  try {
    await session.open({}, [], AbortSignal.timeout(3000))
    await Promise.race([updated, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Missing idle quota update')), 2000); timer.unref() })])
    assert.equal(session.active, undefined)
    assert.equal(session.quota.buckets[0].windows[0].used_percent, 75)
    const last = session.quota
    assert.equal(await session.readQuota(), last)
    assert.equal(observations.length, 2)
  } finally { await session.close() }
})

test('an older read response cannot overwrite a notification or account invalidation', async () => {
  const session = new CodexSession({}, '.')
  session.initialize = async () => {}
  let resolve
  session.rpc = { request: () => new Promise(done => { resolve = done }) }
  const pending = session.readQuota()
  await Promise.resolve()
  session.quotaGeneration++
  session.observeQuota(null)
  resolve({ rateLimits: { primary: { usedPercent: 0 } } })
  assert.equal((await pending).status, 'unavailable')
})

test('incremental bucket updates retain other buckets without extending their validity', async () => {
  const { mergeQuotaObservation, quotaView } = await import('../src/codex-quota.js')
  const row = usedPercent => ({ primary: { usedPercent, resetsAt: 9000, windowDurationMins: 60 } })
  const first = quotaObservation({ rateLimitsByLimitId: { a: row(100), b: row(20) } }, 1000)
  const second = quotaObservation({ rateLimits: { limitId: 'b', ...row(30) } }, 500000)
  const merged = mergeQuotaObservation(first, second)
  const view = quotaView(merged, 901000)
  assert.equal(view.buckets.find(b => b.limit_id === 'a').windows[0].freshness, 'stale')
  assert.equal(view.buckets.find(b => b.limit_id === 'b').windows[0].freshness, 'reported')
  assert.equal(view.eligible_for_dispatch, false)
  assert.equal(first.buckets[1].windows[0].used_percent, 20, 'prior audit snapshots remain immutable')
  const late = mergeQuotaObservation(merged, first)
  assert.equal(late.buckets.find(b => b.limit_id === 'b').windows[0].used_percent, 30)
  assert.equal(mergeQuotaObservation(merged, quotaObservation(null)).buckets.length, 0)
})
