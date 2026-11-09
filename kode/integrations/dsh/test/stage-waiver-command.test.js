import test from 'node:test'
import assert from 'node:assert/strict'
import { confirmStageWaiver, requestStageWaiver, stageWaiverKey } from '../packages/collab/stage-waiver-command.js'
import { registerWorkStageWaiver } from '../src/work-stage-waiver-route.js'
const run = { id: 'run', home_hub: 'home', team_id: 'team', revision: 4 }
const plan = { run_id: 'run', stage_id: 'check', run_revision: 4, completion_authorized: false, scope_hash: 'a'.repeat(64), scope: { run_id: 'run', stage_id: 'check', policy: { allow_delivery: true }, artifacts: { artifact: { sequence: 8 } } } }
const result = record => ({ ...run, revision: 5, state: 'queued', completion_authorized: false, stages: [{ stage_id: 'check', state: 'waived', waiver: { request_id: record.command.request_id, reason: record.command.reason, scope_hash: record.command.scope_hash, scope: record.plan.scope, actor: { kind: 'human', id: 'local_owner' } } }] })
function disk() { const rows = new Map(); return { read: async k => rows.get(k), reserve: async (k,v,replace) => { if (!rows.has(k) || replace?.(rows.get(k))) rows.set(k, structuredClone(v)); return rows.get(k) }, save: async (k,v) => rows.set(k, structuredClone(v)) } }
test('waiver transport recovers original consent after response loss or local save failure', async () => {
 const storage = disk(), calls = []; let saved
 const args = { run, stage: 'check', plan, reason: 'Defer this exact review', storage, uuid: () => 'original', request: async record => { calls.push(structuredClone(record)); saved = result(record); if (calls.length === 1) throw Error('lost response'); return saved } }
 await assert.rejects(confirmStageWaiver(args), /lost response/)
 await assert.rejects(confirmStageWaiver({ ...args, reason: 'Changed' }), /original/)
 assert.equal(calls.length, 1)
 const save = storage.save; storage.save = async () => { throw Error('disk unavailable') }
 await assert.rejects(confirmStageWaiver({ ...args, recover: true, run: { ...run, revision: 99 } }), /disk unavailable/)
 storage.save = save
 assert.deepEqual(await confirmStageWaiver({ ...args, recover: true }), saved)
 assert.deepEqual(calls[0], calls[2]); assert.equal((await storage.read(stageWaiverKey(run, 'check'))).state, 'accepted')
})
test('waiver receipt lookup avoids reposting and rejects wrong scope or fabricated completion', async () => {
 const storage = disk(); let record
 const args = { run, stage: 'check', plan, reason: 'Reviewed scope', storage, uuid: () => 'original', request: async r => { record = r; return { ...result(r), completion_authorized: true } } }
 await assert.rejects(confirmStageWaiver(args), /receipt/)
 assert.equal((await storage.read(stageWaiverKey(run, 'check'))).state, 'prepared')
 const { run_id, stage_id, ...input } = record.command
 let posts = 0
 const fetcher = async (_, options) => { if (options.method === 'POST') posts++; return { ok: true, json: async () => ({ receipt: { request: { action: 'waive_stage', stage_id, input }, result: result(record) } }) } }
 assert.deepEqual(await requestStageWaiver(record, { fetcher }), result(record)); assert.equal(posts, 0)
 await assert.rejects(confirmStageWaiver({ ...args, recover: true, request: async r => { const wrong = result(r); wrong.stages[0].waiver.scope = { foreign: true }; return wrong } }), /receipt/)
})
test('waiver owner bridge enforces identity and exact preview/receipt/decision payloads', async () => {
 let route, owner = false, status; const calls = []
 registerWorkStageWaiver({ webServer: { register: r => { route = r } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'agent' } } }) } }, { backendClient: { call: async (...args) => { calls.push(args); return {} } } })
 const invoke = async (method, query = '', value = {}) => route.handler({ method, url: route.path + query, headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield JSON.stringify(value) } }, { writeHead: code => { status = code }, end() {} })
 await invoke('GET', '?run_id=run&stage_id=check'); assert.equal(status, 403); assert.equal(calls.length, 0)
 owner = true
 await invoke('GET', '?run_id=run&stage_id=check'); assert.equal(status, 200); assert.equal(calls.at(-1)[0], '/api/v1/messaging/work-runs/run/stages/check/waiver-plan')
 await invoke('GET', '?run_id=run&stage_id=check&request_id=original'); assert.equal(calls.at(-1)[0], '/api/v1/messaging/work-runs/run/stages/check/waiver-requests/original')
 const command = { run_id: 'run', stage_id: 'check', request_id: 'original', expected_revision: 4, scope_hash: plan.scope_hash, reason: 'Reviewed' }
 for (const bad of [{ ...command, actor: 'owner' }, { ...command, stage_id: '../other' }, { ...command, reason: ' ' }]) { await invoke('POST', '', bad); assert.equal(status, 400) }
 await invoke('GET', '?run_id=run&stage_id=check&stage_id=other'); assert.equal(status, 400)
 await invoke('POST', '', command); assert.equal(status, 200)
 assert.deepEqual(calls.at(-1), ['/api/v1/messaging/work-runs/run/stages/check/waiver', { request_id: 'original', expected_revision: 4, scope_hash: plan.scope_hash, reason: 'Reviewed' }])
})

test('stale consent requires a newer authoritative revision and rechecks receipt against concurrent commit', async () => {
 const { resolveStageWaiver } = await import('../packages/collab/stage-waiver-command.js')
 for (const mode of ['unchanged', 'stale', 'committed', 'lookup-failed']) {
  const storage = disk(); let record, reads = 0
  await assert.rejects(confirmStageWaiver({ run, stage: 'check', plan, reason: 'Reviewed', storage, uuid: () => 'original', request: async r => { record = r; throw Error('lost') } }), /lost/)
  const fetcher = async url => {
   if (url.startsWith('/api/kode/work-run?')) return { ok: true, json: async () => ({ ...run, revision: mode === 'unchanged' ? 4 : 6 }) }
   reads++
   if (mode === 'lookup-failed' && reads === 2) return { ok: false }
   const { run_id, stage_id, ...input } = record.command
   return { ok: true, json: async () => ({ receipt: mode === 'committed' && reads === 2 ? { request: { action: 'waive_stage', stage_id, input }, result: result(record) } : null }) }
  }
  const action = () => resolveStageWaiver({ run, stage: 'check', storage, fetcher })
  if (['unchanged', 'lookup-failed'].includes(mode)) { await assert.rejects(action()); assert.equal((await storage.read(stageWaiverKey(run,'check'))).state, 'prepared') }
  else { assert.equal((await action()).state, mode === 'stale' ? 'stale' : 'accepted'); assert.equal(reads, 2) }
 }
})
