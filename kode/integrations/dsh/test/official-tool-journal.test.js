import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialToolJournal } from '../src/official-tool-journal.js'
import { executionEvidence } from '../src/execution-evidence.js'

test('tool evidence survives reopen, refuses replay and never stores raw payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-tool-journal-'))
  try {
    const file = join(root, 'profiles.json')
    const profiles = await new AgentProfiles(file).open([{ id: 'official', name: 'Fixture', type: 'dsh' }])
    const operation = { id: 'op', attempt: 1, epoch: 1, home_node: 'home' }
    await profiles.bind('worker', 'official'); await profiles.patchBinding('worker', { managedOperation: operation })
    const journal = new OfficialToolJournal(profiles)
    const request = { callId: 'tool-1', name: 'write', arguments: { fixture: 'private-payload-marker' } }
    await journal.begin('worker', operation, request)
    assert.throws(() => journal.assertSettled('worker', operation), /requires reconciliation/)
    await assert.rejects(journal.begin('worker', operation, request), /already recorded/)
    await assert.rejects(journal.begin('worker', { ...operation, attempt: 2 }, { ...request, callId: 'other' }), /operation changed/)
    const reopened = await new AgentProfiles(file).open()
    const recovery = new OfficialToolJournal(reopened)
    await recovery.recover()
    const evidence = executionEvidence(reopened.binding('worker')).official_tools
    assert.equal(evidence[0].status, 'uncertain'); assert.equal(evidence[0].reason, 'host_restarted')
    assert.equal(evidence[0].home_node, 'home'); assert.equal(evidence[0].home_reconciled, false)
    await assert.rejects(recovery.begin('worker', operation, request), /already recorded/)
    await recovery.begin('worker', operation, { ...request, callId: 'tool-2' })
    await recovery.end('worker', 'tool-2', 'returned', 'tool_returned',{content:'private-result-marker'})
    const hashes=reopened.binding('worker').officialTools['tool-2'].io
    assert.match(hashes.input.sha256,/^[a-f0-9]{64}$/);assert.match(hashes.output.sha256,/^[a-f0-9]{64}$/)
    assert.notEqual(hashes.input.sha256,hashes.output.sha256)
    assert.ok(!(await readFile(file,'utf8')).includes('private-result-marker'))
    assert.throws(() => recovery.assertSettled('worker', operation), /requires reconciliation/)
    assert.ok(!(await readFile(file, 'utf8')).includes('private-payload-marker'))
    await recovery.begin('worker',operation,{...request,callId:'tool-undefined'})
    await recovery.end('worker','tool-undefined','returned','tool_returned',undefined)
    assert.equal(reopened.binding('worker').officialTools['tool-undefined'].io.output.encoding,'js_undefined')
    assert.equal(reopened.binding('worker').officialTools['tool-1'].io.output,null,'restart without a result must stay unobserved')
    await assert.rejects(reopened.clearUnusedBinding('worker'), /new conversation/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
