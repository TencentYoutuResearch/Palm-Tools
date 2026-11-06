import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerBuilderDefaults } from '../src/builder-defaults-route.js'
for(const native of [false,true])test(`owner ${native?'native':'dsh'} default proposal is read-only, identity-bound and refuses changing metadata`, async () => {
 let route, reads = 0, models = 0, mutate = false, changed = false, principal = 'owner'
 const draft = { id: 'draft', home_hub: 'home', revision: 1, status: 'draft', interview: { workspace_refs: [{ host_id: 'home', workspace_id: 'workspace' }] } }
 registerBuilderDefaults({ webServer: { register: value => route = value }, connection: { admit: () => ({ peer: { principal: { kind: principal } } }) } }, {
  home: 'home', backendClient: { call: async (path, body) => { assert.equal(body, undefined); assert.equal(path, '/api/v1/messaging/superagents/drafts/draft'); reads++; return structuredClone(draft) } },
  service: { profiles: { defaultProfileId: 'profile', list: () => [{ id: 'profile',
   ...(native?{type:'codex',managedInference:{roles:['builder'],endpoint:'https://example.com/responses'},env:{PRIVATE_FIXTURE:'never-project'}}:{type:'dsh'}),
   defaultModel: changed ? 'different' : 'model' }] }, hasRuntime: () => true,
   officialResourceDirectory: () => ({ items: [{ provider_id: native?'kode-workflow-profile':'provider', registered: true }] }) },
  llm: { listModels: async provider => { models++; return [{ provider, id: 'model' }] }, resolveModelInfo: async (provider, id) => { if (mutate) changed = true; return { provider, id } } },
 })
 const get = async (url = '/?draft_id=draft&revision=1', method = 'GET') => { let status, result; const req = Readable.from([]); req.url = url; req.method = method; await route.handler(req, { writeHead: value => status = value, end: value => result = JSON.parse(value) }); return { status, result } }
 let response = await get(); assert.equal(response.status, 200); assert.equal(response.result.state, 'proposed'); assert.equal(response.result.eligible_for_execution, false); assert.equal(reads, 2)
 assert.equal(response.result.selection.provider,native?'kode-workflow-profile':'provider')
 assert.doesNotMatch(JSON.stringify(response.result),/PRIVATE_FIXTURE|never-project|endpoint/)
 principal = 'agent'; assert.equal((await get()).status, 403); assert.equal(models, 1)
 principal = 'owner'; assert.equal((await get('/?draft_id=draft&revision=1&revision=2')).status, 400)
 assert.equal((await get(undefined, 'POST')).status, 405)
 assert.equal((await get('/?draft_id=draft&revision=2')).status, 409)
 mutate = true; assert.equal((await get()).status, 409)
 changed = false; mutate = false; draft.home_hub = 'foreign'; assert.equal((await get()).status, 409)
})

test('default lookup rejects a concurrent preference change and times out without writing', async () => {
 let route, resolveLookup, reads = 0
 const preferences = { provider: 'provider', model: 'model', effort: null }
 const draft = { id: 'draft', home_hub: 'home', revision: 1, status: 'draft', interview: { workspace_refs: [{ host_id: 'home', workspace_id: 'workspace' }] } }
 const context = { webServer: { register: value => route = value }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } }
 const config = {
  home: 'home', defaults: () => preferences, timeoutMs: 1000,
  backendClient: { call: async (_, body) => { assert.equal(body, undefined); reads++; return structuredClone(draft) } },
  service: { profiles: { list: () => [{ id: 'profile', type: 'dsh' }] }, hasRuntime: () => true, officialResourceDirectory: () => ({ items: [{ provider_id: 'provider', registered: true }] }) },
  llm: { listModels: () => new Promise(resolve => { resolveLookup = resolve }), resolveModelInfo: async (provider, id) => ({ provider, id }) },
 }
 const get = async () => { let status, result; await route.handler({ method: 'GET', url: '/?draft_id=draft&revision=1' }, { writeHead: value => status = value, end: value => result = JSON.parse(value) }); return { status, result } }
 registerBuilderDefaults(context, config)
 const pending = get()
 await new Promise(resolve => setImmediate(resolve))
 preferences.model = 'changed'
 resolveLookup([{ provider: 'provider', id: 'model' }])
 assert.equal((await pending).status, 409, 'mutable preference objects must be compared against a cloned snapshot')
 assert.equal(reads, 2)
 preferences.model = 'model'
 registerBuilderDefaults(context, { ...config, timeoutMs: 10 })
 const timeout = await get()
 assert.equal(timeout.status, 409); assert.equal(timeout.result.eligible_for_execution, false)
 resolveLookup([{ provider: 'provider', id: 'model' }])
 await new Promise(resolve => setImmediate(resolve))
})
