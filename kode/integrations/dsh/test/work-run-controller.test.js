import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkRunController } from '../src/work-run-controller.js'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
test('takeover returns only Home pause proof and never dispatches paused work', async () => {
  let paused = false, finalizations = 0
  const receipt = { completion_authorized: false }
  const dispatcher = { host: { stop: new AbortController(), execution: { host: 'home', client: {
    async call(path, command) {
      if (command) { assert.equal(command.action, 'finalize_takeover'); finalizations++; paused = true }
      return { id: 'run', home_hub: 'home', revision: 3, state: paused ? 'paused' : 'taking_over',
        intervention: { assignment_ids: [], stop_confirmed: paused, resources_released: paused, receipt } }
    },
  } } }, start() { throw Error('paused work must never dispatch') } }
  const controller = new WorkRunController(dispatcher, { prepare() { throw Error('must not prepare') } })
  try {
    assert.deepEqual(await controller.advance('run'), { state: 'paused', run_id: 'run', receipt })
    assert.deepEqual(await controller.advance('run'), { state: 'paused', run_id: 'run', receipt })
    assert.equal(finalizations, 1)
  } finally { await controller.close() }
})
test('WorkRun controller coalesces an in-flight step and closes before a prepared Worker can start', async () => {
  const preparing = deferred(), release = deferred()
  let starts = 0, reads = 0
  const run = { id: 'run', home_hub: 'home', state: 'waiting_resource',
    context: { binding: { workflow: { pack: { completion_stages: ['stage'] } } } },
    stages: [{ stage_id: 'stage', assignment_id: 'assignment', attempt: 1, state: 'ready' }] }
  const assignment = { id: 'assignment', state: 'prepared', worker: { node_id: 'home', session_id: 'worker' } }
  const dispatcher = { host: { stop: new AbortController(), handles: new Map(), execution: { host: 'home',
    client: { async call(path) { reads++; return structuredClone(path.includes('work-runs') ? run : assignment) } } } },
    async start() { starts++; throw new Error('unexpected creation') } }
  const controller = new WorkRunController(dispatcher, { prepare: async () => { preparing.resolve(); await release.promise; return {} }, outputs: () => null })
  const first = controller.advance('run'), second = controller.advance('run')
  assert.equal(first, second)
  await preparing.promise
  const closed = controller.close()
  release.resolve()
  await assert.rejects(first, /controller closed/)
  await closed
  assert.equal(starts, 0); assert.equal(reads, 2)
  await assert.rejects(controller.advance('run'), /controller closed/)
})
test('WorkRun watch reports a terminal receipt once and removes its timer without executing adapters', async () => {
  const observed = deferred()
  const dispatcher = { host: { stop: new AbortController(), execution: { host: 'home', client: {
    async call() { return { state: 'completed', delivery: { completion_authorized: true } } },
  } } } }
  const controller = new WorkRunController(dispatcher, { prepare: () => { throw new Error('unexpected adapter') }, outputs: () => { throw new Error('unexpected output read') } })
  try {
    controller.watch('run', { intervalMs: 100, onState: result => observed.resolve(result) })
    const result = await observed.promise
    assert.equal(result.state, 'completed'); assert.equal(result.receipt.completion_authorized, true)
    assert.equal(controller.watches.size, 0)
  } finally { await controller.close() }
})
test('home controller reserves remote resources and delivers only after creation and directory propagation', async () => {
  const assignment = { id: 'assignment', revision: 1, state: 'prepared', worker: { node_id: 'remote', session_id: 'worker' } }
  const run = { id: 'run', home_hub: 'home', state: 'running', context: { binding: { workflow: { pack: {} } } }, stages: [{ stage_id: 'stage', assignment_id: 'assignment', state: 'ready' }] }
  let registered = false, holds = 0, mandates = 0
  const dispatcher = { host: { stop: new AbortController(), handles: new Map(), execution: { host: 'home', client: { async call(path, body) {
    if (path.endsWith('/resources')) { holds++; assignment.resources = { state: 'held' }; assignment.revision++; return {} }
    if (path.endsWith('/mandate')) { mandates++; assert.equal(body.expected_revision, assignment.revision); assignment.mandate = { receipt: {} }; throw new Error('lost committed reply') }
    if (path.endsWith('/sessions')) return { sessions: registered ? [{ address: assignment.worker }] : [] }
    return structuredClone(path.includes('/work-runs/') ? run : assignment)
  } } } }, start() { throw new Error('must never create local Worker') } }
  const controller = new WorkRunController(dispatcher, { prepare() { throw new Error('must never prepare remote execution locally') } })
  try {
    assert.equal((await controller.advance('run')).state, 'remote_resources_held')
    assert.equal((await controller.advance('run')).state, 'waiting_remote_host')
    assignment.creation = { state: 'uncertain' }
    assert.equal((await controller.advance('run')).state, 'recovery_required')
    assignment.creation.state = 'created'
    assert.equal((await controller.advance('run')).state, 'waiting_remote_host')
    assert.equal(mandates, 0)
    registered = true
    await assert.rejects(controller.advance('run'), /lost committed reply/)
    assert.equal((await controller.advance('run')).state, 'waiting_remote_host')
    assert.equal(holds, 1); assert.equal(mandates, 1)
    assignment.resources.state = 'released'
    assert.equal((await controller.advance('run')).state, 'recovery_required')
  } finally { await controller.close() }
})

