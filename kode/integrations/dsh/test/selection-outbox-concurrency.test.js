/** Deterministic transport delay; persistent profiles, no provider/Hub claims. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { SelectionOutbox } from '../src/selection-outbox.js'
test('new selection record awaits its own receipt while an older background batch is blocked', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'selection-concurrency-'))
  let release, outbox, background
  try {
    const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'fixture', name: 'Fixture', type: 'custom', executable: process.execPath }])
    const operation = { id: 'operation', attempt: 1, epoch: 1 }
    await profiles.bind('worker', 'fixture'); await profiles.patchBinding('worker', { managedOperation: operation })
    const params = { operation, profile_revision: profiles.binding('worker').revision, threadId: 'thread', turnId: 'turn', inputIds: ['input'], scope: 'executor_configuration', observed_at: 1,
      model: { requested: 'model', observed: 'model', status: 'reported', source: 'fixture' } }
    outbox = new SelectionOutbox({ call: async () => { throw new Error('offline') } }, profiles)
    await outbox.record('worker', params); await outbox.close()
    let entered
    const started = new Promise(resolve => { entered = resolve })
    const blocked = new Promise(resolve => { release = resolve })
    let calls = 0
    outbox = new SelectionOutbox({ call: async (_path, evidence) => {
      calls++
      if (evidence.observed_at === 1) { entered(); await blocked }
      return { sequence: evidence.observed_at, evidence, rejected: false }
    } }, profiles)
    background = outbox.tick(); await started
    let timer
    try {
      await Promise.race([outbox.record('worker', { ...params, observed_at: 2 }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('new record blocked behind old batch')), 2000) })])
    } finally { clearTimeout(timer) }
    const rows = Object.values(profiles.binding('worker').selectionOutbox)
    assert.equal(rows.find(row => row.evidence.observed_at === 2).home_reconciled, true)
    assert.equal(rows.find(row => row.evidence.observed_at === 1).home_reconciled, false)
    assert.throws(() => outbox.assertSettled('worker', operation), /reconciliation/)
    release(); await background
    outbox.assertSettled('worker', operation); assert.equal(calls, 2)
  } finally { release?.(); await background; await outbox?.close(); await rm(root, { recursive: true, force: true }) }
})
