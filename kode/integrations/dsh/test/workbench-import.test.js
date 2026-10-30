import test from 'node:test'
import assert from 'node:assert/strict'
import { saveNativeTab, syncNativeTabs } from '../src/workbench-import.js'

function fixture() {
  let value = { version: 1, gui: { tabs: [{ session_id: 'opened-tab' }] } }, revision = 0
  const client = { call: async (path, update) => {
    if (path.endsWith('/catalog')) return { backends: { codex: { command: 'codex' }, tcodex: { command: 'tcodex' } } }
    if (update) { assert.equal(update.expected_revision, revision); value = structuredClone(update.value); revision++ }
    return { revision, value: structuredClone(value) }
  } }
  const profiles = { binding: () => ({ threadId: 'native-thread', profile: { id: 'team', type: 'codex', name: 'Team worker', executable: 'tcodex' } }) }
  return { client, profiles, state: () => value, closeTabs: () => { value.gui.tabs = []; revision++ } }
}
test('native registrations keep executable identity and survive opened-tab replacement', async () => {
  const h = fixture(), agent = { id: 'inline-session', session: { header: { cwd: '/srv/project' }, requestHeader: () => ({ config: { model: 'model-a' } }) } }
  await saveNativeTab(h.client, h.profiles, agent, 'Helper')
  assert.equal(h.state().gui.tabs.length, 1)
  assert.equal(h.state().native_sessions[0].backend_key, 'tcodex')
  h.closeTabs()
  await saveNativeTab(h.client, h.profiles, agent, 'Renamed helper')
  assert.equal(h.state().gui.tabs.length, 0)
  assert.equal(h.state().native_sessions.length, 1)
  assert.equal(h.state().native_sessions[0].title, 'Renamed helper')
  assert.equal(h.state().native_sessions[0].dsh_session_id, 'inline-session')
  assert.equal(h.state().native_sessions[0].transport_kind, 'pty')
})
test('cold-session reconciliation reads summaries without activating any Agent', async () => {
  const h = fixture()
  const controller = { list: async () => ({ items: [{ sessionId: 'inline-session', cwd: '/srv/project', projections: { values: { title: 'Cold helper', modelSelection: { lastUsed: { model: 'model-a' } } } } }] }) }
  await syncNativeTabs(controller, h.client, h.profiles)
  assert.equal(h.state().native_sessions[0].title, 'Cold helper')
  assert.equal(h.state().native_sessions[0].model, 'model-a')
})
test('cold reconciliation retains known titles and models when projection caches are rebuilding',async()=>{
 const h=fixture(),agent={id:'inline-session',session:{header:{cwd:'/srv/project'},requestHeader:()=>({config:{model:'original-model'}})}}
 await saveNativeTab(h.client,h.profiles,agent,'Original title')
 await syncNativeTabs({list:async()=>({items:[{sessionId:agent.id,cwd:'/srv/project',projections:{values:{}}}]})},h.client,h.profiles)
 assert.equal(h.state().native_sessions[0].title,'Original title');assert.equal(h.state().native_sessions[0].model,'original-model')
})