test('cancellation intent never enters normal workflow scheduling or delivery', async () => {
  const controller = new WorkRunController({ host: { stop: new AbortController(), execution: { host: 'home', client: {
    async call(path, body) { if (body) { assert.equal(body.action, 'finalize_cancel'); throw new Error('cancellation pending: fixture') } return { id: 'run', home_hub: 'home', state: 'cancelling', cancellation: { stop_confirmed: false, assignment_ids: [] } } },
  } } } }, { prepare() { throw new Error('must not prepare cancelled work') } })
  try { assert.equal((await controller.advance('run')).state, 'waiting_cancellation_accounting') }
  finally { await controller.close() }
})

test('home cancellation drains local ownership and never stops a remote Worker locally', async () => {
  const run = { id: 'run', home_hub: 'home', state: 'cancelling', cancellation: { assignment_ids: ['remote', 'local', 'missing'] } }
  let stops = 0
  const dispatcher = { host: { stop: new AbortController(), handles: new Map([['local-worker', {}]]), execution: { host: 'home', profiles: { binding: () => ({}) }, client: {
    async call(path, body) {
      if (body) { assert.equal(body.action, 'finalize_cancel'); throw new Error('cancellation pending: exact execution drain required') }
      if (path.includes('/work-runs/')) return run
      const id = path.split('/').at(-1)
      return { id, run_id: 'run', creation: { state: 'created' }, worker: { node_id: id === 'remote' ? 'remote' : 'home', session_id: id + '-worker' } }
    },
  } } }, async stop(id) { assert.equal(id, 'local'); stops++ } }
  const controller = new WorkRunController(dispatcher, { prepare() { throw new Error('must not dispatch') } })
  try {
    assert.equal((await controller.advance('run')).state, 'waiting_remote_cancellation')
    assert.equal((await controller.advance('run')).state, 'cancellation_execution_drained')
    assert.equal((await controller.advance('run')).state, 'cancel_unconfirmed')
    assert.equal(stops, 1)
  } finally { await controller.close() }
})

test('cancellation reconciles drained usage and returns only the authoritative terminal receipt', async () => {
  let settled = false, accounted = 0
  const run = { id: 'run', revision: 3, home_hub: 'home', state: 'cancelling', cancellation: { assignment_ids: ['assignment'] } }
  const receipt = { completion_authorized: false, request_id: 'confirmed' }
  const controller = new WorkRunController({ host: { stop: new AbortController(), execution: { host: 'home', client: {
    async call(path, body) {
      if (path.endsWith('/accounting')) { assert.equal(body.expected_revision, 7); accounted++; settled = true; return {} }
      if (body) {
        assert.equal(body.action, 'finalize_cancel'); assert.equal(body.expected_revision, 3)
        if (!settled) throw new Error('kode backend (400): cancellation pending: exact finalized accounting required')
        return { state: 'cancelled', cancellation: { stop_confirmed: true, resources_released: true, receipt } }
      }
      return path.includes('/work-runs/') ? run : { id: 'assignment', run_id: 'run', revision: 7, stop: { receipt: { state: 'execution_drained' } } }
    },
  } } } }, { prepare() { throw new Error('cancel must not execute') } })
  try {
    assert.equal((await controller.advance('run')).state, 'cancellation_accounted')
    assert.deepEqual(await controller.advance('run'), { state: 'cancelled', run_id: 'run', receipt })
    assert.equal(accounted, 1)
  } finally { await controller.close() }
})

test('cancelled execution with unresolved usage remains pending, while transport failures surface', async () => {
  let accountingError = 'kode backend (400): official usage remains unresolved'
  const controller = new WorkRunController({ host: { stop: new AbortController(), execution: { host: 'home', client: {
    async call(path, body) {
      if (path.endsWith('/accounting')) throw new Error(accountingError)
      if (body) throw new Error('kode backend (400): cancellation pending: exact finalized accounting required')
      return path.includes('/work-runs/') ? { id: 'run', home_hub: 'home', revision: 1, state: 'cancelling', cancellation: { assignment_ids: ['assignment'] } }
        : { id: 'assignment', run_id: 'run', revision: 1, stop: { receipt: { state: 'execution_drained' } } }
    },
  } } } }, { prepare() { throw new Error('must not start execution') } })
  try {
    assert.deepEqual(await controller.advance('run'), { state: 'waiting_cancellation_accounting', reason: 'usage_reconciliation_required', run_id: 'run', assignment_id: 'assignment' })
    accountingError = 'network unavailable'
    await assert.rejects(controller.advance('run'), /network unavailable/)
    accountingError = 'kode backend (403): official usage remains unresolved'
    await assert.rejects(controller.advance('run'), /403/)
  } finally { await controller.close() }
})


