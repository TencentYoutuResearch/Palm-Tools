import assert from 'node:assert/strict'
import test from 'node:test'
import {
  batchCurrentStep,
  createLimiter,
  partitionTuiTargets,
  reorderAfterBatch,
  runPool,
  SnapshotPoller,
  targetActiveAfterBatch,
  type SwitchStep,
} from '../src/lib/runtime_switch_batch.ts'

test('createLimiter bounds concurrent tasks without blocking completions', async () => {
  const limit = createLimiter(2)
  let active = 0
  let peak = 0
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((value) =>
      limit(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active--
        return value * 10
      }),
    ),
  )
  assert.equal(peak, 2)
  assert.deepEqual(results, [10, 20, 30, 40, 50])
})

test('runPool enforces concurrency limit and isolates per-item failures', async () => {
  let active = 0
  let peak = 0
  const results = await runPool([1, 2, 3, 4, 5, 6], 3, async (item) => {
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active--
    if (item === 3) throw new Error('boom')
    return item * 2
  })
  assert.equal(peak, 3)
  assert.equal(results[0].status, 'fulfilled')
  assert.equal((results[0] as PromiseFulfilledResult<number>).value, 2)
  assert.equal(results[2].status, 'rejected')
  assert.match(String((results[2] as PromiseRejectedResult).reason), /boom/)
  assert.equal(results[5].status, 'fulfilled')
  assert.equal((results[5] as PromiseFulfilledResult<number>).value, 12)
})

test('SnapshotPoller shares one polling loop across N waiters and resolves fast ones first', async () => {
  let fetches = 0
  let state = { ready: new Set<string>() }
  const poller = new SnapshotPoller(15, async () => {
    fetches++
    if (fetches === 1) state.ready.add('fast-1')
    if (fetches === 1) state.ready.add('fast-2')
    if (fetches === 3) state.ready.add('slow-3')
    return state
  })

  const order: string[] = []
  const fast1 = poller.waitFor('fast-1 timeout', 500, (s) => s.ready.has('fast-1') && 'ok-1').then((v) => { order.push(v); return v })
  const fast2 = poller.waitFor('fast-2 timeout', 500, (s) => s.ready.has('fast-2') && 'ok-2').then((v) => { order.push(v); return v })
  const slow3 = poller.waitFor('slow-3 timeout', 500, (s) => s.ready.has('slow-3') && 'ok-3').then((v) => { order.push(v); return v })
  const stuck = poller.waitFor('stuck timeout', 40, (s) => s.ready.has('never') && 'never')

  const [r1, r2, r3] = await Promise.all([fast1, fast2, slow3])
  await assert.rejects(stuck, /stuck timeout/)

  assert.deepEqual([r1, r2, r3], ['ok-1', 'ok-2', 'ok-3'])
  assert.deepEqual(order.slice(0, 2).sort(), ['ok-1', 'ok-2'])
  assert.equal(order[2], 'ok-3')
  // Shared poller should have run far fewer fetches than 4 independent poll loops.
  assert.ok(fetches <= 6, `expected shared polling, got ${fetches} fetches`)
})

test('partitionTuiTargets separates unique native threads from duplicate runtime copies', () => {
  const existing = [
    { id: 1, sharedRuntime: false, sessionId: 'already-in-pty' },
    { id: 2, sharedRuntime: true, sessionId: 'already-in-pty' },
    { id: 3, sharedRuntime: true, sessionId: 'thread-a' },
    { id: 4, sharedRuntime: true, sessionId: 'thread-a' },
    { id: 5, sharedRuntime: true, sessionId: 'thread-b' },
  ]
  const due = existing.filter((t) => t.sharedRuntime)
  const { toResume, toDrop } = partitionTuiTargets(due, existing)
  assert.deepEqual(toResume.map((t) => t.id), [3, 5])
  assert.deepEqual(toDrop.map((t) => t.id), [2, 4])
})

test('reorderAfterBatch and targetActiveAfterBatch preserve slots and focus despite out-of-order completion', () => {
  // Initial tabs: [1(move->101), 2(stay), 3(move->103), 4(rollback->104), 5(stay)]
  const initialOrder = [1, 2, 3, 4, 5]
  // Completed out of order, plus a brand-new tab 999 opened concurrently
  const current = [
    { id: 2, title: 'stay-2' },
    { id: 5, title: 'stay-5' },
    { id: 103, title: 'moved-3' },
    { id: 101, title: 'moved-1' },
    { id: 104, title: 'rollback-4' },
    { id: 999, title: 'brand-new' },
  ]
  const replacements = new Map<number, number>([
    [1, 101],
    [3, 103],
    [4, 104],
  ])
  const ordered = reorderAfterBatch(current, initialOrder, replacements)
  assert.deepEqual(ordered.map((t) => t.id), [101, 2, 103, 104, 5, 999])
  assert.equal(targetActiveAfterBatch(3, replacements, ordered), 103)
  assert.equal(targetActiveAfterBatch(2, replacements, ordered), 2)
  assert.equal(targetActiveAfterBatch(777, replacements, ordered), null)
})

test('batchCurrentStep advances only after every active item passes the earlier step', () => {
  const steps: SwitchStep[] = ['stop', 'import', 'open']
  assert.equal(batchCurrentStep(steps, ['stop', 'import', 'open']), 'stop')
  assert.equal(batchCurrentStep(steps, ['import', 'open']), 'import')
  assert.equal(batchCurrentStep(steps, ['open']), 'open')
  assert.equal(batchCurrentStep(steps, []), 'open')
})
