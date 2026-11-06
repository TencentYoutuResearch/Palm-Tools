import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { BALANCE_ENDPOINTS, parseProviderBalance, ProviderBalanceCollector } from '../src/provider-balances.js'
const at = Date.UTC(2026, 10, 2, 12)
const deepseek = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] }
const key = { data: { label: 'private-label', limit: 10, limit_remaining: 4, usage: 26, limit_reset: 'monthly', include_byok_in_limit: false,
  budgets: [{ budget_id: 'budget', scope: 'member', include_byok: false, limit_usd: 5, remaining_usd: 0, spend_usd: 5, resets_at: '2026-11-03T00:00:00.000Z' }],
  free_model_daily_requests: { limit: 50, remaining: 0, used: 50 } } }

test('provider facts keep currencies, key caps, organization budgets and credits distinct', () => {
  const ds = parseProviderBalance('deepseek_balance', deepseek, at)
  assert.equal(ds.limits[0].remaining, '110.00'); assert.equal(ds.limits[0].unit, 'cny')
  assert.equal(ds.provider_available, true)
  const mixed = structuredClone(deepseek); mixed.balance_infos.push({ currency: 'USD', total_balance: '0', granted_balance: '0', topped_up_balance: '0' })
  assert.equal(parseProviderBalance('deepseek_balance', mixed, at).limits.length, 2)
  const or = parseProviderBalance('openrouter_key', key, at)
  assert.equal(or.limits[0].kind, 'key_cap'); assert.equal(or.limits[0].used, '26'); assert.equal(or.limits[0].remaining, '4')
  assert.equal(or.limits[0].usage_scope, 'all_time')
  assert.equal(or.limits[0].resets_at_ms, Date.UTC(2026, 11, 1))
  assert.equal(or.limits[1].kind, 'organization_budget'); assert.equal(or.limits[1].reached, true)
  assert.equal(or.limits[2].scope, 'free_models'); assert.equal(or.limits[2].reached, true)
  assert.ok(!JSON.stringify(or).includes('private-label'))
  const credits = parseProviderBalance('openrouter_credits', { data: { total_credits: 0.3, total_usage: 0.2 } }, at)
  assert.equal(credits.limits[0].remaining, '0.100000000000'); assert.equal(credits.limits[0].quality, 'derived')
  assert.equal(credits.limits[0].scope, 'account')
})

test('missing values, duplicate scopes, expiration and null limits are explicit', () => {
  const unlimited = structuredClone(key); unlimited.data.limit = null; unlimited.data.limit_remaining = null
  const sample = parseProviderBalance('openrouter_key', unlimited, at)
  assert.equal(sample.limits[0].unlimited, true); assert.equal(sample.limits[0].remaining, null)
  const missing = structuredClone(key); delete missing.data.limit_remaining
  assert.throws(() => parseProviderBalance('openrouter_key', missing, at), /invalid_provider_balance/)
  const duplicate = structuredClone(deepseek); duplicate.balance_infos.push(duplicate.balance_infos[0])
  assert.throws(() => parseProviderBalance('deepseek_balance', duplicate, at))
  assert.throws(() => parseProviderBalance('deepseek_balance', { ...deepseek, balance_infos: [{ ...deepseek.balance_infos[0], total_balance: 'NaN' }] }, at))
  const expiring = structuredClone(key); expiring.data.expires_at = new Date(at + 1000).toISOString()
  assert.equal(parseProviderBalance('openrouter_key', expiring, at).valid_until_ms, at + 1000)
  expiring.data.expires_at = new Date(at - 1).toISOString()
  assert.equal(parseProviderBalance('openrouter_key', expiring, at).provider_available, false)
})

test('HTTP collector uses only selected GET endpoint, bounds response and backs off without raw errors', async () => {
  let status = 200, payload = JSON.stringify(deepseek), reads = 0, observed = at
  const server = createServer((req, res) => { reads++; assert.equal(req.method, 'GET'); res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '60' }); res.end(payload) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const urls = []
  // Only the HTTP transport is redirected to an owned fixture; no credential is used.
  const transport = async (url, options) => {
    urls.push(url); assert.equal(options.redirect, 'error')
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, options)
    return new Response(response.body, { status: response.status, headers: response.headers })
  }
  const collector = new ProviderBalanceCollector({ source: 'deepseek_balance', authorizedFetch: transport, clock: () => observed })
  try {
    const [a, b] = await Promise.all([collector.poll(), collector.poll()])
    assert.deepEqual(a, b); assert.equal(a.status, 'reported'); assert.equal(reads, 1)
    assert.equal((await collector.poll()).status, 'backoff')
    observed += 60001; status = 401; payload = 'provider-private-error'
    const failure = await collector.poll()
    assert.equal(failure.status, 'authentication_unavailable'); assert.ok(!JSON.stringify(failure).includes(payload)); assert.equal(failure.sample, undefined)
    observed += 60001; status = 429
    assert.equal((await collector.poll()).status, 'rate_limited')
    observed += 60001; status = 200; payload = 'x'.repeat(65537)
    assert.equal((await collector.poll()).status, 'unavailable')
    assert.ok(urls.every(url => url === BALANCE_ENDPOINTS.deepseek_balance))
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('pre-cancelled collection makes no request and thrown transport details are never returned', async () => {
  let reads = 0
  const collector = new ProviderBalanceCollector({ source: 'openrouter_key', authorizedFetch: async () => { reads++; throw new Error('private-transport-error') } })
  const result = await collector.poll(AbortSignal.abort())
  assert.equal(result.status, 'cancelled_or_timed_out'); assert.equal(reads, 0)
  const other = new ProviderBalanceCollector({ source: 'openrouter_key', authorizedFetch: async () => { throw new Error('private-transport-error') } })
  assert.ok(!JSON.stringify(await other.poll()).includes('private-transport-error'))
})