test('one-step watch retains its slot through callback settlement and preserves branch cursor', async () => {
  const entered = deferred(), release = deferred()
  const controller = new WorkRunController({ host: { stop: new AbortController(), execution: { host: 'home' } } }, { prepare() {} })
  let advances = 0
  controller.step = async () => { advances++; controller.cursor.set('run', 2); return { state: 'waiting_remote_host' } }
  try {
    controller.watch('run', { intervalMs: 100, once: true, onState: async () => { entered.resolve(); await release.promise } })
    await entered.promise
    assert.equal(controller.watches.size, 1)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(advances, 1, 'slow callbacks cannot admit another advance')
    release.resolve()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(controller.watches.size, 0)
    assert.equal(controller.cursor.get('run'), 2)
  } finally { release.resolve(); await controller.close() }
  assert.equal(controller.cursor.size, 0)
})

test('delivery awaiting exact human acceptance is waiting_user and never reported completed', async () => {
  let receipt = { completion_authorized: false, state: 'waiting_user', reason: 'human_delivery_acceptance_required' }
  const run = { id: 'run', home_hub: 'home', revision: 4, state: 'running', context: { binding: { workflow: { pack: { completion_stages: ['verify'] } } } }, stages: [{ stage_id: 'verify', state: 'passed' }] }
  const dispatcher = { host: { stop: new AbortController(), execution: { host: 'home', client: { async call(path) { return path.endsWith('/delivery') ? receipt : run } } } } }
  const controller = new WorkRunController(dispatcher, { prepare() { throw Error('Unexpected execution') } })
  try {
    assert.equal((await controller.advance('run')).state, 'waiting_user')
    receipt = { completion_authorized: false }
    await assert.rejects(controller.advance('run'), /not authorized/)
    receipt = { completion_authorized: true }
    assert.equal((await controller.advance('run')).state, 'completed')
  } finally { await controller.close() }
})

test('budget waiting requires typed schedule conflict and never masks generic authority failures', async () => {
  for (const [error, expected] of [
    [{ status: 409, code: 'team_budget_exhausted', path: '/api/v1/messaging/work-runs/run/schedule' }, 'waiting_resource'],
    [{ status: 400, code: 'team_budget_exhausted', path: '/api/v1/messaging/work-runs/run/schedule' }, 'progression_failed'],
    [{ status: 409, code: 'team_budget_exhausted', path: '/api/v1/messaging/teams/team/activation' }, 'progression_failed'],
    [{ status: 409, code: 'unauthorized', path: '/api/v1/messaging/work-runs/run/schedule' }, 'progression_failed'],
  ]) {
    const observed = deferred(), controller = new WorkRunController({ host: { execution: {} } }, { prepare: () => null })
    controller.advance = async () => { throw Object.assign(Error('fixture'), error) }
    try {
      controller.watch('run', { onState: result => observed.resolve(result) })
      assert.equal((await observed.promise).state, expected)
      assert.equal(controller.watches.size, expected === 'waiting_resource' ? 1 : 0)
    } finally { await controller.close() }
  }
})

test('queued clarification answer fences already-published outputs before report or stop', async () => {
  const run = { id: 'run', home_hub: 'home', state: 'running', context: { binding: { workflow: { pack: { completion_stages: ['stage'] } } } },
    stages: [{ stage_id: 'stage', assignment_id: 'assignment', attempt: 1, state: 'ready', evidence: { outputs: { artifact: 1 } } }] }
  for (const node of ['home', 'remote']) {
    let writes = 0
    const assignment = { id: 'assignment', state: 'prepared', worker: { node_id: node, session_id: 'worker' },
      clarification_progress: { ready_to_report: false }, creation: { state: 'created' }, mandate: { receipt: { message_id: 'mandate' } } }
    const dispatcher = { host: { stop: new AbortController(), execution: { host: 'home', client: { async call(path, body) {
      if (body) { writes++; throw Error('must not finalize an unanswered input') }
      return structuredClone(path.includes('/work-runs/') ? run : assignment)
    } } } }, async stop() { writes++; throw Error('must not stop waiting Worker') } }
    const controller = new WorkRunController(dispatcher, { prepare() { throw Error('must not recreate waiting Worker') }, outputs() { throw Error('must not reuse prior outputs') } })
    try {
      for (let attempt = 0; attempt < 2; attempt++) assert.equal((await controller.advance('run')).state, 'waiting_answer_execution')
      assert.equal(writes, 0)
    } finally { await controller.close() }
  }
})
