import test from 'node:test'
import assert from 'node:assert/strict'
import { backendProfile, saveNativeTab, syncNativeTabs } from '../src/workbench-import.js'
import { NativeSessionDirectory } from '../src/native-session-directory.js'
import { buildHistorySeed } from '../src/native-history.js'

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

function importFixture({ registered = false, cached = false, persisted = cached, available = true, profile = true } = {}) {
  const tab = { backend_key: 'codex', session_id: 'saved-thread', cwd: '/srv/saved-project', title: 'Saved work' }
  const id = `session-kode-${createHash('sha256').update('codex:saved-thread').digest('hex').slice(0,32)}`
  let workspace = registered ? { id: 'workspace', attachSession: async () => {} } : undefined
  const calls = [], state = { version: 1, ...(cached ? { imports: { [id]: { formatVersion: 3 } } } : {}) }
  const registry = { list: () => workspace ? [{ ...workspace, path: tab.cwd }] : [], resolveByPath: async path => { calls.push(['resolve',path]); return workspace }, create: async path => { calls.push(['register',path]); return workspace ??= { id: 'workspace', attachSession: async id => calls.push(['attach',id]) } } }
  const client = { call: async (path, update) => path.endsWith('/transcript') ? { available, messages: [] } : { revision: 1, value: update?.value ?? state } }
  const agent = { selectModel() {}, session: {}, ctx: { sessions: { flush: async () => {} } } }
  const services = { workspaceRegistry: registry, kodeAgents: { profiles: { list: () => profile ? [{ id: 'kode-codex', name: 'codex' }] : [], bindNative: async () => {} }, recordBinding() {} }, kodeNativeFactory: { importHistory: async (...args) => calls.push(['seed', ...args]) }, sessionController: { list: async () => ({ items: persisted ? [{ sessionId: id }] : [] }), create: async request => { persisted = true; calls.push(['session',request]); return {sessionId:request.sessionId} }, resolveAgent: async () => ({agent}), rename: async () => {} } }
  return { tab, id, calls, client, ctx: { get: key => services[key] } }
}
import { createHash } from 'node:crypto'
import { importSavedSession } from '../src/workbench-import.js'
test('builtin backend IDs resolve the configured profile without matching its display name',async()=>{
 const h=importFixture({cached:true});h.tab.backend_key='builtin-dsh'
 h.tab.dsh_session_id=h.id
 h.ctx.get('kodeAgents').profiles.list=()=>[{id:'builtin-dsh',name:'DeepSeek Harness',type:'dsh'}]
 const result=await importSavedSession(h.ctx,h.client,h.tab)
 assert.equal(result.sessionId,h.id)
 assert.ok(!h.calls.some(row=>row[0]==='seed'||row[0]==='session'))
})
test('desktop backend aliases resolve a renamed configured profile',async()=>{
 const h=importFixture({cached:true});h.tab.backend_key='team-backend';h.tab.dsh_session_id=h.id
 const profiles=h.ctx.get('kodeAgents').profiles
 profiles.list=()=>[{id:'configured-worker',name:'Renamed worker',type:'codex'}]
 profiles.sharedState={desktop_ids:{'configured-worker':'team-backend'}}
 const result=await importSavedSession(h.ctx,h.client,h.tab)
 assert.equal(result.sessionId,h.id)
})
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

test('native catalog synchronization retains an explicit default-icon choice across repeated saves', async () => {
  const h = fixture(), agent = { id: 'inline-session', session: { header: { cwd: '/srv/project' }, requestHeader: () => ({ config: { model: 'model-a' } }) } }
  const doc = await h.client.call('/api/v1/messaging/workbench/documents/session-index')
  doc.value.presentation = { sessionAvatars: { [agent.id]: null } }
  await h.client.call('/api/v1/messaging/workbench/documents/session-index', { expected_revision: doc.revision, value: doc.value })
  await saveNativeTab(h.client, h.profiles, agent, 'Default icon')
  await saveNativeTab(h.client, h.profiles, agent, 'Default icon')
  assert.equal(h.state().native_sessions[0].avatar_id, null)
  assert.ok(Object.hasOwn(h.state().presentation.sessionAvatars, agent.id))
  assert.equal(h.state().presentation.sessionAvatars[agent.id], null)
})

