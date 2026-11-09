/** Budgeted work must be meterable before any inference is admitted. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
import { UsageOutbox } from '../src/usage-outbox.js'
const operation = { id: 'operation', attempt: 1, epoch: 1, budget_required: true }
const price = { id: 'price', model: 'fixture', model_policy: 'requested_model' }
async function harness({ type = 'codex', threadId, rate = price } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kode-meter-admission-'))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type, executable: process.execPath, args: [fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))] }])
  await profiles.bind('worker', 'fixture'); await profiles.patchBinding('worker', { managedOperation: operation, ...(threadId ? { threadId } : {}) })
  const state = { claims: 0, reports: 0, writes: 0, events: [] }
  const outbox = new UsageOutbox({ call: async (_path, body) => {
    if (body) { state.writes++; throw new Error('unexpected ledger mutation') }
    return { operation_id: operation.id, attempt: 1, reservation: { revision: 1, finalized: false, request: { id: 'hold', operation_id: operation.id } }, price: rate }
  } }, profiles)
  const agent = { id: 'worker', session: { header: { cwd: root }, append() {} }, ctx: { parallel: async () => {}, get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) } : undefined, tools: { execute: async () => { throw new Error('unexpected tool') } } } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) }, get: name => name === 'kodeOperationLeases' ? { acquire: async () => { state.claims++; return { signal: new AbortController().signal, assertActive: async () => {}, finish: async () => { state.reports++ }, dispose() {} } } } : undefined }
  const adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: (_, event) => state.events.push(event), usageOutbox: outbox })
  return { profiles, state, adapter, outbox, async run() { for await (const _ of adapter.stream({ sessionId: 'worker', provider: profileRoute('fixture'), model: 'fixture', signal: AbortSignal.timeout(5000), messages: [{ id: 'input', role: 'user', content: [{ type: 'text', text: 'fixture work' }] }] })) {} }, async close() { await adapter.close(); await outbox.close(); await rm(root, { recursive: true, force: true }) } }
}
for (const [name, options, reason] of [
  ['unsupported collector', { type: 'custom' }, 'usage_collector_unsupported'],
  ['cold resumed history', { threadId: 'existing-thread' }, 'usage_baseline_missing'],
  ['price/model mismatch', { rate: { ...price, model: 'other' } }, 'price_model_mismatch'],
  ['no automatic price policy', { rate: { ...price, model_policy: 'admin_attested' } }, 'automatic_pricing_unavailable'],
]) test(`metering admission rejects ${name} before claim or native startup`, async () => {
  const h = await harness(options)
  try {
    await assert.rejects(h.run())
    assert.equal(h.state.claims, 0); assert.equal(h.state.writes, 0)
    assert.equal(h.adapter.live.size, 0)
    const binding = h.profiles.binding('worker')
    assert.deepEqual(binding.seenInputs, [])
    assert.equal(binding.accountingAdmission.status, 'rejected')
    assert.equal(binding.accountingAdmission.reason, reason)
    assert.ok(h.state.events.some(e => e.event.method === 'kode/accounting_admission' && e.event.params.reason === reason))
  } finally { await h.close() }
})
test('missing final counters cannot report budgeted work ready or release its hold', async () => {
  const h = await harness()
  try {
    await assert.rejects(h.run(), /without attributable usage/)
    await h.outbox.tick()
    assert.equal(h.state.claims, 1); assert.equal(h.state.reports, 0); assert.equal(h.state.writes, 0)
    assert.equal(h.profiles.binding('worker').lastOutcome, 'uncertain')
    assert.equal(h.profiles.binding('worker').operationClosed, true)
    assert.ok(h.state.events.some(e => e.event.method === 'kode/process_stop' && e.event.params.leader_exited))
  } finally { await h.close() }
})
test('cached accounting context is rechecked when selected model changes', async () => {
  const h = await harness()
  try {
    await h.outbox.prepare('worker', operation, 'fixture')
    await assert.rejects(h.outbox.prepare('worker', operation, 'other'), /Selected model/)
    assert.equal(h.state.claims, 0)
  } finally { await h.close() }
})
