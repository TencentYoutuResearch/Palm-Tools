/** Filesystem crash-boundary tests; synthetic receipts are not end-to-end audit proof. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialToolJournal } from '../src/official-tool-journal.js'
import { executionEvidence } from '../src/execution-evidence.js'

test('archive commits before queue removal and prevents replay after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-tool-archive-'))
  try {
    const file = join(root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    const operation = { id: 'op', attempt: 1, epoch: 1 }
    await profiles.bind('worker', 'official')
    const rows = Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`call-${i}`, { call_id: `call-${i}`, operation_id: 'op', attempt: 1, epoch: 1, tool: 'read', status: i === 0 ? 'uncertain' : 'returned', home_reconciled: i !== 1, home_sequence: i + 1 }]))
    await profiles.patchBinding('worker', { managedOperation: operation, officialTools: rows })
    const journal = new OfficialToolJournal(profiles)
    const update = profiles.update.bind(profiles)
    profiles.update = async callback => { await callback({ bindings: structuredClone(profiles.bindings) }); throw new Error('fixture queue write failure') }
    await assert.rejects(journal.compact('worker'), /queue write failure/)
    profiles.update = update
    assert.equal(Object.keys(profiles.binding('worker').officialTools).length, 140)
    await journal.compact('worker')
    const binding = profiles.binding('worker')
    assert.equal(Object.keys(binding.officialTools).length, 32)
    assert.ok(binding.officialTools['call-0']); assert.ok(binding.officialTools['call-1'])
    assert.equal(binding.officialToolArchive.count, 108)
    assert.equal((await stat(journal.archive.path('worker', 'call-2'))).mode & 0o777, 0o600)
    const reopened = await new AgentProfiles(file).open()
    const restored = new OfficialToolJournal(reopened)
    await assert.rejects(restored.begin('worker', operation, { callId: 'call-2', name: 'read' }), /archived/)
    await restored.begin('worker', operation, { callId: 'new-call', name: 'read' })
    assert.throws(() => restored.assertSettled('worker', operation), /reconciliation/)
    const view = executionEvidence(reopened.binding('worker'))
    assert.equal(view.official_tool_archive.count, 108)
    assert.ok(!JSON.stringify(view).includes(root))
    await rename(restored.archive.root, `${restored.archive.root}.missing`)
    await assert.rejects(restored.begin('worker', operation, { callId: 'newer-call', name: 'read' }))
    await assert.rejects(reopened.clearUnusedBinding('worker'), /new conversation/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