test('shared import markers rebuild a missing local session before attaching it', async () => {
  for (const bound of [false, true]) {
    const h = importFixture({ cached: true, persisted: false })
    if (bound) h.ctx.get('kodeAgents').profiles.binding = () => ({ threadId: h.tab.session_id, profile: { id: 'kode-codex' } })
    const result = await importSavedSession(h.ctx, h.client, h.tab)
    assert.equal(result.sessionId, h.id)
    assert.equal(h.calls.filter(row => row[0] === 'seed').length, 1)
    assert.equal(h.calls.filter(row => row[0] === 'session').length, 1)
    assert.ok(h.calls.findIndex(row => row[0] === 'session') < h.calls.findIndex(row => row[0] === 'attach'))
    const seed = h.calls.find(row => row[0] === 'seed')
    assert.equal(seed[1], h.id)
    assert.equal(seed[3], h.tab.cwd)
  }
})

test('missing local imports with unavailable native history leave the workspace untouched', async () => {
  const h = importFixture({ cached: true, persisted: false, available: false })
  await assert.rejects(importSavedSession(h.ctx, h.client, h.tab), /transcript is unavailable/)
  assert.equal(h.calls.filter(row => ['register', 'seed', 'session', 'attach'].includes(row[0])).length, 0)
})

test('cold saved runtime projections do not bypass local history recovery', async () => {
  const h = importFixture({ cached: true, persisted: false }), call = h.client.call
  h.client.call = async (path, body) => path.endsWith('/runtime/sessions') ? { sessions: [{
    runtime: 'dsh', backend_key: h.tab.backend_key, native_thread_id: h.tab.session_id,
    runtime_saved: true, runtime_online: true, status: 'idle',
  }] } : call(path, body)
  const result = await importSavedSession(h.ctx, h.client, h.tab)
  assert.equal(result.sessionId, h.id)
  assert.ok(h.calls.some(row => row[0] === 'seed'))
})

test('saved history remains readable in a registered workspace whose directory was removed', async () => {
  const h = importFixture({ registered: true })
  h.ctx.get('workspaceRegistry').resolveByPath = async () => { throw new Error('ENOENT') }
  const result = await importSavedSession(h.ctx, h.client, h.tab)
  assert.equal(result.sessionId, h.id)
  assert.ok(h.calls.some(row => row[0] === 'seed'))
  assert.ok(!h.calls.some(row => row[0] === 'register'))
})

