import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { UsageOutbox } from '../src/usage-outbox.js'
import { turnUsage, zeroUsage } from '../src/native-usage.js'
const operation = { id: 'op', attempt: 1 }
const context = { operation_id: 'op', attempt: 1, reservation: { revision: 1, finalized: false, request: { id: 'hold', operation_id: 'op' } }, price: { id: 'price', model: 'fixture', model_policy: 'requested_model' } }
const observation = (input = 10) => turnUsage(zeroUsage(), { input_tokens: input, cached_input_tokens: 0, output_tokens: 2, cache_write_input_tokens: 0 }, { threadId: 'thread', turnId: 'turn', model: 'fixture' })

test('lost usage response replays exact receipt after reopening and preserves newer cumulative evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-usage-outbox-')), path = join(root, 'profiles.json')
  let service, posts = 0, revision = 1
  const receipts = new Map()
  const client = { call: async (path, command) => {
    if (path.includes('/budget?')) return structuredClone(context)
    if (!command) { const receipt = receipts.get(path.split('/').at(-1)); if (!receipt) throw Object.assign(new Error('missing'), { status: 404 }); return receipt }
    posts++
    assert.equal(command.expected_revision, revision)
    const result = { estimated: true, price_id: 'price', reservation: { request: { id: 'hold' }, revision: ++revision } }
    receipts.set(command.event_id, { usage: structuredClone(command), result })
    throw new Error('response lost after commit')
  } }
  try {
    let profiles = await new AgentProfiles(path).open([{ id: 'p', type: 'codex', name: 'Worker' }])
    await profiles.bind('s', 'p'); await profiles.patchBinding('s', { managedOperation: operation })
    service = new UsageOutbox(client, profiles)
    const key = await service.prepare('s', operation, 'fixture')
    await assert.rejects(profiles.clearUnusedBinding('s'), /new conversation/)
    await profiles.bindNative('s', 'p', 'thread')
    assert.ok(profiles.binding('s').usageOutbox[key])
    await service.observe('s', key, observation()); await service.tick()
    assert.equal(posts, 1); assert.ok(profiles.binding('s').usageOutbox[key].command)
    await service.close()
    profiles = await new AgentProfiles(path).open()
    service = new UsageOutbox(client, profiles)
    await service.observe('s', key, { ...observation(20), turn_ended: true }); await service.tick()
    assert.equal(posts, 1, 'recovery reads original receipt without rebilling')
    await service.tick(); assert.equal(posts, 2)
    await service.tick()
    const row = profiles.binding('s').usageOutbox[key]
    assert.equal(row.done, true); assert.equal(row.revision, 3)
    assert.equal(row.status, 'estimated_pending_reconciliation')
    await service.tick(); assert.equal(posts, 2)
    await assert.rejects(service.observe('s', key, { ...observation(), turn_id: 'another' }), /multiple native turns/)
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }) }
})

test('unsupported evidence remains durable and conflicting receipt never advances revision', async () => {
  const profiles = { bindings: { s: { managedOperation: operation } }, binding(id) { return structuredClone(this.bindings[id]) }, async update(fn) { return fn(this) } }
  let posts = 0
  const client = { call: async (path, body) => {
    if (path.includes('/budget?')) return context
    if (body) posts++
    return { usage: { event_id: 'different' }, result: {} }
  } }
  const service = new UsageOutbox(client, profiles)
  try {
    const key = await service.prepare('s', operation, 'fixture')
    await service.observe('s', key, { ...observation(), reason: 'model_rerouted_during_turn' }); await service.tick()
    assert.equal(profiles.binding('s').usageOutbox[key].status, 'usage_attribution_unresolved')
    await service.observe('s', key, observation()); await service.tick()
    const row = profiles.binding('s').usageOutbox[key]
    assert.equal(row.status, 'pending_reconciliation'); assert.equal(row.revision, 1)
    assert.ok(row.command); assert.equal(posts, 0)
  } finally { await service.close() }
})
