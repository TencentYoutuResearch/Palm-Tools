import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isolatedHub } from './support/isolated-hub.js'
import { registerBuilderDefaults } from '../src/builder-defaults-route.js'
test('default-selection reads real Hub drafts and rejects concurrent edits without saving selection', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('builder-default-candidate'); let server, route, edit = false
 try {
  const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
  let draft = await call('superagents/drafts', { id: 'draft:default', request_id: 'create', expected_revision: 0, revoked: false, interview: { purpose: 'Build a team', workspace_refs: [{ host_id: hub.node, workspace_id: 'workspace', root_ref: '/fixture/project' }], questions: [], answers: {}, proposed_team: null } })
  registerBuilderDefaults({ webServer: { register: value => route = value }, connection: { admit: req => ({ peer: { principal: { kind: req.headers['x-fixture-principal'] ?? 'owner' } } }) } }, {
   backendClient: hub.client, home: hub.node,
   service: { profiles: { defaultProfileId: 'profile', list: () => [{ id: 'profile', type: 'dsh', defaultModel: 'model' }] }, hasRuntime: () => true, officialResourceDirectory: () => ({ items: [{ provider_id: 'provider', registered: true }] }) },
   llm: { listModels: async provider => [{ provider, id: 'model' }], resolveModelInfo: async (provider, id) => {
    if (edit) draft = await call('superagents/drafts', { id: 'draft:default', request_id: 'concurrent-edit', expected_revision: draft.revision, revoked: false, interview: { ...draft.interview, purpose: 'Changed scope' } })
    return { provider, id }
   } },
  })
  server = createServer((req, res) => route.handler(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const get = (revision, principal = 'owner') => fetch(`http://127.0.0.1:${server.address().port}/api/kode/builder/default-selection?draft_id=draft%3Adefault&revision=${revision}`, { headers: { 'x-fixture-principal': principal } })
  const before = await call('superagents/drafts/draft:default/selection')
  assert.equal((await get(1, 'agent')).status, 403)
  const response = await get(1); assert.equal(response.status, 200)
  const result = await response.json(); assert.equal(result.state, 'proposed'); assert.equal(result.selection.profile_id, 'profile'); assert.equal(result.eligible_for_execution, false)
  assert.deepEqual(await call('superagents/drafts/draft:default/selection'), before)
  edit = true; assert.equal((await get(1)).status, 409)
  assert.equal(draft.revision, 2); assert.deepEqual(await call('superagents/drafts/draft:default/selection'), { ...before, draft_revision: 2 })
  edit = false
  await hub.stop('SIGKILL'); await hub.start()
  assert.equal((await get(1)).status, 409); assert.equal((await get(2)).status, 200)
  assert.deepEqual((await call('teams')).items, [])
  assert.equal((await call('sessions')).sessions.length, 0)
 } finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } await hub.close() }
})