test('Claude title synchronization persists through Kode and retries failures before committing metadata', async () => {
  const h = fixture(), calls = [], call = h.client.call
  h.profiles.binding = () => ({ threadId: 'claude-thread', profile: { id: 'kode-claude', type: 'claude', name: 'Claude', executable: 'claude' } })
  let fail = true
  h.client.call = async (path, body) => {
    if (path.endsWith('/catalog')) return { backends: { claude: { command: 'claude' } } }
    if (path.endsWith('/native-title')) {
      calls.push(body)
      if (fail) throw new Error('fixture native title write failed')
      return { updated: true }
    }
    return call(path, body)
  }
  const agent = { id: 'session', session: { header: { cwd: '/srv/project' }, requestHeader: () => ({}) } }
  let liveTitle
  const options = { renameNative: async title => { liveTitle = title } }
  await assert.rejects(saveNativeTab(h.client, h.profiles, agent, 'Renamed Claude', options), /native title write failed/)
  assert.equal(h.state().native_sessions, undefined)
  fail = false
  await saveNativeTab(h.client, h.profiles, agent, 'Renamed Claude', options)
  assert.equal(liveTitle, 'Renamed Claude')
  assert.equal(h.state().native_sessions[0].native_title, 'Renamed Claude')
  await saveNativeTab(h.client, h.profiles, agent, 'Renamed Claude', options)
  assert.equal(calls.length, 2, 'unchanged titles require no additional native writes')
  assert.deepEqual(calls[0], { backend_key: 'claude', session_id: 'claude-thread', cwd: '/srv/project', title: 'Renamed Claude' })
})
test('a takeover import archives earlier copies of the same native thread and keeps other threads', async () => {
 const h=importFixture({registered:true}),profiles=h.ctx.get('kodeAgents').profiles,registry=h.ctx.get('workspaceRegistry'),archived=[],released=[]
 profiles.bindings={'old-copy':{threadId:h.tab.session_id,profile:{id:'kode-codex'}},'older-archived':{threadId:h.tab.session_id,profile:{id:'kode-codex'}},'other-thread':{threadId:'another',profile:{id:'kode-codex'}}}
 registry.archivedSessionIds=['older-archived'];registry.archiveSession=async(id,options)=>{assert.deepEqual(options,{stopActivity:true});archived.push(id)}
 h.ctx.get('kodeNativeFactory').release=async id=>released.push(id)
 const result=await importSavedSession(h.ctx,h.client,h.tab,{fresh:true})
 assert.notEqual(result.sessionId,'old-copy')
 assert.deepEqual(archived,['old-copy']);assert.deepEqual(released,['old-copy'])
})
test('a takeover reloads the stored copy in place and falls back to a fresh copy when turns cannot be placed', async () => {
 for (const placeable of [true, false]) {
  const h=importFixture({registered:true}),profiles=h.ctx.get('kodeAgents').profiles,registry=h.ctx.get('workspaceRegistry'),controller=h.ctx.get('sessionController'),factory=h.ctx.get('kodeNativeFactory')
  profiles.bindings={'stored-copy':{threadId:h.tab.session_id,profile:{id:'kode-codex'}}};profiles.binding=id=>profiles.bindings[id]
  registry.archivedSessionIds=['stored-copy'];const unarchived=[];registry.unarchiveSession=async id=>unarchived.push(id);registry.archiveSession=async()=>{}
  controller.list=async()=>({items:[{sessionId:'stored-copy'}]})
  const time=1767225600000,selection={provider:'kode-agent-kode-codex',model:'m'}
  const stored=[{type:'turn/start',seq:0,time,data:{turn:1}},{type:'request/header',seq:1,time,data:{header:{config:selection},reason:'initial'}},{type:'turn/end',seq:2,time:time+10,data:{turn:1,reason:{kind:'completed'}}}]
  const timeline=placeable?[{kind:'turn_end',time:time+5},{kind:'turn_start',time:time+100},{kind:'text',role:'user',text:'later',time:time+101},{kind:'turn_end',time:time+102}]:[{kind:'text',role:'user',text:'no boundary',time:time+100}]
  h.client.call=async(path,update)=>path.endsWith('/transcript')?{available:true,timeline,messages:[]}:{revision:1,value:update?.value??{version:1}}
  let appended=null;factory.appendHistory=async(id,build)=>{appended=build(stored);return appended?.length??0}
  const result=await importSavedSession(h.ctx,h.client,h.tab,{fresh:true})
  if (placeable) {
   assert.equal(result.sessionId,'stored-copy');assert.equal(result.reloaded,true);assert.deepEqual(unarchived,['stored-copy'])
   assert.deepEqual(appended.filter(e=>e.type==='user/message').map(e=>e.data.content[0].text),['later'])
   assert.equal(appended.find(e=>e.type==='turn/start').data.turn,2)
  } else {
   assert.notEqual(result.sessionId,'stored-copy');assert.deepEqual(unarchived,[]);assert.ok(h.calls.some(row=>row[0]==='seed'))
  }
 }
})

