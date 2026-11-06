import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRemoteSession, registerCreationCapabilities, CREATION_CAPABILITIES_PATH, MODEL_SELECTION_FEATURE } from '../src/creation-capabilities.js'

test('remote explicit selection probes before side effects and legacy creation remains usable', async t => {
  let capability = null, posts = 0, lastInput
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.cookie, 'fixture=owner')
    res.setHeader('content-type', 'application/json')
    if (req.url === CREATION_CAPABILITIES_PATH) {
      res.statusCode = capability === null ? 404 : 200
      res.end(JSON.stringify(capability)); return
    }
    posts++
    let body = ''; for await (const chunk of req) body += chunk
    lastInput = JSON.parse(body)
    res.end(JSON.stringify({ session_id: 'fixture-worker', selection: { model: lastInput.model, verification: 'requested' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(createRemoteSession(url, 'fixture=owner', { model: 'small' }), /cannot verify/)
  assert.equal(posts, 0)
  capability = { version: 1, features: [] }
  await assert.rejects(createRemoteSession(url, 'fixture=owner', { reasoningEffort: 'high' }), /does not support/)
  assert.equal(posts, 0)
  await createRemoteSession(url, 'fixture=owner', { title: 'Legacy' })
  assert.equal(posts, 1)
  capability = { version: 1, features: [MODEL_SELECTION_FEATURE] }
  const input = { model: 'small', reasoningEffort: 'high', idempotency_key: 'stable' }
  const result = await createRemoteSession(url, 'fixture=owner', input)
  assert.deepEqual(lastInput, input)
  assert.equal(result.selection.verification, 'requested')
  assert.equal(posts, 2)
  capability = null // Recheck after downgrade; no stale capability cache.
  await assert.rejects(createRemoteSession(url, 'fixture=owner', input), /cannot verify/)
  assert.equal(posts, 2)
})

test('creation capability endpoint is owner-only and unavailable without creator', async () => {
  let handler, owner = false, available = true
  registerCreationCapabilities({ webServer: { register: route => { handler = route.handler } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'session' } } }) }, get: () => available ? {} : undefined })
  const request = async method => {
    let status, body
    await handler({ method }, { writeHead: value => { status = value }, end: value => { body = JSON.parse(value) } })
    return { status, body }
  }
  assert.equal((await request('GET')).status, 403)
  owner = true
  assert.equal((await request('POST')).status, 405)
  assert.deepEqual((await request('GET')).body.features, [MODEL_SELECTION_FEATURE])
  available = false
  assert.equal((await request('GET')).status, 503)
})
