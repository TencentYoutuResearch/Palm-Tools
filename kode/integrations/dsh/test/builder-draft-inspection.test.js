import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isolatedHub } from './support/isolated-hub.js'
import { prepareBuilderDraftInspection, registerBuilderDraftInspection } from '../src/builder-draft-inspection.js'
const path = '/api/v1/messaging/superagents/drafts'
test('Builder persists selected project observations through restart and replays exact evidence after file changes', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('builder-facts-home'), root = await mkdtemp(join(tmpdir(), 'kode-builder-facts-'))
  try {
    const registry = { list: () => [{ id:'selected', path:root }, { id:'unselected', path:root }] }
    const workspace = { host_id:hub.node, workspace_id:'selected', root_ref:root }
    const original = '\ufeff# 项目\n' + 'a'.repeat(50000)
    for (const file of ['README.md', 'CODEBUDDY.md', 'CLAUDE.md']) await writeFile(join(root,file), original)
    const first = await hub.client.call(path, { id:'draft', request_id:'start', expected_revision:0, revoked:false,
      interview:{ purpose:'Project delivery', workspace_refs:[workspace], answers:{}, questions:[], proposed_team:null } })
    const input = { draft_id:'draft', request_id:'capture', expected_revision:first.revision, workspace_id:'selected', paths:['README.md','CODEBUDDY.md','CLAUDE.md','Cargo.toml'] }
    await assert.rejects(prepareBuilderDraftInspection(hub.client, registry, { ...input, workspace_id:'unselected' }), /not selected/)
    const prepared = await prepareBuilderDraftInspection(hub.client, registry, input)
    assert.equal((await hub.client.call(`${path}/draft`)).revision, 1, 'preparation alone writes nothing')
    const row = await hub.client.call(path, prepared.command)
    assert.equal(row.revision, 2)
    assert.equal(row.interview.inspections[0].facts.find(f => f.path === 'README.md').content, original)
    assert.equal(row.interview.inspections[0].facts.find(f => f.path === 'Cargo.toml').status, 'missing')
    await writeFile(join(root,'README.md'), '# Changed after capture')
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(`${path}/draft`), row)
    assert.deepEqual(await hub.client.call(path, prepared.command), row, 'ambiguous submission retry must reuse original bytes')
    assert.deepEqual((await hub.client.call(`${path}/draft/commands/capture`)).receipt, row)
    assert.equal((await hub.client.call(`${path}/draft/commands/unknown`)).receipt, null)
    const changed = await prepareBuilderDraftInspection(hub.client, registry, { ...input, expected_revision:2, request_id:'refresh', paths:['README.md'] })
    assert.equal(changed.command.interview.inspections[0].facts.length, 4, 'partial refresh retains other dated observations')
    const refreshed = await hub.client.call(path, changed.command)
    assert.equal(refreshed.interview.inspections[0].facts.find(f => f.path === 'README.md').content, '# Changed after capture')
    assert.deepEqual((await hub.client.call(`${path}/draft/commands/capture`)).receipt, row, 'history stays immutable after refresh')
    for (const mutate of [
      v => { v.interview.inspections[0].workspace.workspace_id = 'unselected' },
      v => { v.interview.inspections[0].facts.find(f => f.status === 'observed').sha256 = '0'.repeat(64) },
      v => { v.interview.inspections[0].facts.find(f => f.status === 'missing').content = 'invented' },
      v => { v.interview.inspections[0].facts[0].path = '../README.md' },
      v => { v.interview.inspections[0].facts.find(f => f.status === 'observed').trust = 'trusted' },
    ]) {
      const bad = structuredClone(changed.command); bad.expected_revision=3; bad.request_id='bad'; mutate(bad)
      await assert.rejects(hub.client.call(path,bad), /400|422/)
    }
    const worker = await hub.client.call('/api/v1/messaging/sessions', { session_id:'worker', title:'Worker', runtime:'external' })
    await assert.rejects(hub.client.forSession(worker.owner_token).call(`${path}/draft/commands/capture`), /403/)
    assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items, [])
  } finally { await hub.close(); await rm(root,{recursive:true,force:true}) }
})

test('draft inspection preparation route rejects non-owner before any backend or filesystem read', async () => {
  let route, status
  registerBuilderDraftInspection({ webServer:{register:r=>{route=r}}, connection:{admit:()=>({peer:{principal:{kind:'worker'}}})}, get:()=>assert.fail('must not read registry') }, {})
  await route.handler({method:'POST'}, {writeHead:s=>{status=s}, end:()=>{}})
  assert.equal(status,403)
})