test('owner-selected CLI-only sessions are bound to the listed profile, ID and working directory', async () => {
  const h = importFixture()
  const runtime = h.ctx.get('kodeAgents'), profiles = runtime.profiles
  const profile = { id: 'kode-codex', name: 'Codex', type: 'codex', executable: 'codex' }
  profiles.list = () => [profile]
  runtime.hasRuntime = () => true
  const nativeId = 'cli-only-thread'
  const binding = []
  profiles.bindNative = async (...args) => binding.push(args)
  runtime.adapter = {
    listSessions: async (selected, cursor) => {
      assert.equal(selected, profile)
      return { supported: true, nextCursor: cursor ? null : 'next', sessions: [
        { sessionId: nativeId, cwd: '/srv/another-project', title: 'Native title' },
        { sessionId: 'invalid-path', cwd: 'relative/path' },
      ] }
    },
  }
  const directory = new NativeSessionDirectory(h.ctx, h.client)
  await assert.rejects(directory.list('different-profile', null), /Agent 配置/)
  const page = await directory.list(profile.id, null)
  assert.deepEqual(page.sessions.map(row => row.title), ['Native title'])
  await assert.rejects(directory.open({ selection: 'forged', cwd: '/srv/third-project', nativeId }), /已过期/)
  assert.equal(h.calls.length, 0)
  const result = await directory.open({ selection: page.sessions[0].selection, cwd: '/srv/third-project' })
  assert.equal(result.imported, true)
  assert.deepEqual(binding, [[result.sessionId, profile.id, nativeId]])
  assert.deepEqual(h.calls.find(row => row[0] === 'register'), ['register', '/srv/another-project'])
  profile.executable = 'new-codex'
  await assert.rejects(directory.open({ selection: page.sessions[0].selection }), /配置已更新/)
})

test('resume widens a truncated transcript and reopens one stored session without replaying earlier turns', async () => {
  const h = importFixture({ registered: true, cached: true })
  const runtime = h.ctx.get('kodeAgents'), controller = h.ctx.get('sessionController'), factory = h.ctx.get('kodeNativeFactory')
  runtime.profiles.bindings = { [h.id]: { threadId: h.tab.session_id, profile: { id: 'kode-codex' } } }
  runtime.profiles.binding = id => runtime.profiles.bindings[id]
  const selection = { provider: 'kode-agent-kode-codex', model: 'fixture' }
  const first = [{ kind: 'turn_start', time: 10 }, { kind: 'text', role: 'user', text: 'before', time: 11 }, { kind: 'turn_end', time: 15 }]
  const next = [{ kind: 'turn_start', time: 20 }, { kind: 'text', role: 'user', text: 'after', time: 21 }, { kind: 'turn_end', time: 25 }]
  const stored = [...buildHistorySeed({ timeline: first }, selection), { type: 'session/end-seed', time: 40 }]
  const call = h.client.call, windows = []
  h.client.call = async (path, args) => {
    if (!path.endsWith('/transcript')) return call(path, args)
    windows.push(args.tail_bytes)
    return { available: true, timeline: args.tail_bytes ? [...first, ...next] : next, history_window: { truncated: true } }
  }
  factory.appendHistory = async (id, build) => {
    assert.equal(id, h.id)
    const added = build(stored) ?? []
    stored.push(...added)
    return added.length
  }
  controller.rename = async input => h.calls.push(['rename', input])
  const [opened, repeated] = await Promise.all([
    importSavedSession(h.ctx, h.client, { ...h.tab, title: 'From CLI' }, { discovered: true }),
    importSavedSession(h.ctx, h.client, h.tab, { localSessionId: h.id, refreshOnly: true }),
  ])
  assert.equal(opened.sessionId, h.id)
  assert.equal(opened.reloaded, true)
  assert.equal(repeated.historyPending, false)
  assert.deepEqual(windows, [undefined, 64 * 1024 * 1024, undefined])
  assert.deepEqual(stored.filter(row => row.type === 'user/message').map(row => row.data.content[0].text), ['before', 'after'])
  assert.deepEqual(h.calls.find(row => row[0] === 'rename'), ['rename', { sessionId: h.id, title: 'From CLI' }])
  assert.ok(!h.calls.some(row => ['session', 'seed'].includes(row[0])))
})
test('a takeover reloads the copy the conversation last ran in instead of importing another', async () => {
 const h=importFixture({registered:true}),profiles=h.ctx.get('kodeAgents').profiles,registry=h.ctx.get('workspaceRegistry'),controller=h.ctx.get('sessionController'),factory=h.ctx.get('kodeNativeFactory')
 // Sorted keys: the oldest copy comes first and cannot be brought up to date.
 profiles.bindings={'copy-a-old':{threadId:h.tab.session_id,profile:{id:'kode-codex'}},'copy-b-new':{threadId:h.tab.session_id,profile:{id:'kode-codex'}}};profiles.binding=id=>profiles.bindings[id]
 registry.archivedSessionIds=['copy-a-old','copy-b-new'];const unarchived=[];registry.unarchiveSession=async id=>unarchived.push(id);registry.archiveSession=async()=>{}
 controller.list=async()=>({items:[{sessionId:'copy-a-old',updatedAt:100},{sessionId:'copy-b-new',updatedAt:200}]})
 const time=1767225600000,selection={provider:'kode-agent-kode-codex',model:'m'}
 const stored={'copy-a-old':[{type:'request/header',seq:0,time:time-1e6,data:{header:{config:selection}}}],'copy-b-new':[{type:'turn/start',seq:0,time,data:{turn:1}},{type:'request/header',seq:1,time,data:{header:{config:selection}}},{type:'turn/end',seq:2,time:time+10,data:{turn:1}}]}
 const timeline=[{kind:'turn_end',time:time+5},{kind:'turn_start',time:time+100},{kind:'text',role:'user',text:'later',time:time+101}]
 h.client.call=async(path,update)=>path.endsWith('/transcript')?{available:true,timeline,messages:[]}:{revision:1,value:update?.value??{version:1}}
 factory.appendHistory=async(id,build)=>build(stored[id])?.length??0
 const result=await importSavedSession(h.ctx,h.client,h.tab,{fresh:true})
 assert.equal(result.sessionId,'copy-b-new');assert.equal(result.reloaded,true);assert.deepEqual(unarchived,['copy-b-new'])
 assert.ok(!h.calls.some(row=>row[0]==='seed'),'no fresh copy is imported')
})
test('reopening a closed (archived) conversation unarchives its stored copy', async () => {
 const h=importFixture({registered:true,persisted:true}),profiles=h.ctx.get('kodeAgents').profiles,registry=h.ctx.get('workspaceRegistry')
 profiles.bindings={[h.id]:{threadId:h.tab.session_id,profile:{id:'kode-codex'}}};profiles.binding=id=>profiles.bindings[id]
 registry.archivedSessionIds=[h.id];const unarchived=[];registry.unarchiveSession=async id=>unarchived.push(id)
 const result=await importSavedSession(h.ctx,h.client,h.tab)
 assert.equal(result.sessionId,h.id);assert.deepEqual(unarchived,[h.id])
 assert.ok(!h.calls.some(row=>row[0]==='seed'),'the stored copy is reused, not imported again')
})