function importFixture({ registered = false, cached = false, available = true, profile = true } = {}) {
  const tab = { backend_key: 'codex', session_id: 'saved-thread', cwd: '/srv/saved-project', title: 'Saved work' }
  const id = `session-kode-${createHash('sha256').update('codex:saved-thread').digest('hex').slice(0,32)}`
  let workspace = registered ? { id: 'workspace', attachSession: async () => {} } : undefined
  const calls = [], state = { version: 1, ...(cached ? { imports: { [id]: { formatVersion: 3 } } } : {}) }
  const registry = { resolveByPath: async path => { calls.push(['resolve',path]); return workspace }, create: async path => { calls.push(['register',path]); return workspace ??= { id: 'workspace', attachSession: async id => calls.push(['attach',id]) } } }
  const client = { call: async (path, update) => path.endsWith('/transcript') ? { available, messages: [] } : { revision: 1, value: update?.value ?? state } }
  const agent = { selectModel() {}, session: {}, ctx: { sessions: { flush: async () => {} } } }
  const services = { workspaceRegistry: registry, kodeAgents: { profiles: { list: () => profile ? [{ id: 'kode-codex', name: 'codex' }] : [], bindNative: async () => {} }, recordBinding() {} }, kodeNativeFactory: { importHistory: async (...args) => calls.push(['seed', ...args]) }, sessionController: { list: async () => ({ items: [] }), create: async request => { calls.push(['session',request]); return {sessionId:request.sessionId} }, resolveAgent: async () => ({agent}), rename: async () => {} } }
  return { tab, id, calls, client, ctx: { get: key => services[key] } }
}
import { createHash } from 'node:crypto'
import { importSavedSession } from '../src/workbench-import.js'
test('opening a saved session registers its existing original directory before creating the session', async () => {
  const h=importFixture();const result=await importSavedSession(h.ctx,h.client,h.tab)
  assert.equal(result.sessionId,h.id)
  assert.deepEqual(h.calls.find(row=>row[0]==='register'),['register',h.tab.cwd])
  assert.ok(h.calls.findIndex(row=>row[0]==='register') < h.calls.findIndex(row=>row[0]==='session'))
  assert.equal(h.calls.find(row=>row[0]==='seed')[3],h.tab.cwd)
})
test('an already imported history can restore missing workspace registration without rereading or reseeding it',async()=>{
 const h=importFixture({cached:true});await importSavedSession(h.ctx,h.client,h.tab)
 assert.equal(h.calls.filter(row=>row[0]==='register').length,1)
 assert.equal(h.calls.filter(row=>row[0]==='seed'||row[0]==='session').length,0)
})
test('existing registrations are reused and invalid histories never create empty projects',async()=>{
 const existing=importFixture({registered:true});await importSavedSession(existing.ctx,existing.client,existing.tab)
 assert.equal(existing.calls.filter(row=>row[0]==='register').length,0)
 for(const config of [{available:false},{profile:false}]){
  const h=importFixture(config);await assert.rejects(importSavedSession(h.ctx,h.client,h.tab))
  assert.equal(h.calls.filter(row=>row[0]==='register').length,0)
 }
})

test('saved imports reuse the native identity and respect the users archived duplicate', async()=>{
 const h=importFixture({registered:true}),profiles=h.ctx.get('kodeAgents').profiles,registry=h.ctx.get('workspaceRegistry'),controller=h.ctx.get('sessionController')
 profiles.bindings={'original':{threadId:h.tab.session_id,profile:{id:'kode-codex'}},'already-imported':{threadId:h.tab.session_id,profile:{id:'kode-codex'}}}
 profiles.binding=id=>profiles.bindings[id];registry.archivedSessionIds=['original'];h.tab.dsh_session_id='original'
 controller.list=async()=>({items:[{sessionId:'original'},{sessionId:'already-imported'}]})
 controller.resolveAgent=async()=>{throw new Error('existing imports must not start an Agent')}
 const result=await importSavedSession(h.ctx,h.client,h.tab)
 assert.equal(result.sessionId,'already-imported');assert.equal(result.imported,false)
 assert.deepEqual(registry.archivedSessionIds,['original']);assert.ok(!h.calls.some(row=>row[0]==='seed'||row[0]==='session'))
})

test('cold reconciliation never replaces an active native alias with its archived duplicate',async()=>{
 const h=fixture(),call=h.client.call;h.client.call=async(path,update)=>path.endsWith('/workspaces')?{revision:0,value:{global:{archivedSessionIds:['archived']}}}:call(path,update)
 await syncNativeTabs({list:async()=>({items:[{sessionId:'active',cwd:'/srv/project',updatedAt:100,projections:{values:{title:'Kept conversation'}}},{sessionId:'archived',cwd:'/srv/project',updatedAt:200,projections:{values:{title:'Archived duplicate'}}}]})},h.client,h.profiles)
 assert.equal(h.state().native_sessions.length,1);assert.equal(h.state().native_sessions[0].dsh_session_id,'active');assert.equal(h.state().native_sessions[0].title,'Kept conversation')
})

test('saved sessions already owned by a live dsh runtime reuse its shared view without importing', async () => {
  const h = importFixture()
  const live = { id: 42, runtime: 'dsh', backend_key: h.tab.backend_key, native_thread_id: h.tab.session_id, session_uuid: 'existing-dsh-session', status: 'idle', owner_alive: true }
  const call = h.client.call
  h.client.call = async (path, body) => path.endsWith('/runtime/sessions') ? { sessions: [{...live, backend_key:'other-agent'}, live] } : call(path, body)
  assert.deepEqual(await importSavedSession(h.ctx, h.client, h.tab), {sharedSession:live, imported:false})
  assert.deepEqual(h.calls, [])
})
