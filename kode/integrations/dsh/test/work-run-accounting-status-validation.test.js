import test from 'node:test'
import assert from 'node:assert/strict'
import { readWorkRunAccounting } from '../src/work-run-accounting-status.js'

const runtime = { host: 'home-hub', client: null }
const run = { id: 'run.1', team_id: 'team.1', revision: 7 }
const budget = ({ held = 0, charged = 12, finalized = false, frozen = false } = {}) => ({
  reservation_id: 'reservation.1', unit: 'credits', charged, held, finalized, frozen,
})
const unresolvedCall = (overrides = {}) => ({
  call_id: 'call.1', operation_id: 'operation.1', attempt: 1, epoch: 2,
  assignment_id: null, stage_id: null, state: 'finished', accounting_status: 'usage_unresolved', budget: null,
  ...overrides,
})
const observation = ({ blocked = false, unresolved_calls = [], ...overrides } = {}) => ({
  home_hub: runtime.host, run_id: run.id, team_id: run.team_id, run_revision: run.revision,
  authority: 'home_accounting_observation', read_only: true, blocked,
  state: blocked ? 'waiting_accounting' : 'no_usage_blocker',
  reason: blocked ? 'usage_reconciliation_required' : null,
  recovery: blocked ? 'blocked_until_trusted_usage_is_reconciled' : null,
  retry_allowed: false, unresolved_calls, truncated: false, ...overrides,
})
async function readWith(value) {
  const calls = []
  runtime.client = { async call(...args) { calls.push(args); return value } }
  const actual = await readWorkRunAccounting(runtime, run, 'fixture-abort-signal')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['/api/v1/messaging/work-runs/run.1/accounting-status', undefined, 'fixture-abort-signal'])
  return actual
}
async function rejectWith(value, pattern = /WorkRun accounting/) {
  runtime.client = { async call() { return value } }
  await assert.rejects(readWorkRunAccounting(runtime, run), pattern)
}

test('accepts a valid no_usage_blocker Home observation without unresolved calls', async () => {
  const actual = await readWith(observation())
  assert.deepEqual(actual, observation())
})

for (const [label, held, frozen] of [['released hold', 0, false], ['real held budget', 9, true]]) {
  test(`accepts effective blocked accounting with ${label}`, async () => {
    const actual = await readWith(observation({ blocked: true, unresolved_calls: [
      unresolvedCall({ state: 'uncertain', budget: budget({ held, frozen }) }),
    ] }))
    assert.equal(actual.blocked, true)
    assert.equal(actual.state, 'waiting_accounting')
    assert.equal(actual.unresolved_calls[0].budget.held, held)
    assert.equal(actual.unresolved_calls[0].budget.frozen, frozen)
  })
}

for (const [label, field, value] of [
  ['home', 'home_hub', 'foreign-home'],
  ['team', 'team_id', 'foreign-team'],
  ['run', 'run_id', 'foreign-run'],
  ['revision', 'run_revision', run.revision + 1],
]) test(`rejects foreign ${label} accounting scope`, async () => {
  await rejectWith(observation({ [field]: value }))
})

test('started null usage cannot pose as a terminal accounting blocker', async () => {
  await rejectWith(observation({ blocked: true, unresolved_calls: [
    unresolvedCall({ state: 'started', accounting_status: null }),
  ] }), /Invalid WorkRun accounting evidence/)
})

test('rejects malformed call ids', async () => {
  await rejectWith(observation({ blocked: true, unresolved_calls: [
    unresolvedCall({ call_id: '../call' }),
  ] }), /Invalid WorkRun accounting evidence/)
})

test('rejects duplicate unresolved call ids', async () => {
  const call = unresolvedCall()
  await rejectWith(observation({ blocked: true, unresolved_calls: [call, { ...call, operation_id: 'operation.2' }] }), /Duplicate WorkRun accounting call/)
})

for (const [label, field] of [['charged', 'charged'], ['held', 'held']]) test(`rejects unsafe ${label} amounts`, async () => {
  await rejectWith(observation({ blocked: true, unresolved_calls: [
    unresolvedCall({ budget: budget({ [field]: Number.MAX_SAFE_INTEGER + 1, frozen: field === 'held' }) }),
  ] }), /Invalid WorkRun accounting evidence/)
})

test('rejects frozen state inconsistent with a live held reservation', async () => {
  await rejectWith(observation({ blocked: true, unresolved_calls: [
    unresolvedCall({ budget: budget({ held: 9, frozen: false }) }),
  ] }), /Invalid WorkRun accounting evidence/)
})

test('does not pass through unknown raw or authentication fields', async () => {
  const sentinel = 'FIXTURE_ONLY_NOT_A_CREDENTIAL'
  const source = observation({ blocked: true, raw: sentinel, authorization: sentinel,
    unresolved_calls: [unresolvedCall({ raw: sentinel, api_key: sentinel, budget: { ...budget(), raw: sentinel, authorization: sentinel } })],
  })
  const actual = await readWith(source)
  assert.deepEqual(Object.keys(actual).sort(), [
    'authority', 'blocked', 'home_hub', 'reason', 'recovery', 'retry_allowed', 'run_id',
    'run_revision', 'state', 'team_id', 'truncated', 'unresolved_calls', 'read_only',
  ].sort())
  assert.deepEqual(Object.keys(actual.unresolved_calls[0]).sort(), [
    'accounting_status', 'assignment_id', 'attempt', 'budget', 'call_id', 'epoch', 'operation_id', 'stage_id', 'state',
  ].sort())
  assert.deepEqual(Object.keys(actual.unresolved_calls[0].budget).sort(), ['charged', 'finalized', 'frozen', 'held', 'reservation_id', 'unit'].sort())
  assert.equal(JSON.stringify(actual).includes(sentinel), false)
})