test('concurrent imports sharing one unregistered workspace create it once and serialize session-index writes', async () => {
  const cwd = '/srv/shared-project'
  let workspace
  let workspaceCreates = 0
  const attached = []
  const persistedIds = new Set()
  const registry = {
    list: () => workspace ? [{ ...workspace, path: cwd }] : [],
    resolveByPath: async () => workspace,
    create: async path => {
      workspaceCreates++
      await new Promise(resolve => setTimeout(resolve, 20))
      workspace = { id: 'ws-shared', path, attachSession: async id => { attached.push(id) } }
      return workspace
    },
  }
  let revision = 0
  let indexDoc = { version: 1, imports: {} }
  const client = {
    call: async (path, body) => {
      if (path.endsWith('/runtime/sessions')) return { sessions: [] }
      if (path.endsWith('/transcript')) {
        await new Promise(resolve => setTimeout(resolve, 10))
        return { available: true, messages: [] }
      }
      if (path.endsWith('/documents/session-index')) {
        if (body) {
          if (body.expected_revision !== revision) throw new Error('configuration changed')
          indexDoc = structuredClone(body.value)
          revision++
        }
        return { revision, value: structuredClone(indexDoc) }
      }
      return { revision: 0, value: { version: 1 } }
    },
  }
  const agent = { selectModel() {}, session: {}, ctx: { sessions: { flush: async () => {} } } }
  const services = {
    workspaceRegistry: registry,
    kodeAgents: { profiles: { list: () => [{ id: 'kode-codex', name: 'codex' }], bindNative: async () => {} }, recordBinding() {} },
    kodeNativeFactory: { importHistory: async () => {} },
    sessionController: {
      list: async () => ({ items: [...persistedIds].map(sessionId => ({ sessionId })) }),
      create: async req => { persistedIds.add(req.sessionId); return { sessionId: req.sessionId } },
      resolveAgent: async () => ({ agent }),
      rename: async () => {},
    },
  }
  const ctx = { get: key => services[key] }
  const tabs = Array.from({ length: 6 }, (_, i) => ({
    backend_key: 'codex',
    session_id: `thread-${i}`,
    cwd,
    title: `Session ${i}`,
  }))
  const results = await Promise.all(tabs.map(tab => importSavedSession(ctx, client, tab, { fresh: true })))
  assert.equal(workspaceCreates, 1, 'concurrent imports must register the shared workspace only once')
  assert.equal(attached.length, 6)
  assert.equal(Object.keys(indexDoc.imports).length, 6)
  for (const result of results) assert.ok(indexDoc.imports[result.sessionId], `missing import marker for ${result.sessionId}`)
})

