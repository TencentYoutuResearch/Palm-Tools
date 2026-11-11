import test from 'node:test'
import assert from 'node:assert/strict'
import { installInterfacePreferences } from '../packages/transport/interface.js'
import { fetchWithLocalAppearance } from '../packages/transport/preferences.js'
const init = (method, args = {}) => ({ method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'example', method, payload: { args } }) })
const response = namespaces => new Response(JSON.stringify({ type: 'server-response', rpcId: 'example', result: { ok: true, value: { writable: true, namespaces } } }), { headers: { 'content-type': 'application/json' } })
test('SSH reads retain local theme and fonts while execution settings remain remote', async () => {
  const local = { ns: 'ui-theme', revision: 7, value: { preference: 'dark', terminalFontFamily: 'Example Mono', terminalFontSize: 15 } }
  const calls = [], send = async (_path, _init, host) => { calls.push(host); return host === 'local' ? response([local, { ns: 'agent-loop', value: { host: 'local' } }]) : response([{ ns: 'ui-theme', revision: 1, value: { preference: 'light' } }, { ns: 'agent-loop', value: { host: 'remote' } }]) }
  const result = await fetchWithLocalAppearance('api/settings/describe', init('settings/describe'), { current: 'ssh-example', send })
  const body = await result.json()
  assert.deepEqual(body.result.value.namespaces.find(row => row.ns === 'ui-theme'), local)
  assert.equal(body.result.value.namespaces.find(row => row.ns === 'agent-loop').value.host, 'remote')
  assert.deepEqual(calls.sort(), ['local', 'ssh-example'])
})
test('theme writes go to the entry Host; permissions, Agents and credentials keep their target', async () => {
  const calls = [], send = async (path, request, host) => { calls.push({ path, request, host }); return response([]) }
  for (const method of ['mutate', 'replace']) await fetchWithLocalAppearance(`/api/settings/${method}`, init(`settings/${method}`, { ns: 'ui-theme', ops: [] }), { current: 'ssh-example', send })
  await fetchWithLocalAppearance('/api/settings/mutate', init('settings/mutate', { ns: 'permission-presets' }), { current: 'ssh-example', send })
  await fetchWithLocalAppearance('/api/credentials/set', init('credentials/set', { ref: 'provider' }), { current: 'ssh-example', send })
  assert.deepEqual(calls.map(row => row.host), ['local', 'local', 'ssh-example', 'ssh-example'])
})
test('local preference failures cannot silently replace the window theme with the SSH theme', async () => {
  const send = async (_path, _request, host) => host === 'local' ? new Response('unavailable', { status: 503 }) : response([{ ns: 'ui-theme', value: { preference: 'light' } }])
  assert.equal((await fetchWithLocalAppearance('/api/settings/describe', init('settings/describe'), { current: 'ssh-example', send })).status, 503)
})

function preferences(initial) {
  let stored = initial, cleanup, storageListener
  const env = { localStorage: { getItem: () => stored ?? null, setItem: (_key, value) => { stored = value } }, window: {
    addEventListener: (_type, fn) => { storageListener = fn }, removeEventListener: (_type, fn) => { assert.equal(fn, storageListener); storageListener = undefined },
  } }
  const ctx = { provide(name, value) { this[name] = value }, effect(fn) { cleanup = fn() } }
  return { env, ctx, get stored() { return stored }, external(value) { stored = value; storageListener({ key: 'kode.interface.v1' }) }, cleanup: () => cleanup(), get listener() { return storageListener } }
}
test('token island preference saves immediately, survives reload, and synchronizes other windows', () => {
  const p = preferences(), service = installInterfacePreferences(p.ctx, p.env)
  assert.equal(service.getSnapshot().tokenIsland, true)
  assert.equal(p.ctx.kodeInterface, service)
  let updates = 0; const unsubscribe = service.subscribe(() => updates++)
  service.update({ tokenIsland: false })
  assert.equal(service.getSnapshot().tokenIsland, false)
  assert.deepEqual(JSON.parse(p.stored), { tokenIsland: false, tokenPeriod: 'today' })
  service.update({ tokenIsland: false }); assert.equal(updates, 1)
  assert.equal(installInterfacePreferences({ provide() {}, effect() {} }, preferences(p.stored).env).getSnapshot().tokenIsland, false)
  p.external('{"tokenIsland":true}'); assert.equal(service.getSnapshot().tokenIsland, true); assert.equal(updates, 2)
  unsubscribe(); p.external('{"tokenIsland":false}'); assert.equal(updates, 2)
  p.cleanup(); assert.equal(p.listener, undefined)
})
test('invalid settings default to visible and storage failures do not falsely change the island', () => {
  const p = preferences('broken json'), service = installInterfacePreferences(p.ctx, p.env)
  assert.equal(service.getSnapshot().tokenIsland, true)
  assert.throws(() => service.update({ tokenIsland: 'false' }), /无效/)
  p.env.localStorage.setItem = () => { throw new Error('storage denied') }
  assert.throws(() => service.update({ tokenIsland: false }), /storage denied/)
  assert.equal(service.getSnapshot().tokenIsland, true)
  p.cleanup()
})

test('meter period persists independently of visibility and migrates old preferences', () => {
 const p = preferences('{"tokenIsland":false}'), service = installInterfacePreferences(p.ctx, p.env)
 assert.deepEqual(service.getSnapshot(), { tokenIsland: false, tokenPeriod: 'today' })
 service.update({ tokenPeriod: 'month' }); assert.deepEqual(service.getSnapshot(), { tokenIsland: false, tokenPeriod: 'month' })
 service.update({ tokenIsland: true }); assert.equal(service.getSnapshot().tokenPeriod, 'month')
 assert.equal(installInterfacePreferences({ provide() {}, effect() {} }, preferences(p.stored).env).getSnapshot().tokenPeriod, 'month')
 service.update({ tokenPeriod: 'all' }); assert.equal(service.getSnapshot().tokenPeriod, 'all')
 service.update({ tokenPeriod: 'follow' }); assert.equal(service.getSnapshot().tokenPeriod, 'follow')
 assert.equal(installInterfacePreferences({ provide() {}, effect() {} }, preferences(p.stored).env).getSnapshot().tokenPeriod, 'follow')
 assert.throws(() => service.update({ tokenPeriod: 'invalid' }), /无效/)
 p.external('{"tokenIsland":true,"tokenPeriod":"month"}'); assert.equal(service.getSnapshot().tokenPeriod, 'month')
 p.external('{"tokenPeriod":"bad"}'); assert.equal(service.getSnapshot().tokenPeriod, 'today')
 p.cleanup()
})
