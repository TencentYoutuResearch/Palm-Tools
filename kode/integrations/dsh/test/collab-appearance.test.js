import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { SessionAppearance } from '../src/session-appearance.js'
import { registerCollabAppearance, teamAppearanceKey } from '../src/collab-appearance-route.js'
import { isolatedHub } from './support/isolated-hub.js'
import { conversationTeam } from './support/conversation-team.js'
const team = { id: 'team', home_hub: 'home', superagent_id: 'superagent', owner: { kind: 'human', id: 'local_owner' }, spec: { name: 'Team', execution_targets: [{ executor_profile_id: 'shared-profile' }] } }
const identity = row => ({ team_id: row.id, home_hub: row.home_hub, superagent_id: row.superagent_id })
function ownerRoute(appearance, backendClient) {
 let route
 registerCollabAppearance({ webServer: { register(value) { route = value; return () => {} } }, connection: { admit: req => req.headers.owner === 'yes' ? { peer: { principal: { kind: 'owner' } } } : req.headers.owner === 'worker' ? { peer: { principal: { kind: 'worker' } } } : { rejection: 401 } } }, { appearance, backendClient })
 return async (input, { method = 'GET', owner = 'yes', suffix, raw } = {}) => {
   let status, value
   const req = Readable.from(method === 'POST' ? [raw ?? JSON.stringify(input)] : [])
   Object.assign(req, { method, url: '/api/kode/collab/appearance' + (suffix ?? (method === 'GET' ? '?' + new URLSearchParams(input) : '')), headers: { owner, 'content-type': 'application/json' } })
   await route.handler(req, { writeHead(code) { status = code }, end(body) { value = JSON.parse(body) } })
   return { status, value }
 }
}
async function fixture(t) {
 const root = await mkdtemp(join(tmpdir(), 'kode-im-appearance-'))
 t.after(() => rm(root, { recursive: true, force: true }))
 await mkdir(join(root, 'gallery/person/idle'), { recursive: true })
 await writeFile(join(root, 'gallery/person/idle/frame-01.png'), 'fixture-image')
 await writeFile(join(root, 'gallery/person/background.png'), 'fixture-background')
 let index = { version: 1, presentation: { agentAvatars: { 'shared-profile': 'gallery/executor' } }, native_sessions: [{ dsh_session_id: 'ordinary-session', avatar_id: 'gallery/ordinary' }] }, revision = 0, writes = 0, calls = 0
 const backend = { async call(path, body) {
   calls++
   if (path.includes('/teams/')) { if (path.endsWith('/missing')) throw Object.assign(Error(), { status: 404 }); return structuredClone(path.endsWith('/other') ? { ...team, id: 'other', superagent_id: 'other-superagent' } : team) }
   assert.ok(path.endsWith('/documents/session-index'))
   if (body) { assert.equal(body.expected_revision, revision); index = body.value; revision++; writes++ }
   return { value: structuredClone(index), revision }
 } }
 const appearance = new SessionAppearance(backend, { list: () => [] }, { avatarDirectory: root })
 return { root, backend, appearance, request: ownerRoute(appearance, backend), index: () => index, counts: () => ({ writes, calls }) }
}
test('IM appearance persists through the existing document independently from executor and native Session avatars', async t => {
 const f = await fixture(t)
 assert.equal((await f.request(identity(team))).value.profile.avatar.id, null)
 assert.equal(f.counts().writes, 0)
 const saved = await f.request({ ...identity(team), avatar_id: 'gallery/person' }, { method: 'POST' })
 assert.equal(saved.status, 200); assert.equal(saved.value.profile.avatar.id, 'gallery/person')
 assert.equal(saved.value.profile.type, 'custom')
 assert.deepEqual(f.index().presentation.agentAvatars, { 'shared-profile': 'gallery/executor' })
 assert.equal(f.index().native_sessions[0].avatar_id, 'gallery/ordinary')
 assert.equal(f.index().presentation.sessionAvatars[teamAppearanceKey('home', 'superagent')], 'gallery/person')
 const fresh = new SessionAppearance(f.backend, { list: () => [] }, { avatarDirectory: f.root })
 assert.equal((await ownerRoute(fresh, f.backend)(identity(team))).value.profile.avatar.id, 'gallery/person')
 const other = { ...team, id: 'other', superagent_id: 'other-superagent' }
 assert.equal((await f.request(identity(other))).value.profile.avatar.id, null)
 assert.equal((await fresh.gallery())[0].background.startsWith('/api/kode/avatars/background?'), true)
 assert.equal((await f.request({ ...identity(team), avatar_id: null }, { method: 'POST' })).value.profile.avatar.url, null)
})
test('owner, exact real Team identity and known gallery are required before any appearance mutation', async t => {
 const f = await fixture(t)
 assert.equal((await f.request(identity(team), { owner: 'no' })).status, 401)
 assert.equal((await f.request(identity(team), { owner: 'worker' })).status, 403)
 assert.equal(f.counts().calls, 0)
 for (const input of [{ ...identity(team), home_hub: 'foreign' }, { ...identity(team), superagent_id: 'foreign' }]) assert.equal((await f.request({ ...input, avatar_id: 'gallery/person' }, { method: 'POST' })).status, 409)
 for (const avatar_id of ['gallery/../../outside', 'gallery/missing']) assert.equal((await f.request({ ...identity(team), avatar_id }, { method: 'POST' })).status, 400)
 assert.equal((await f.request({ ...identity(team), profile_id: 'shared-profile', avatar_id: 'gallery/person' }, { method: 'POST' })).status, 400)
 assert.equal((await f.request(identity(team), { method: 'POST' })).status, 400)
 assert.equal((await f.request(identity(team), { suffix: '?' + new URLSearchParams(identity(team)) + '&team_id=other' })).status, 400)
 assert.equal((await f.request({ ...identity(team), team_id: 'missing' })).status, 404)
 assert.equal((await f.request(identity(team), { method: 'POST', raw: 'x'.repeat(4100) })).status, 413)
 assert.equal(f.counts().writes, 0)
})
test('IM presentation survives a real isolated Hub restart without changing Team configuration', { skip: !process.env.KODE_TEST_ISOLATED_HUB, timeout: 30000 }, async t => {
 const hub = await isolatedHub('im-appearance-only')
 t.after(() => hub.close())
 const real = await conversationTeam(hub), before = structuredClone(real)
 const root = join(hub.root, 'avatars')
 await mkdir(join(root, 'gallery/person/idle'), { recursive: true }); await writeFile(join(root, 'gallery/person/idle/frame-01.png'), 'fixture-image')
 let appearance = new SessionAppearance(hub.client, { list: () => [] }, { avatarDirectory: root })
 assert.equal((await ownerRoute(appearance, hub.client)({ ...identity(real), avatar_id: 'gallery/person' }, { method: 'POST' })).status, 200)
 await hub.stop('SIGKILL'); await hub.start()
 appearance = new SessionAppearance(hub.client, { list: () => [] }, { avatarDirectory: root })
 assert.equal((await ownerRoute(appearance, hub.client)(identity(real))).value.profile.avatar.id, 'gallery/person')
 assert.deepEqual(await hub.client.call('/api/v1/messaging/teams/team'), before)
})