test('backendProfile recognizes cursor and antigravity desktop backends', () => {
  const profile = backendProfile('cursor', { command: 'cursor-agent', args: [], enabled: true })
  assert.deepEqual(profile, { id: 'kode-cursor', name: 'cursor', type: 'cursor', executable: 'cursor-agent', args: [] })
  const custom = backendProfile('my-cursor', { command: 'agent', protocol: 'cursor', enabled: true })
  assert.equal(custom?.type, 'cursor')
  const agy = backendProfile('antigravity', { command: 'agy', args: [], enabled: true })
  assert.deepEqual(agy, { id: 'kode-antigravity', name: 'antigravity', type: 'antigravity', executable: 'agy', args: [] })
  const customAgy = backendProfile('my-agy', { command: 'agy', protocol: 'antigravity', enabled: true })
  assert.equal(customAgy?.type, 'antigravity')
})

test('re-imports a fresh copy and retires an existing blank zombie copy of the same native thread', async () => {
  const cwd = '/tmp/cursor-blank-heal'
  const zombieId = 'session-kode-zombie-blank'
  const archived = []
  const bindings = { [zombieId]: { profile: { id: 'kode-cursor', name: 'cursor', type: 'cursor' }, threadId: 'cursor-thread-1' } }
  const items = [{ sessionId: zombieId, blank: true, running: false, updatedAt: 10 }]
  const workspace = { id: 'ws-1', path: cwd, attachSession: async () => {} }
  const client = {
    call: async (path, body) => {
      if (path.endsWith('/runtime/sessions')) return { sessions: [] }
      if (path.endsWith('/transcript')) {
        return {
          available: true,
          timeline: [
            { kind: 'text', role: 'user', text: 'hello' },
            { kind: 'text', role: 'agent', text: 'hi there' },
          ],
          messages: [
            { kind: 'text', role: 'user', text: 'hello' },
            { kind: 'text', role: 'agent', text: 'hi there' },
          ],
          history_window: { count: 2, truncated: false },
        }
      }
      return { revision: 1, value: body?.value ?? { version: 1 } }
    },
  }
  const agent = { selectModel() {}, session: {}, ctx: { sessions: { flush: async () => {} } } }
  let importedSeed = null
  const services = {
    workspaceRegistry: {
      archivedSessionIds: archived,
      list: () => [workspace],
      resolveByPath: async () => workspace,
      archiveSession: async id => { archived.push(id) },
      unarchiveSession: async () => {},
    },
    kodeAgents: {
      profiles: {
        list: () => [{ id: 'kode-cursor', name: 'cursor', type: 'cursor' }],
        bindings,
        binding: id => bindings[id],
        bindNative: async (id, profileId, threadId) => {
          bindings[id] = { profile: { id: profileId, name: 'cursor', type: 'cursor' }, threadId }
        },
      },
      recordBinding() {},
    },
    kodeNativeFactory: {
      importHistory: async (id, seed) => { importedSeed = { id, seed } },
      release: async () => {},
    },
    sessionController: {
      list: async () => ({ items }),
      create: async req => { items.push({ sessionId: req.sessionId, blank: false, running: false, updatedAt: 20 }); return { sessionId: req.sessionId } },
      resolveAgent: async () => ({ agent }),
      rename: async () => {},
    },
  }
  const ctx = { get: key => services[key] }
  const result = await importSavedSession(ctx, client, {
    backend_key: 'cursor',
    session_id: 'cursor-thread-1',
    cwd,
    title: 'Cursor Chat',
  })
  assert.equal(result.imported, true)
  assert.notEqual(result.sessionId, zombieId)
  assert.ok(importedSeed && importedSeed.seed.length > 0, 'fresh copy should receive real history seed')
  assert.ok(archived.includes(zombieId), 'blank zombie copy should be archived')
})

