import test from 'node:test'
import assert from 'node:assert/strict'
import { CoordinatorCloseRecovery } from '../src/coordinator-close-recovery.js'

test('close recovery advances past an unavailable runtime and resumes its cursor without creating execution', async () => {
  const paths = [], closes = [], stop = new AbortController()
  const pages = [
    { home_hub: 'home', items: [{ operation_id: 'unavailable', command: {} }], next_cursor: 'coordinator-close:["unavailable",1]' },
    { home_hub: 'home', items: [{ operation_id: 'reported', command: {} }], next_cursor: null },
  ]
  let release
  const wait = new Promise(resolve => { release = resolve })
  const host = { stop, execution: { host: 'home', client: { async call(path) { paths.push(path); await wait; return pages.shift() } } }, async closeCoordinator(input) {
    closes.push(input.operation_id)
    if (input.operation_id === 'unavailable') throw Error('Live runtime unavailable; no inference resumed')
    return { state: 'closed', execution_resumed: false }
  } }
  const recovery = new CoordinatorCloseRecovery(host)
  const first = recovery.scan(); assert.equal(recovery.scan(), first)
  release()
  assert.equal((await first)[0].state, 'recovery_required')
  assert.equal((await recovery.scan())[0].state, 'closed')
  assert.deepEqual(closes, ['unavailable', 'reported'])
  assert.equal(new URL('http://fixture' + paths[1]).searchParams.get('after'), 'coordinator-close:["unavailable",1]')
  assert.equal(recovery.after, '')
  await recovery.close()
  await assert.rejects(recovery.scan(), /stopped/)
})

test('close recovery refuses foreign authority and non-advancing cursors before effects', async () => {
  let page = { home_hub: 'foreign', items: [] }, calls = 0
  const host = { stop: new AbortController(), execution: { host: 'home', client: { async call() { return page } } }, async closeCoordinator() { calls++ } }
  const recovery = new CoordinatorCloseRecovery(host)
  await assert.rejects(recovery.scan(), /Invalid/)
  recovery.after = 'coordinator-close:z'
  page = { home_hub: 'home', items: [], next_cursor: 'coordinator-close:a' }
  await assert.rejects(recovery.scan(), /Invalid/)
  assert.equal(calls, 0)
  await recovery.close()
})

test('idle close requires live wakeup, startup configuration and current internal pricing', async () => {
  const closes = [], signal = new AbortController().signal
  const scope = { team_id: 'team', control_revision: 2 }
  const op = { id: 'operation', attempt: 1, epoch: 3 }
  const active = { active: true, authority_valid: true, revision: 4, snapshot: {
    team: { id: 'team', home_hub: 'home' }, policies: {
      budget: { policy: { settlement: 'manual' } }, scheduling: { policy: { targets: { target: { internal_price_id: 'price' } } } },
    },
  } }
  const control = { revision: 2, request: { activation_revision: 4, operation_id: 'operation', attempt: 1, epoch: 3, target_id: 'target' }, worker: { node_id: 'home', session_id: 'session' } }
  let ready = true
  const host = { stop: new AbortController(), coordinatorBootstrap: { running: false }, handles: new Map([['session', { run: { signal } }]]), execution: {
    host: 'home', profiles: { binding: () => ({ managedCoordinator: scope, managedOperation: op }) },
    client: { async call(path) {
      if (path.endsWith('/coordinator-close')) return { idle_close_ready: ready }
      if (path.endsWith('/activation')) return active
      if (path.endsWith('/coordinator-control')) return { control }
      throw Error('Unexpected read')
    } },
  }, async closeCoordinator(input) { closes.push(input); throw Error('Lost close response') } }
  const service = new CoordinatorCloseRecovery(host)
  assert.deepEqual(await service.closeIdle(signal), [])
  active.snapshot.policies.budget.policy.settlement = 'internal_price'
  assert.deepEqual(await service.closeIdle(signal), [])
  host.coordinatorBootstrap.running = true
  assert.deepEqual(await service.closeIdle(signal), [])
  active.snapshot.team.spec = { coordinator_startup: { workspace_id: 'workspace', task_tag: 'inspection' } }
  control.revision = 3
  assert.deepEqual(await service.closeIdle(signal), [])
  control.revision = 2; ready = false
  assert.deepEqual(await service.closeIdle(signal), [])
  ready = true
  assert.equal((await service.closeIdle(signal))[0].state, 'idle_close_pending')
  await service.closeIdle(signal)
  assert.equal(closes.length, 2)
  assert.deepEqual(closes[0], closes[1])
  assert.equal(closes[0].command.idle_only, true)
  assert.equal(closes[0].command.price_id, 'price')
  await service.close()
})
