import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
const { ClientModuleRegistry } = await import(process.env.KODE_TEST_CLIENT_MODULES ?? '@deepseek-ai/dsh-client-modules')
import { retainClientBatches } from '../src/client-asset-retention.js'

test('real batch carrier serves original bytes after multiple recompositions and Kode disposal', async () => {
  const ctx = new Context()
  ctx.provide('loader', { entries: () => [] })
  const registry = new ClientModuleRegistry(ctx)
  const url = '/plugins/??@fixture/ui/client.js&rev=old'
  const response = { contentType: 'text/javascript', body: async () => Buffer.from('original-revision') }
  registry.batchResponses.set(url, response); registry.responses.set(url, response)
  const plugin = await ctx.plugin({ inject: ['clientModules'], apply(scope) { retainClientBatches(scope.clientModules, 8) } })
  await plugin.dispose()
  try {
    for (let i = 0; i < 4; i++) registry.compose()
    const resource = await registry.fetchBundle(new Request('https://fixture.example' + url))
    assert.equal(resource.status, 200); assert.equal(await resource.text(), 'original-revision')
    const head = await registry.fetchBundle(new Request('https://fixture.example' + url, { method: 'HEAD' }))
    assert.equal(head.status, 200); assert.equal(await head.text(), '')
    assert.equal((await registry.fetchBundle(new Request('https://fixture.example/plugins/??@fixture/ui/client.js&rev=unknown'))).status, 404)
    assert.equal((await registry.fetchBundle(new Request('https://fixture.example' + url, { method: 'POST' }))).status, 405)
    for (let i = 0; i < 12; i++) {
      registry.batchResponses = new Map([[url + i, response]])
      registry.compose()
    }
    assert.equal((await registry.fetchBundle(new Request('https://fixture.example' + url))).status, 404)
  } finally { await ctx.fiber.dispose() }
})
