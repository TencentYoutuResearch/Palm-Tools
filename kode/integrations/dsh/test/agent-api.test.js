import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { AgentProfiles } from '../src/agent-profiles.js'
import { registerAgentApi } from '../src/agent-api.js'
import { Session } from '@deepseek-ai/dsh-session'

test('Agent configuration API admits only the dsh owner and preserves identity when selecting models', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-agent-api-'))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'native', name: 'dsh', type: 'dsh' }])
  let handler, selection = { provider: 'native-llm', model: 'fixture' }, turns = 0
  const selected = [], session = Session.create('conversation')
  const fastEvents = () => session.snapshotEvents().filter(event => event.type === 'plugin:kode/model-fast').map(event => event.data)
  const agent = { id: 'conversation', status: 'idle', session,selectModel:request=>{selected.push(request);selection={provider:request.provider,model:request.model,...(request.reasoningEffort?{reasoningEffort:request.reasoningEffort}:{})};return{selected:selection}} }
  const ctx = {
    webServer: { register: route => { handler = route.handler; return () => {} } },
    connection: { admit: req => req.headers['x-test-role'] === 'owner' ? { peer: { principal: { kind: 'owner' } } } : req.headers['x-test-role'] === 'guest' ? { peer: { principal: { kind: 'guest' } } } : { rejection: 401 } },
    agents: { get: () => agent }, agentDefaultModel: { currentSelection: () => selection },
    sessionProjections: { stateOf: (_session, key) => key === 'kodeTurnBoundary' ? { lastTurn: agent.isKodeNativeAgent ? turns : 999 } : key === 'turnBoundary' ? { lastTurn: agent.isKodeNativeAgent ? 0 : turns } : key === 'kodeFast' ? { preferences: fastEvents() } : { pending: selection } },
    sessionController: {
      resolveAgent: async () => ({ agent }),
      modelCatalog: async () => ({ default: selection, groups: [{ id: 'native-llm', models: [{ id: 'fixture' }] }, ...profiles.list().filter(p => p.type === 'codex').map(p => ({ id: `kode-agent-${p.id}`, models: [{ id: 'default' }, { id: 'fixture' }] }))] }),
      selectModel: async()=>{throw new Error('Native model selection must not reconfigure dsh defaults')},
    },
  }
  const service = { profiles, adapter: { listModels: async () => [{ id: 'fixture', reasoningEfforts:[{id:'medium',name:'Medium'},{id:'high',name:'High'}],defaultReasoningEffort:'medium',fastCapability:{transport:'config-option',defaultEnabled:false} }] }, refresh() {} }
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
    const officialDefault = ctx.agentDefaultModel.currentSelection()
    assert.equal((await request({action:'set-default',profileId:one.profile.id})).status,200)
    assert.equal(profiles.defaultProfileId,one.profile.id)
    assert.deepEqual(ctx.agentDefaultModel.currentSelection(),officialDefault)
    const beforeDiscovery=service.adapter.listModels
    service.adapter.listModels=async()=>{throw new Error('configuration model discovery failed')}
    const failedConfiguration=await (await fetch(endpoint+'?configuration=1',{headers:{'x-test-role':'owner'}})).json()
    assert.equal(failedConfiguration.modelError,'configuration model discovery failed');assert.deepEqual(failedConfiguration.models,[])
    service.adapter.listModels=beforeDiscovery
    const configuration=await (await fetch(endpoint+'?configuration=1',{headers:{'x-test-role':'owner'}})).json()
    assert.equal(configuration.modelError,undefined);assert.deepEqual(configuration.models.map(model=>model.id),['fixture'])
    assert.deepEqual(configuration.defaultModelSelection,{model:'fixture',reasoningEffort:'medium',fast:false})
    const otherConfiguration=await (await fetch(endpoint+`?configuration=1&profile_id=${two.profile.id}`,{headers:{'x-test-role':'owner'}})).json()
    assert.equal(otherConfiguration.selectedProfileId,two.profile.id)
    assert.deepEqual(otherConfiguration.defaultModelSelection,{model:'fixture',reasoningEffort:'medium',fast:false})
    const globalSelection = selection, acpHints = []
    selection = { provider: 'native-llm', model: 'global-model', reasoningEffort: 'high' }
    service.adapter.listModels = async (_provider, _profile, hint) => {
      acpHints.push(hint)
      return [
        { id: 'default-model', isDefault: true },
        { id: 'selected-model', ...(hint === 'selected-model' ? { reasoningEfforts: [{ id: 'high' }], defaultReasoningEffort: 'high' } : {}) },
      ]
    }
    assert.equal((await request({action:'set-default-model',profileId:two.profile.id,model:'selected-model',reasoningEffort:'high'})).status,200)
    const acpConfiguration = await (await fetch(endpoint+`?configuration=1&profile_id=${two.profile.id}`,{headers:{'x-test-role':'owner'}})).json()
    assert.equal(acpConfiguration.modelError,undefined)
    assert.deepEqual(acpConfiguration.defaultModelSelection,{model:'selected-model',reasoningEffort:'high'})
    assert.equal(acpHints.at(-1),'selected-model','ACP defaults probe their own model instead of the global selection')
    service.adapter.listModels = beforeDiscovery
    selection = globalSelection
    const savedDefault=await (await request({action:'set-default-model',profileId:one.profile.id,model:'fixture',reasoningEffort:'high',fast:true})).json()
    assert.deepEqual(savedDefault.defaultModelSelection,{model:'fixture',reasoningEffort:'high',fast:true})
    assert.deepEqual(profiles.defaultModelFor(one.profile.id),{model:'fixture',reasoningEffort:'high',fast:true})
    assert.equal((await request({action:'set-default-model',profileId:one.profile.id,model:'fixture',reasoningEffort:'invalid'})).status,400)
    assert.deepEqual(profiles.defaultModelFor(one.profile.id),{model:'fixture',reasoningEffort:'high',fast:true})
    assert.equal((await request({action:'set-default-model',profileId:two.profile.id,model:'fixture',reasoningEffort:'high',fast:true})).status,200)
    selection={provider:`kode-agent-${two.profile.id}`,model:'fixture',reasoningEffort:'medium'}
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id })).status, 200)
    assert.equal(profiles.binding(agent.id).profile.executable, 'tcodex')
    assert.equal(selected.at(-1).model, 'fixture', 'select an advertised model instead of a synthetic CLI default')
    assert.equal(selected.at(-1).reasoningEffort,'high','an unbound draft inherits configured defaults even when the global provider already matches')
    assert.equal(fastEvents().at(-1).fast,true)
    const catalog = await (await request()).json()
    assert.deepEqual(catalog.models.map(m => m.id), ['fixture'])
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'nonexistent' })).status, 400)
    assert.equal(catalog.canChangeAgent, true, 'official sessions ignore Kode turn boundaries')
    turns = 1
    agent.isKodeNativeAgent = true
    const nativeView = await (await request()).json()
    assert.equal(nativeView.canChangeAgent, false, 'completed native sessions keep their Agent header visible')
    assert.equal(nativeView.currentProfile.id, two.profile.id)
    const liveGet = ctx.agents.get
    ctx.agents.get = () => undefined
    let coldBlank = false
    ctx.sessionController.list = async () => ({ items: [{ sessionId: agent.id, blank: coldBlank, projections: { values: { modelSelection: { lastUsed: selection } } } }] })
    assert.equal((await (await request()).json()).canChangeAgent, false, 'unloading a historical session never unlocks its Agent')
    coldBlank = true
    assert.equal((await (await request()).json()).canChangeAgent, true, 'a saved blank draft can still choose its Agent')
    ctx.sessionController.list = async () => ({ items: [] })
    assert.equal((await (await request()).json()).canChangeAgent, false, 'unknown sessions cannot inherit blank-session privileges')
    ctx.agents.get = liveGet
    const failed = await request({ action: 'select', profileId: one.profile.id, sessionId: agent.id })
    assert.equal(failed.status, 400)
    assert.match((await failed.json()).error, /new conversation/)
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'fixture' })).status, 200)
    assert.equal(selected.at(-1).model, 'fixture')
    assert.equal((await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture',reasoningEffort:'high'})).status,200)
    assert.equal(selected.at(-1).reasoningEffort,'high')
    const committed = selected.length
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'fixture', reasoningEffort: 'invalid' })).status, 400)
    assert.equal(selected.length, committed, 'invalid effort must not change the durable selection')
    const originalModels = service.adapter.listModels
    service.adapter.listModels = async () => [
      { id: 'fixture', reasoningEfforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultReasoningEffort: 'medium' },
      { id: 'plain', reasoningEfforts: [] },
    ]
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'plain' })).status, 200)
    assert.equal(selected.at(-1).reasoningEffort, undefined, 'switching models clears an effort the new model does not advertise')
    assert.equal((await request({ action: 'select', profileId: two.profile.id, sessionId: agent.id, model: 'fixture' })).status, 200)
    assert.equal(selected.at(-1).reasoningEffort, 'medium', 'switching back uses the advertised default, not a stale high value')
    service.adapter.listModels = originalModels
    assert.equal((await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture',reasoningEffort:'not-advertised'})).status,400)
    const fastOn = await (await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture',fast:true})).json()
    assert.equal(fastOn.fast, true)
    assert.equal(fastEvents().at(-1).fast, true)
    assert.equal((await (await request()).json()).fast, true)
    assert.equal((await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture',fast:false})).status,200)
    assert.equal(fastEvents().at(-1).fast, false)
    assert.equal((await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture',fast:'yes'})).status,400)
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
    await profiles.patchBinding(agent.id,{managedOperation:{id:'controlled'},managedAssignment:{id:'assignment'}})
    const selectionsBeforeGuard=selected.length
    assert.equal((await request({action:'select',profileId:two.profile.id,sessionId:agent.id,model:'fixture'})).status,403)
    assert.equal(selected.length,selectionsBeforeGuard)
    service.adapter.listModels=async()=>{throw Error('managed history must not probe an executor')}
    const readOnlyConfiguration=await (await request()).json()
    assert.equal(readOnlyConfiguration.managed.assignment_id,'assignment')
    assert.equal(readOnlyConfiguration.canChangeAgent,false)
    assert.deepEqual(readOnlyConfiguration.models,[])
    assert.equal(readOnlyConfiguration.modelError,undefined)
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
})
