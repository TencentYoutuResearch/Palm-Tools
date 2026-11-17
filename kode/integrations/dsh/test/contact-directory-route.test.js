import test from 'node:test'
import assert from 'node:assert/strict'
import { handleContactDirectory } from '../src/contact-directory-route.js'

async function request(params, { method = 'GET', result = { home_hub: 'backend-authority', items: [] } } = {}) {
  const calls = []
  let status, body
  const handled = await handleContactDirectory({ method, url: `/?${params}`, headers: {} }, {
    writeHead(value) { status = value }, end(value) { body = JSON.parse(value) },
  }, { async call(path) { calls.push(path); return result } })
  return { handled, status, body, calls }
}
const scope = { workspace_host: 'execution-host', workspace_id: 'project', workspace_root: '/work/掌 & project' }

test('contact route forwards exact complete workspace scope and trusts backend Home', async () => {
  const page = await request(new URLSearchParams({ view: 'contacts', ...scope, limit: '1' }))
  assert.equal(page.status, 200)
  assert.equal(page.body.home_hub, 'backend-authority')
  const query = new URL(page.calls[0], 'http://fixture').searchParams
  for (const [key, value] of Object.entries(scope)) assert.equal(query.get(key), value)
  assert.equal(query.get('limit'), '1')
  const global = await request('view=contacts')
  assert.equal(global.status, 200)
  assert.equal(global.calls[0], '/api/v1/messaging/contact-directory?after=&limit=25&q=&archived=false')
})

test('contact route rejects partial, malformed, oversized or duplicate scope before bridge access', async () => {
  for (const invalid of [
    { workspace_host: 'host' }, { workspace_id: 'id', workspace_root: '/root' },
    { ...scope, workspace_host: '' }, { ...scope, workspace_host: 'h\0' }, { ...scope, workspace_host: 'host\n' },
    { ...scope, workspace_host: 'h'.repeat(161) }, { ...scope, workspace_id: 'bad/id' },
    { ...scope, workspace_root: '' }, { ...scope, workspace_root: '  ' },
    { ...scope, workspace_root: '/root\0' }, { ...scope, workspace_root: '掌'.repeat(342) },
  ]) {
    const page = await request(new URLSearchParams({ view: 'contacts', ...invalid }))
    assert.equal(page.status, 400, JSON.stringify(invalid))
    assert.deepEqual(page.calls, [])
  }
  for (const query of ['view=contacts&workspace_host=h&workspace_host=h', 'view=contacts&unknown=x', 'view=contact-preference&team_id=t&workspace_host=h']) {
    const page = await request(query)
    assert.equal(page.status, 400)
    assert.deepEqual(page.calls, [])
  }
})

test('scoped cursor transport permits bounded encoded roots without changing global cursor limit', async () => {
  const after = 'a'.repeat(10000)
  assert.equal((await request(new URLSearchParams({ view: 'contacts', ...scope, after }))).status, 200)
  assert.equal((await request(new URLSearchParams({ view: 'contacts', after }))).status, 400)
  assert.equal((await request(new URLSearchParams({ view: 'contacts', ...scope, after: 'a'.repeat(16385) }))).status, 400)
  assert.equal((await request(new URLSearchParams({ view: 'contacts', ...scope, after: 'invalid!' }))).status, 400)
})
