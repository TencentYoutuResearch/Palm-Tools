/** Durable ledger recovery; actual AgentLoop creation is covered in official-loop.test.js. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfiles } from '../src/agent-profiles.js'
import { OfficialDispatch } from '../src/official-dispatch.js'
import { OFFICIAL_BUILDER_TOOLS } from '../src/official-builder-tools.js'

for (const {home,builder} of [{home:undefined},{home:'home'},{home:undefined,builder:true}]) test(`official dispatch persists ambiguous effects and never recreates on retry or ledger reopen (home=${home}, builder=${!!builder})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-dispatch-'))
  try {
    const path = join(root, 'profiles.json'), profiles = await new AgentProfiles(path).open([{ id: 'official', type: 'dsh', name: 'Official' }])
    await profiles.bind('worker', 'official')
    const operation = { id: 'operation', attempt: 1, epoch: 1, ...(home ? { home_node: home } : {}) }
    await profiles.patchBinding('worker', { managedOperation: operation })
    let calls = 0
    const host = { execution: { profiles }, stop: new AbortController(), create: async () => { calls++; throw new Error('lost creation result') } }
    const ledger = new OfficialDispatch(host)
    const command = { command_id: 'create', session_id: 'worker', operation, profile_revision: profiles.binding('worker').revision,
      provider: 'fixture', model: 'model', cwd: root, tools: builder ? [...OFFICIAL_BUILDER_TOOLS] : [],
      ...(builder ? {builder:{draft_id:'draft',team_id:'candidate'}} : {}) }
    await assert.rejects(ledger.dispatch({ ...command, operation: { ...operation, epoch: 2 } }), /binding mismatch/)
    await assert.rejects(ledger.dispatch({ ...command, operation: { ...operation, home_node: 'foreign' } }), /binding mismatch/)
    assert.equal(calls, 0)
    await assert.rejects(ledger.dispatch(command), /lost creation result/)
    const saved = await ledger.dispatch(command)
    assert.equal(saved.state, 'uncertain'); assert.equal(calls, 1)
    await assert.rejects(ledger.dispatch({ ...command, command_id: 'replacement' }), /already has a creation command/)
    assert.equal(calls, 1)
    const reopened = await new AgentProfiles(path).open()
    const recovered = new OfficialDispatch({ ...host, execution: { profiles: reopened } })
    assert.deepEqual(await recovered.dispatch(command), saved); assert.equal(calls, 1)
    if (builder) {
      assert.deepEqual(saved.request.builder, command.builder)
      await assert.rejects(recovered.dispatch({...command,builder:{draft_id:'different',team_id:'candidate'}}), /identity conflict/)
      await assert.rejects(recovered.dispatch({...command,builder:{draft_id:'draft',team_id:'different'}}), /identity conflict/)
      assert.throws(()=>recovered.dispatch({...command,tools:[]}), /Builder dispatch/)
      assert.throws(()=>recovered.dispatch({...command,builder:{...command.builder,activate:true}}), /Builder dispatch/)
      assert.equal(calls,1)
    }
    await assert.rejects(recovered.dispatch({ ...command, cwd: '/different' }), /identity conflict/)
    // A crash after durable intent but before completion has no terminal receipt.
    await reopened.update(state => { state.bindings.worker.officialDispatch.create.state = 'creating' })
    assert.equal(recovered.get('worker', 'create').state, 'uncertain')
    assert.equal((await recovered.dispatch(command)).state, 'uncertain'); assert.equal(calls, 1)
    let closed = 0
    const header = { id: 'worker', cwd: '/wrong', isSeeded: false }
    recovered.host.ctx = { get: () => ({ open: async (_id, access) => {
      assert.equal(access, 'read')
      return { header, read: async () => ({ events: [{ seq: 0, type: 'plugin:kode/official-creation', ignorable: true, data: { command_id: 'create', fingerprint: 'wrong' } }] }),
        close: async () => { closed++ } }
    } }) }
    assert.equal((await recovered.reconcile('worker', 'create')).reconciliation, 'session_identity_mismatch')
    header.cwd = root
    assert.equal((await recovered.reconcile('worker', 'create')).reconciliation, 'creation_evidence_missing_or_mismatched')
    assert.equal(closed, 2)
    assert.equal(reopened.binding('worker').officialDispatch.create.state, 'creating')
    assert.throws(() => recovered.dispatch({ ...command, shell: 'unexpected' }), /Invalid/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
