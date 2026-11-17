import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { prepareConfiguration, saveConfiguration, verifyConfiguration } from '../packages/collab/team-configuration.js'
import { registerTeamConfiguration } from '../src/team-configuration-route.js'
const team = { id: 't', home_hub: 'h', revision: 3, superagent_id: 'a', conversation_id: 'c', spec: { grant_id: 'grant', execution_targets: [{ id: 'one' }, { id: 'two' }], workers: [{ id: 'worker', role: 'Backend', responsibilities: ['Implement'], allowed_target_ids: ['one'], required_capabilities: ['code'], workspace_refs: [{ host_id: 'h', workspace_id: 'w' }], max_parallel: 1 }] } }
const changed = () => [{ ...team.spec.workers[0], role: 'Verify', allowed_target_ids: ['one', 'two'] }]
const receipt = command => ({ ...team, revision: 4, status: 'draft', eligible_for_execution: false, spec: command.spec })
test('editable role mapping preserves authority, workspace and capability requirements', () => {
 const command = prepareConfiguration(team, changed(), 'r')
 assert.equal(command.expected_revision, 3); assert.equal(command.spec.grant_id, 'grant')
 assert.deepEqual(command.spec.workers[0].required_capabilities, ['code']); assert.deepEqual(command.spec.workers[0].allowed_target_ids, ['one', 'two'])
 assert.deepEqual(team.spec.workers[0].allowed_target_ids, ['one'])
 for (const change of [{ allowed_target_ids: ['unknown'] }, { allowed_target_ids: [] }, { allowed_target_ids: ['one', 'one'] }, { role: ' ' }, { max_parallel: 0 }]) assert.throws(() => prepareConfiguration(team, [{ ...changed()[0], ...change }], 'r'))
})
test('receipt rejects changed identity, activation and silently changed models', () => {
 const command = prepareConfiguration(team, changed(), 'r'), good = receipt(command)
 verifyConfiguration(team, command, good)
 for (const change of [{ revision: 5 }, { eligible_for_execution: true }, { conversation_id: 'wrong' }, { spec: team.spec }, { status: 'active' }]) assert.throws(() => verifyConfiguration(team, command, { ...good, ...change }))
})
test('uncertain write recovers exact persisted command and prevents a second edit', async () => {
 let record, calls = 0
 const storage = { reserve: async (k, v) => record ??= v, save: async (k, v) => { record = v } }
 const command = prepareConfiguration(team, changed(), 'r')
 const request = async c => { calls++; if (calls === 1) throw Error('lost response'); return receipt(c) }
 await assert.rejects(saveConfiguration({ team, command, storage, request }))
 await assert.rejects(saveConfiguration({ team, command: { ...command, request_id: 'new' }, storage, request }))
 await saveConfiguration({ team, command, storage, request }); await saveConfiguration({ team, command, storage, request })
 assert.equal(calls, 2)
})
test('owner route forwards versioned command only to fixed backend path', async () => {
 let route, kind = 'agent', status, calls = []
 registerTeamConfiguration({ connection: { admit: () => ({ peer: { principal: { kind } } }) }, webServer: { register: r => { route = r } } }, { backendClient: { call: async (...args) => { calls.push(args); return receipt(args[1]) } } })
 const send = async body => { const req = Readable.from([JSON.stringify(body)]); Object.assign(req, { method: 'POST', headers: { 'content-type': 'application/json' } }); await route.handler(req, { writeHead: c => { status = c }, end() {} }) }
 const command = prepareConfiguration(team, changed(), 'r')
 await send(command); assert.equal(status, 403); kind = 'owner'
 for (const invalid of [{ ...command, expected_revision: 0 }, { ...command, actor: 'owner' }, { ...command, id: '../x' }]) { await send(invalid); assert.equal(status, 400) }
 assert.equal(calls.length, 0); await send(command); assert.equal(status, 200)
 assert.deepEqual(calls[0], ['/api/v1/messaging/teams', command])
})
