import test from 'node:test'
import assert from 'node:assert/strict'
import { registerMemoryApi } from '../src/memory-api.js'

function fixture(call) {
  let handler, owner = true
  registerMemoryApi({
    webServer: { register(route) { handler = route.handler; return () => {} } },
    connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'session' } } }) },
  }, { call })
  return {
    setOwner(value) { owner = value },
    async request({ method = 'GET', query = '', body = null } = {}) {
      let status = 200, text = ''
      const headers = {}
      const chunks = body == null ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]
      const req = {
        method,
        url: '/api/kode/memory' + query,
        async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
      }
      const res = {
        set statusCode(code) { status = code },
        get statusCode() { return status },
        setHeader(k, v) { headers[k.toLowerCase()] = v },
        end(v) { text = v },
      }
      await handler(req, res)
      return { status, body: JSON.parse(text), headers }
    },
  }
}

test('memory api is owner-only and validates ids and actions before contacting backend', async () => {
  const calls = []
  const api = fixture(async (path, body) => { calls.push({ path, body }); return { ok: true } })

  api.setOwner(false)
  assert.equal((await api.request()).status, 403)
  assert.equal(calls.length, 0)

  api.setOwner(true)
  assert.equal((await api.request({ method: 'DELETE' })).status, 405)
  assert.equal((await api.request({ query: '?view=unknown' })).status, 400)
  assert.equal((await api.request({ method: 'POST', body: { action: 'review', id: '../bad', verdict: { kind: 'approve' } } })).status, 400)
  assert.equal((await api.request({ method: 'POST', body: { action: 'deprecate', id: 'bad/id', reason: 'x' } })).status, 400)
  assert.equal((await api.request({ method: 'POST', body: { action: 'unknown' } })).status, 400)
  assert.equal(calls.length, 0)
})

test('memory api proxies pending, facts, review, and deprecate requests to backend', async () => {
  const calls = []
  const api = fixture(async (path, body) => {
    calls.push({ path, body })
    if (path.includes('/pending') && !body) return { pending: [{ id: '01TEST' }], stats: { pending: 1, facts: 2 }, max_energy: 15 }
    if (path.includes('/facts?')) return { facts: [{ id: '01FACT' }], scopes: ['shared'], total: 1 }
    if (path.includes('/review')) return { outcome: 'approved', author_energy: 15, max_energy: 15, remaining_pending: 0 }
    return { ok: true }
  })

  const pending = await api.request()
  assert.equal(pending.status, 200)
  assert.equal(pending.headers['cache-control'], 'no-store')
  assert.equal(pending.body.stats.pending, 1)

  const facts = await api.request({ query: '?view=facts&q=uart&scope=shared&limit=20' })
  assert.equal(facts.status, 200)
  assert.equal(calls[1].path, '/api/v1/messaging/memory/facts?q=uart&scope=shared&limit=20')

  const review = await api.request({
    method: 'POST',
    body: { action: 'review', id: '01TEST', verdict: { kind: 'approve' } },
  })
  assert.equal(review.status, 200)
  assert.equal(review.body.outcome, 'approved')
  assert.equal(calls[2].path, '/api/v1/messaging/memory/pending/01TEST/review')
  assert.deepEqual(calls[2].body, { verdict: { kind: 'approve' } })

  const dep = await api.request({
    method: 'POST',
    body: { action: 'deprecate', id: '01FACT', reason: 'outdated' },
  })
  assert.equal(dep.status, 200)
  assert.equal(calls[3].path, '/api/v1/messaging/memory/facts/01FACT/deprecate')
  assert.deepEqual(calls[3].body, { reason: 'outdated' })
})

test('memory api surfaces 503 when remote Kode backend is older and lacks review routes', async () => {
  const api = fixture(async () => {
    throw Object.assign(new Error('not found'), { status: 404 })
  })
  const res = await api.request()
  assert.equal(res.status, 503)
  assert.equal(res.body.code, 'KODE_SERVICE_UPDATE_REQUIRED')
})