test('reopening a blank copy of an empty native thread keeps its identity', async () => {
  const cwd = '/tmp/cursor-empty', id = 'session-kode-empty'
  const bindings = { [id]: { profile: { id: 'kode-cursor', name: 'cursor', type: 'cursor' }, threadId: 'empty-thread' } }
  const workspace = { id: 'ws-1', path: cwd, attachSession: async () => {} }
  const services = {
    workspaceRegistry: { archivedSessionIds: [], list: () => [workspace], archiveSession: async () => assert.fail('nothing to retire') },
    kodeAgents: { profiles: { list: () => [bindings[id].profile], bindings, binding: key => bindings[key] } },
    kodeNativeFactory: { importHistory: async () => assert.fail('empty history must not create another copy') },
    sessionController: { list: async () => ({ items: [{ sessionId: id, blank: true, running: false, updatedAt: 1 }] }) },
  }
  const client = { call: async path => path.endsWith('/runtime/sessions') ? { sessions: [] }
    : path.endsWith('/transcript') ? { available: true, timeline: [], history_window: { count: 0, truncated: false } }
      : { revision: 1, value: { version: 1 } } }
  const tab = { backend_key: 'cursor', session_id: 'empty-thread', cwd, title: 'Empty' }
  for (let i = 0; i < 2; i++) {
    const result = await importSavedSession({ get: key => services[key] }, client, tab)
    assert.equal(result.sessionId, id); assert.equal(result.imported, false)
  }
})

test('opening the active local DSH owner uses its native composer without importing history', async () => {
  const h = importFixture()
  const owner = 'local-owner'
  const live = { runtime: 'dsh', backend_key: h.tab.backend_key, native_thread_id: h.tab.session_id,
    runtime_session_id: owner, status: 'busy', owner_alive: true }
  const ctx = { get: name => name === 'agents' ? new Map([[owner, {}]]) : h.ctx.get(name) }
  ctx.get('kodeAgents').profiles.binding = id => id === owner ? { threadId: h.tab.session_id } : undefined
  h.client.call = async path => { assert.ok(path.endsWith('/runtime/sessions')); return { sessions: [live] } }
  assert.deepEqual(await importSavedSession(ctx, h.client, h.tab), { sessionId: owner, imported: false })
  assert.deepEqual(await importSavedSession(h.ctx, h.client, h.tab), { sharedSession: live, imported: false })
  assert.deepEqual(h.calls, [])
})

test('directory admission retrieves the exact Host summary without activating an Agent', async () => {
  const summary = { sessionId: 'handoff', agentAvailable: true, running: false, updatedAt: 123 }
  const directory = new NativeSessionDirectory({ get(name) {
    assert.equal(name, 'sessionController')
    return { list: async () => ({ items: [summary] }) }
  } })
  assert.deepEqual(await directory.open({ sessionId: 'handoff', lookupOnly: true }), { sessionId: 'handoff', summary })
  await assert.rejects(directory.open({ sessionId: 'other', lookupOnly: true }), /找不到此会话/)
})
