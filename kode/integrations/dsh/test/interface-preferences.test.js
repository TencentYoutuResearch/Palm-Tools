import test from 'node:test'
import assert from 'node:assert/strict'
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
