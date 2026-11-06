import test from 'node:test'
import assert from 'node:assert/strict'
import { registerWorkRunExecution } from '../src/work-run-execution-route.js'
test('execution observation requires owner and exact Home/run/team and performs reads only', async () => {
  let route, principal = 'owner', status, body, reads = 0
  const run = { id: 'run', team_id: 'team', home_hub: 'home', revision: 4, state: 'running', completion_authorized: false }
  const accounting = { home_hub: 'home', run_id: 'run', team_id: 'team', run_revision: 4, authority: 'home_accounting_observation', read_only: true, blocked: false, state: 'no_usage_blocker', reason: null, recovery: null, retry_allowed: false, unresolved_calls: [], truncated: false }
  const service = { runtime: { host: 'home' }, stop: new AbortController(), rows: { run: { revision: 4, state: 'progression_failed', blocked: true } } }
  registerWorkRunExecution({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: principal } } }) }, get: () => ({ officialExecution: { host: 'home' }, workRuns: service }) },
    { backendClient: { call: async (path, command) => { assert.equal(command, undefined); reads++; if (path === '/api/v1/messaging/work-runs/run') return run; assert.equal(path, '/api/v1/messaging/work-runs/run/accounting-status'); return accounting } } })
  const response = { writeHead: value => { status = value }, end: value => { body = JSON.parse(value) } }
  const get = url => route.handler({ method: 'GET', url }, response)
  await get('/api/kode/work-run/execution?run_id=run&team_id=team')
  assert.equal(status, 200); assert.equal(body.state, 'progression_failed'); assert.deepEqual(body.accounting, accounting); assert.equal(run.state, 'running')
  for (const query of ['run_id=run', 'run_id=run&team_id=team&extra=1', 'run_id=run&team_id=team&team_id=other', 'run_id=../run&team_id=team']) { await get('/api/kode/work-run/execution?' + query); assert.equal(status, 400) }
  assert.equal(reads, 2)
  principal = 'agent'; await get('/api/kode/work-run/execution?run_id=run&team_id=team'); assert.equal(status, 403); assert.equal(reads, 2)
  principal = 'owner'; await get('/api/kode/work-run/execution?run_id=run&team_id=other'); assert.equal(status, 409)
  run.home_hub = 'foreign'; await get('/api/kode/work-run/execution?run_id=run&team_id=team'); assert.equal(status, 409)
  await route.handler({ method: 'POST' }, response); assert.equal(status, 405)
})
