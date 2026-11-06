import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerProjectHosts } from '../src/project-hosts.js'
test('real ProjectHosts initializer registers each route/effect once and retains both answer APIs', async () => {
 const root = await mkdtemp(join(tmpdir(), 'kode-host-registration-'))
 const routes = new Map(), effects = new Set(), disposers = [], services = new Map()
 const register = route => { const key = route.kind + ':' + route.path; assert.ok(!routes.has(key), 'duplicate route ' + key); routes.set(key, route); return () => routes.delete(key) }
 const ctx = {
  effect: (fn, key) => { if (key) { assert.ok(!effects.has(key), 'duplicate effect ' + key); effects.add(key) } const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  provide: (key, value) => services.set(key, value), get: key => services.get(key),
  webServer: { register, registerUpgrade: route => register({ ...route, kind: 'upgrade' }) },
  connection: { admit: () => ({ rejection: 401 }) },
 }
 try {
  await registerProjectHosts(ctx, { projectHostsFile: join(root, 'hosts.json'), stateFile: join(root, 'state.json'), browserProfileDirectory: join(root, 'browser'), worktreeDirectory: join(root, 'worktrees') })
  for (const path of ['/api/kode/builder/answer', '/api/kode/builder/answers', '/api/kode/builder/configure-workflow', '/api/kode/teams/activation', '/api/kode/conversation/messages', '/api/kode/collab/teams']) assert.ok(routes.has('exact:' + path), 'missing route ' + path)
  assert.ok(services.get('kodeProjectHosts'))
 } finally { for (const dispose of disposers.reverse()) await dispose(); await rm(root, { recursive: true, force: true }) }
 assert.equal(routes.size, 0)
})
