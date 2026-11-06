import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
import { registerTeamCapabilityUpdate } from '../src/team-capability-update-route.js'
import { prepareCapabilityUpdate, confirmCapabilityUpdate, requestCapabilityUpdate } from '../packages/collab/team-capability-update.js'

test('owner HTTP capability confirmation recovers committed lost response by exact receipt', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
 const hub = await isolatedHub('capability-recovery'), originalFetch = globalThis.fetch
 let server
 try {
  const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
  const team = await conversationTeam(hub), policy = await call('team-policies/schedule'), profile = await call('capability-profiles/capability/1')
  const at = Date.now(), assessments = { fit: { evaluation: { kind: 'task_fit', tag: 'inspection', score: 90 }, source: 'user', confidence: 1, evidence: [], updated_at: at, valid_until: at + 60000, pinned: false } }
  const prepared = prepareCapabilityUpdate({ team, policy, profile, targetId: 'control', assessments, replacePins: false, requestId: 'confirmed' })
  let route, posts = 0, drop = true
  registerTeamCapabilityUpdate({ webServer: { register: value => { route = value } }, connection: { admit: req => req.headers['x-fixture-owner'] === 'yes' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } } }, { backendClient: { async call(path, body) { const result = await hub.client.call(path, body); if (body) posts++; return result } } })
  server = createServer((req, res) => {
   if (req.method === 'POST' && drop) {
    drop = false
    // Commit through the actual bridge/Hub, then discard its response on the wire.
    const originalEnd = res.end.bind(res)
    res.end = (...args) => { res.destroy(); return res }
    void route.handler(req, res).catch(() => originalEnd())
   } else void route.handler(req, res)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  globalThis.fetch = (path, options = {}) => typeof path === 'string' && path.startsWith('/api/kode/') ? originalFetch(url + path, { ...options, headers: { ...options.headers, 'x-fixture-owner': 'yes' } }) : originalFetch(path, options)
  let stored
  const storage = { reserve: async (key, value) => stored ?? (stored = structuredClone(value)), save: async (key, value) => { stored = structuredClone(value) } }
  await assert.rejects(confirmCapabilityUpdate({ storage, prepared, request: requestCapabilityUpdate }))
  assert.equal(posts, 1); assert.equal(stored.state, 'prepared')
  assert.equal((await call('teams/team')).revision, 2)
  await hub.stop('SIGKILL'); await hub.start()
  const recovered = await confirmCapabilityUpdate({ storage, prepared: structuredClone(stored), request: requestCapabilityUpdate })
  assert.equal(posts, 1, 'recovery must read receipt instead of re-POSTing')
  assert.equal(stored.state, 'accepted'); assert.equal(recovered.team.revision, 2)
  assert.equal(recovered.activation_performed, false)
  assert.equal((await call('teams/team/activation')).team_revision, 1)
 } finally {
  globalThis.fetch = originalFetch
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await hub.close()
 }
})
