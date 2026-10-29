import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { AgentProfiles } from '../src/agent-profiles.js'
import { registerAgentApi } from '../src/agent-api.js'

test('Agent configuration API admits only the dsh owner and preserves identity when selecting models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-agent-api-'))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'native', name: 'dsh', type: 'dsh' }])
  let handler, selection = { provider: 'native-llm', model: 'fixture' }, turns = 0
  const selected = []
  const agent = { id: 'conversation', status: 'idle', session: {},selectModel:request=>{selected.push(request);selection={provider:request.provider,model:request.model,...(request.reasoningEffort?{reasoningEffort:request.reasoningEffort}:{})};return{selected:selection}} }
  const ctx = {
    webServer: { register: route => { handler = route.handler; return () => {} } },
    connection: { admit: req => req.headers['x-test-role'] === 'owner' ? { peer: { principal: { kind: 'owner' } } } : req.headers['x-test-role'] === 'guest' ? { peer: { principal: { kind: 'guest' } } } : { rejection: 401 } },
    agents: { get: () => agent }, agentDefaultModel: { currentSelection: () => selection },
    sessionProjections: { stateOf: (_session, key) => key === 'turnBoundary' ? { lastTurn: turns } : { pending: selection } },
    sessionController: {
      resolveAgent: async () => ({ agent }),
      modelCatalog: async () => ({ default: selection, groups: [{ id: 'native-llm', models: [{ id: 'fixture' }] }, ...profiles.list().filter(p => p.type === 'codex').map(p => ({ id: `kode-agent-${p.id}`, models: [{ id: 'default' }, { id: 'fixture' }] }))] }),
      selectModel: async()=>{throw new Error('Native model selection must not reconfigure dsh defaults')},
    },
  }
  const service = { profiles, adapter: { listModels: async () => [{ id: 'fixture', reasoningEfforts:[{id:'medium',name:'Medium'},{id:'high',name:'High'}],defaultReasoningEffort:'medium' }] }, refresh() {} }
  registerAgentApi(ctx, service)
  const server = http.createServer((req, res) => { void handler(req, res) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${server.address().port}/api/kode/agents`
  const request = (body, role = 'owner') => fetch(`${endpoint}?session_id=${agent.id}`, { method: body ? 'POST' : 'GET', headers: { 'x-test-role': role, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  try {
    assert.equal((await request(undefined, 'anonymous')).status, 401)
    assert.equal((await request({ action: 'save', profile: { name: 'Must not persist', type: 'codex' } }, 'guest')).status, 403)
    assert.equal(profiles.list().length, 1)
    const one = await (await request({ action: 'save', profile: { name: 'Codex', type: 'codex' } })).json()
    const two = await (await request({ action: 'save', profile: { name: 'Tcodex', type: 'codex', executable: 'tcodex' } })).json()
    assert.notEqual(one.profile.id, two.profile.id)
    const beforeDiscovery=service.adapter.listModels
    service.adapter.listModels=async()=>{throw new Error('configuration listing must not discover models')}
    const configuration=await (await fetch(endpoint+'?configuration=1',{headers:{'x-test-role':'owner'}})).json()
    assert.equal(configuration.modelError,undefined);assert.deepEqual(configuration.models,[])
    service.adapter.listModels=beforeDiscovery
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id })).status, 200)
    assert.equal(profiles.binding(agent.id).profile.executable, 'tcodex')
    assert.equal(selected.at(-1).model, 'fixture', 'select an advertised model instead of a synthetic CLI default')
    const catalog = await (await request()).json()
    assert.deepEqual(catalog.models.map(m => m.id), ['fixture'])
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'nonexistent' })).status, 400)
    turns = 1
    const failed = await request({ action: 'select', profileId: one.profile.id, sessionId: agent.id })
    assert.equal(failed.status, 400)
    assert.match((await failed.json()).error, /new conversation/)
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'fixture' })).status, 200)
    assert.equal(selected.at(-1).model, 'fixture')
    assert.equal((await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture',reasoningEffort:'high'})).status,200)
    assert.equal(selected.at(-1).reasoningEffort,'high')
    assert.equal((await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture',reasoningEffort:'not-advertised'})).status,400)
    assert.equal(selected.at(-1).provider, `kode-agent-${two.profile.id}`)
    assert.equal(profiles.binding(agent.id).profile.id, two.profile.id)
    assert.equal((await request({ action: 'remove', profileId: two.profile.id }, 'guest')).status, 403)
    assert.equal((await request({ action: 'remove', profileId: two.profile.id })).status, 200)
    assert.ok(!profiles.list().some(p => p.id === two.profile.id))
    assert.equal(profiles.binding(agent.id).profile.executable, 'tcodex')
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'fixture' })).status, 200, 'deleting a configuration preserves its already bound conversation')
    const retired = await (await request()).json()
    assert.equal(retired.currentProfile.id, two.profile.id)
    service.hasRuntime = type => type !== 'dsh'
    service.types = { codex: { name: 'Codex' } }
    const hidden = await (await request()).json()
    assert.ok(hidden.profiles.every(p => p.type !== 'dsh'))
    assert.equal(hidden.types.dsh, undefined)
    assert.equal((await request({ action: 'save', profile: { name: 'Hidden', type: 'dsh' } })).status, 400)
    assert.equal((await request({ action: 'select', profileId: 'native', sessionId: agent.id })).status, 400)
    assert.equal(profiles.binding(agent.id).profile.executable, 'tcodex')
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})
