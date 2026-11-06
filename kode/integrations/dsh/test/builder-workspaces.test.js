import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { registerBuilderWorkspaceDirectory } from '../src/builder-workspace-directory.js'
test('workspace draft patches preserve answers, fence stale revisions and recover exact receipts after restart', { skip: !process.env.KODE_TEST_BACKEND_URL }, async () => {
  const hub = await isolatedHub('builder-workspaces')
  try {
    const root = '/api/v1/messaging', path = `${root}/superagents/drafts/draft`
    await hub.client.call(`${root}/superagents/drafts`, { id: 'draft', request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'build', workspace_refs: [], answers: { delivery: 'local' }, questions: [], proposed_team: null } })
    await hub.client.call(`${root}/workbench/workspaces`, { action: 'create', path: hub.root, title: 'Fixture workspace' })
    let route, status, result
    registerBuilderWorkspaceDirectory({ webServer: { register(value) { route = value } }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } }, { backendClient: hub.client })
    const read = query => route.handler({ method: 'GET', url: '/api/kode/builder/workspace-directory' + query }, { writeHead(code) { status = code }, end(value) { result = JSON.parse(value) } })
    await read(''); assert.equal(status, 200); assert.equal(result.hosts[0].node_id, hub.node)
    await read(`?node_id=${hub.node}`); assert.equal(status, 200)
    const { name, ...workspace } = result.workspaces.find(row => row.name === 'Fixture workspace')
    const command = { request_id: 'select', expected_revision: 1, workspace_refs: [workspace] }
    const selected = await hub.client.call(`${path}/workspaces`, command)
    assert.equal(selected.revision, 2); assert.equal(selected.eligible_for_execution, false); assert.equal(selected.interview.answers.delivery, 'local')
    assert.deepEqual(selected.interview.workspace_refs, [workspace])
    await assert.rejects(hub.client.call(`${path}/workspaces`, { ...command, workspace_refs: [] }), /identity conflict/)
    await assert.rejects(hub.client.call(`${path}/workspaces`, { ...command, request_id: 'stale' }), /revision conflict/)
    const patchStatus = request => hub.client.call(`${path}/patch-status?kind=workspaces&request_id=${request}&expected_revision=1`)
    assert.equal((await patchStatus('select')).state, 'recorded')
    assert.equal((await patchStatus('stale')).state, 'rejected_revision')
    assert.equal((await hub.client.call(`${path}/patch-status?kind=answers&request_id=future&expected_revision=2`)).state, 'unconfirmed')

    const worker = await hub.client.call(`${root}/sessions`, { session_id: 'worker', title: 'worker', runtime: 'external' })
    await assert.rejects(hub.client.forSession(worker.owner_token).call(`${path}/workspaces`, command), /403/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/workspaces`, command), selected)
    await read('?node_id=unknown'); assert.equal(status, 404)
  } finally { await hub.close() }
})
