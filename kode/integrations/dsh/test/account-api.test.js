import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { registerAccountApi } from '../src/account-api.js'

function fixture(responder) {
  const routes = new Map()
  const calls = []
  registerAccountApi({
    webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    connection: { admit: req => req.role === 'anonymous' ? { rejection: {} } : { peer: { principal: { kind: req.role } } } },
  }, {
    call: async (path, body) => {
      calls.push({ path, body })
      return responder ? responder(path, body) : { ok: true }
    },
  })

  async function request(url, { method = 'GET', body, role = 'owner' } = {}) {
    const handler = url.startsWith('/api/kode/devices') ? routes.get('/api/kode/devices') : routes.get('/api/kode/account')
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
    req.method = method
    req.url = url
    req.role = role
    const headers = {}
    let payload
    const res = {
      statusCode: 200,
      setHeader: (key, value) => { headers[key] = value },
      end: value => { payload = JSON.parse(value) },
    }
    await handler(req, res)
    return { status: res.statusCode, headers, payload }
  }

  return { calls, request }
}

test('only host owners can access Kode account and device APIs', async () => {
  const f = fixture()
  for (const role of ['anonymous', 'guest']) {
    const a = await f.request('/api/kode/account/status', { role })
    const d = await f.request('/api/kode/devices', { method: 'POST', body: { action: 'devices' }, role })
    assert.equal(a.status, 403)
    assert.equal(d.status, 403)
  }
  assert.equal(f.calls.length, 0)
})

test('account proxy forwards status, email code, palmx QR, and sign out', async () => {
  const f = fixture(path => {
    if (path.endsWith('/palmx/start')) return { state: 'pending', qr_payload: 'https://palmx.example/qr/123', expires_at: 999, done: false }
    if (path.endsWith('/cloud/status')) return { state: 'standby', connected: true, account_email: 'a@example.com', backends: [] }
    return { ok: true }
  })

  const status = await f.request('/api/kode/account/status')
  assert.equal(status.status, 200)
  assert.equal(status.payload.account_email, 'a@example.com')

  const code = await f.request('/api/kode/account', {
    method: 'POST',
    body: { action: 'code', server_url: 'https://relay.example.com', email: 'a@example.com' },
  })
  assert.equal(code.status, 200)
  assert.deepEqual(f.calls[1], {
    path: '/api/v1/messaging/cloud/account/code',
    body: { server_url: 'https://relay.example.com', email: 'a@example.com' },
  })

  const qr = await f.request('/api/kode/account', {
    method: 'POST',
    body: { action: 'palmx_start', server_url: 'https://relay.example.com', purpose: 'sign_in' },
  })
  assert.equal(qr.status, 200)
  assert.match(qr.payload.qr_data_url, /^data:image\/png;base64,/)

  const defRelay = await f.request('/api/kode/account', {
    method: 'POST',
    body: { action: 'default_relay' },
  })
  assert.equal(defRelay.status, 200)
  assert.equal(f.calls.at(-1).path, '/api/v1/messaging/cloud/account/default_relay')

  const palmSignIn = await f.request('/api/kode/account', {
    method: 'POST',
    body: { action: 'palm_sign_in', server_url: 'https://relay.example.com', handoff_code: 'abc' },
  })
  assert.equal(palmSignIn.status, 200)
  assert.equal(f.calls.at(-1).path, '/api/v1/messaging/cloud/account/palm/sign_in')
})

test('devices proxy forwards devices, sessions, history, and commands', async () => {
  const f = fixture(() => ({
    self_device_id: 'dev-local',
    devices: [
      { device_id: 'dev-local', name: 'Office Mac', online: true },
      { device_id: 'dev-remote', name: 'Studio Mac', online: true },
    ],
  }))

  const list = await f.request('/api/kode/devices', {
    method: 'POST',
    body: { action: 'devices' },
  })
  assert.equal(list.status, 200)
  assert.equal(list.payload.self_device_id, 'dev-local')
  assert.equal(list.payload.devices.length, 2)

  await f.request('/api/kode/devices', {
    method: 'POST',
    body: { action: 'command', device_id: 'dev-remote', session_id: 7, op: 'input', body: { text: 'hi' } },
  })
  assert.deepEqual(f.calls[1], {
    path: '/api/v1/messaging/cloud/account/devices',
    body: { action: 'command', device_id: 'dev-remote', session_id: 7, op: 'input', body: { text: 'hi' } },
  })
})
