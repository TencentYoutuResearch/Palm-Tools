import test from 'node:test'
import assert from 'node:assert/strict'
import { registerBuilderModels } from '../src/builder-models-route.js'
test('Builder model discovery is owner scoped, exact route and public metadata only', async () => {
  let route, status, body, kind = 'worker', calls = 0, failure = false
  let providers = [{ id: 'fixture', name: 'Fixture' }]
  const llm = {
    listProviders: () => providers,
    async listModels(provider) { calls++; if (failure) throw Error('private diagnostic'); return [{ provider, id: 'model', name: 'Model', private: 'do-not-export' }] },
    async resolveModelInfo(provider, model) { calls++; return { provider, id: model, name: 'Model', reasoning: { efforts: [{ id: 'custom', name: 'Custom', private: 'do-not-export' }], defaultEffort: 'custom' }, private: 'do-not-export' } },
  }
  registerBuilderModels({ webServer: { register(value) { route = value } }, connection: { admit: () => ({ peer: { principal: { kind } } }) } }, llm, 'home')
  const read = (query, method = 'GET') => route.handler({ method, url: '/api/kode/builder/models' + query }, { writeHead(code, headers) { status = code; assert.equal(headers['cache-control'], 'no-store') }, end(value) { body = JSON.parse(value) } })
  await read('?provider=fixture'); assert.equal(status, 403); kind = 'owner'
  for (const query of ['', '?provider=fixture&provider=fixture', '?provider=fixture&model=', '?provider=fixture&token=x']) { await read(query); assert.equal(status, 400) }
  await read('?provider=missing'); assert.equal(status, 404)
  await read('?provider=fixture', 'POST'); assert.equal(status, 405); assert.equal(calls, 0)
  await read('?provider=fixture'); assert.equal(status, 200); assert.equal(body.eligible_for_dispatch, false); assert.equal(body.items[0].private, undefined)
  await read('?provider=fixture&model=model'); assert.equal(status, 200)
  assert.deepEqual(body.item.reasoning, { efforts: [{ id: 'custom', name: 'Custom' }], default_effort: 'custom' })
  assert.ok(!JSON.stringify(body).includes('do-not-export'))
  failure = true; await read('?provider=fixture'); assert.equal(status, 503); assert.deepEqual(body, { error: 'Model metadata unavailable' })
  failure = false; llm.listModels = async provider => { providers = []; return [{ provider, id: 'model', name: 'Model' }] }
  await read('?provider=fixture'); assert.equal(status, 404, 'removed provider cannot return a stale catalog')
})
