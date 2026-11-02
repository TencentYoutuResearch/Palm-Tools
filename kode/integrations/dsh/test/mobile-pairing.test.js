import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerIntegrationApi } from '../src/integration-api.js'

function fixture(uri = 'kode://cloud-pair?server=https%3A%2F%2Fsync.example.com&pairing_id=pair_fixture&secret=fixture_secret') {
  let handler
  const calls = []
  const invite = { uri, expires_at: Date.now() + 120_000 }
  registerIntegrationApi({
    webServer: { register: route => { handler = route.handler } },
    connection: { admit: req => req.role === 'anonymous' ? { rejection: {} } : { peer: { principal: { kind: req.role } } } },
  }, { call: async (path, body) => { calls.push({ path, body }); return { ...invite } } })
  return { calls, invite, async request(role = 'owner') {
    const req = Readable.from([JSON.stringify({ action: 'pair', server_url: 'https://sync.example.com' })])
    req.method = 'POST'; req.role = role
    const headers = {}
    let payload
    const res = { setHeader: (key, value) => { headers[key] = value }, end: value => { payload = JSON.parse(value) } }
    await handler(req, res)
    return { status: res.statusCode, headers, payload }
  } }
}

test('only the host owner can generate a mobile pairing invite and QR', async () => {
  const f = fixture()
  for (const role of ['anonymous', 'guest']) {
    const result = await f.request(role)
    assert.equal(result.status, 403)
    assert.equal(result.payload.pairing, undefined)
  }
  assert.equal(f.calls.length, 0)
})

test('pairing preserves the mobile URI and expiry and returns an uncached local PNG', async () => {
  const f = fixture(), result = await f.request()
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(f.calls, [{ path: '/api/v1/messaging/cloud/pair', body: { server_url: 'https://sync.example.com' } }])
  assert.equal(result.payload.pairing.uri, f.invite.uri)
  assert.equal(result.payload.pairing.expires_at, f.invite.expires_at)
  assert.match(result.payload.pairing.qr_data_url, /^data:image\/png;base64,/)
  const png = Buffer.from(result.payload.pairing.qr_data_url.split(',')[1], 'base64')
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20))
  assert.ok(png.readUInt32BE(16) >= 280)
})

test('an invite too large for a QR still supports manual pairing', async () => {
  const f = fixture('kode://cloud-pair?secret=' + 'x'.repeat(5000))
  const result = await f.request()
  assert.equal(result.status, 200)
  assert.equal(result.payload.pairing.uri, f.invite.uri)
  assert.equal(result.payload.pairing.qr_data_url, undefined)
  assert.match(result.payload.pairing.qr_error, /配对链接/)
})
