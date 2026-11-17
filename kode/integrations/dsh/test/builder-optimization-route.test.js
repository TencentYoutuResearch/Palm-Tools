import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerBuilderOptimization } from '../src/builder-optimization-route.js'
test('only owner exact confirmation creates an optimization draft without model or activation calls', async () => {
  let route, status, body, principal = 'agent', calls = [], fail = false
  registerBuilderOptimization({ webServer: { register: value => { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: principal } } }) } }, { backendClient: { async call(...args) { calls.push(args); if (fail) throw new Error('private details'); return { model_started: false } } } })
  const command = { team_id: 'team:1', team_revision: 3, draft_id: 'draft', request_id: 'confirm', purpose: 'Improve design' }
  const send = async (value = command, method = 'POST') => { const req = Readable.from([JSON.stringify(value)]); Object.assign(req, { method, url: '/api/kode/builder/optimization-draft', headers: { 'content-type': 'application/json' } }); await route.handler(req, { writeHead(code) { status = code }, end(data) { body = JSON.parse(data) } }) }
  await send(); assert.equal(status, 403)
  principal = 'owner'; await send(command, 'GET'); assert.equal(status, 405)
  for (const value of [{ ...command, team_revision: 0 }, { ...command, team_id: '../team' }, { ...command, purpose: '' }, { ...command, baseline_spec: {} }, { ...command, builder_operation: {} }]) { await send(value); assert.equal(status, 400) }
  assert.equal(calls.length, 0)
  await send(); assert.equal(status, 200); assert.equal(body.model_started, false)
  assert.deepEqual(calls[0], ['/api/v1/messaging/teams/team%3A1/builder-drafts', { team_revision: 3, draft_id: 'draft', request_id: 'confirm', purpose: 'Improve design' }])
  fail = true; await send(); assert.equal(status, 409); assert.equal(body.retry, 'same_request'); assert.ok(!body.error.includes('private details'))
})
