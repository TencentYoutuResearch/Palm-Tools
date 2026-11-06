import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProfiles, profileRevision } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, discoveryRevision, installAgentRuntime, profileRoute } from '../src/agent-runtime.js'
import { CodexSession } from '../src/codex-session.js'
const fixture = fileURLToPath(new URL('./fixture-codex-server.js', import.meta.url))
const consume = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
test('dsh runtime binds profiles, forwards dynamic tools, persists native identity and refuses input replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-dsh-native-')), log = join(root, 'wire.jsonl')
  const profiles = await new AgentProfiles(join(root, 'agents.json')).open(['codex', 'tcodex'].map(id => ({ id, name: id, type: 'codex', executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_AGENT_LABEL: id, KODE_FIXTURE_RPC_LOG: log } })))
  const events = [], agents = new Map()
  let calls = 0
  const makeAgent = id => ({ id, session: { header: { cwd: root }, append: (type, data) => events.push({ type, data }) }, ctx: {
    parallel: async () => {}, get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } : undefined,
    tools: { execute: async exec => { assert.equal(exec.agent.id, id); calls++; return { isError: false, content: [{ type: 'text', text: 'session directory' }] } } },
  } })
  agents.set('first', makeAgent('first')); agents.set('second', makeAgent('second'))
  const ctx = { agents: { get: id => agents.get(id) }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', seq: 1 } }) } }
  let adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: (session, data) => session.append("plugin:kode/native-event", data) })
  const request = (sessionId, profileId, messages) => ({ sessionId, provider: profileRoute(profileId), model: 'fixture', messages,
    tools: [{ name: 'kode_sessions_list', description: 'list', parameters: { type: 'object' } }], signal: AbortSignal.timeout(5000) })
  const input = (id, text) => ({ role: 'user', id, source: { kind: 'human' }, content: [{ type: 'text', text }] })
  try {
    await Promise.all([adapter.listModels(profileRoute('codex')), adapter.listModels(profileRoute('codex'), profiles.get('codex'))])
    const catalog = await adapter.capabilities(profileRoute('codex'))
    assert.equal(catalog.commands.find(row => row.name === 'fixture-skill').kind, 'skill')
    assert.equal(catalog.models[0].fastCapability.tier, 'priority')
    const first = input('one', 'TOOL first'), second = input('two', 'second')
    const results = await Promise.all([consume(adapter.stream({ ...request('first', 'codex', [first]), reasoningEffort: 'low' })), consume(adapter.stream(request('second', 'tcodex', [second])))])
    assert.equal(results[0].find(c => c.type === 'text-delta').text, 'codex: TOOL first')
    assert.equal(results[1].find(c => c.type === 'text-delta').text, 'tcodex: second')
    assert.equal(calls, 1)
    const selection = profiles.binding('first').selectionEvidence
    assert.equal(selection.model.status, 'acknowledged')
    assert.equal(selection.model.observed, undefined, 'turn acceptance cannot prove actual inference model')
    assert.deepEqual(selection.inputIds, ['one'])
    assert.ok(events.some(e => e.data?.event?.method === 'kode/selection_evidence'))
    assert.ok(events.some(e => e.type === 'tool/result'))
    assert.equal(profiles.binding('first').threadId, profiles.binding('second').threadId)
    assert.notEqual(profiles.binding('first').profile.id, profiles.binding('second').profile.id)
    await assert.rejects(consume(adapter.stream(request('first', 'codex', [first]))), /refusing to replay/)
    await adapter.close()
    adapter = new AgentRuntimeAdapter(ctx, await new AgentProfiles(profiles.path).open(), { recordNative: (session, data) => session.append("plugin:kode/native-event", data) })
    const followup = await consume(adapter.stream({ ...request('first', 'codex', [first, input('three', 'followup after restart')]), fast: true }))
    assert.equal(followup.find(c => c.type === 'text-delta').text, 'codex: followup after restart')
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    const turns = records.filter(r => r.method === 'turn/start')
    assert.equal(records.filter(r => r.method === 'model/list').length, 1, 'global and per-session catalogs share discovery for the same profile snapshot')
    assert.equal(turns.length, 3)
    assert.deepEqual(turns[0].params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [root] })
    assert.deepEqual(turns.map(turn => turn.params.serviceTierForTurn), [undefined, undefined, 'fast'])
    assert.ok(turns.some(turn => turn.params.effort === 'medium'), 'an incompatible restored effort falls back to the model default')
    assert.ok(turns.every(turn => turn.params.effort !== 'low'))
    assert.ok(records.some(r => r.method === 'thread/resume'))
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})
test('native Codex thought deltas and commands are observable before completion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-native-progress-'))
 const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'example',name:'Example',type:'codex',executable:process.execPath,args:[fixture]}])
 const events=[];let started;const running=new Promise(resolve=>started=resolve)
 const agent={id:'native-progress',session:{header:{cwd:root},append:(type,data)=>{events.push({type,data});if(type==='tool/call')started()}},ctx:{parallel:async()=>{},get:()=>undefined,tools:{execute:async()=>{throw new Error('A native command must not execute through the outer tools')}}}}
 const ctx={agents:{get:()=>agent},sessionProjections:{stateOf:()=>({lastTurn:1,lastStepBoundary:{kind:'start',step:1}})}}
 const adapter=new AgentRuntimeAdapter(ctx,profiles,{recordNative:()=>{}})
 try{
  const completion=consume(adapter.stream({sessionId:agent.id,provider:profileRoute('example'),model:'fixture',tools:[],messages:[{id:'input',role:'user',content:[{type:'text',text:'NATIVE_TRACE'}]}],signal:AbortSignal.timeout(5000)}))
  await running;assert.ok(events.some(e=>e.type==='tool/call'));assert.ok(!events.some(e=>e.type==='tool/result'))
  const chunks=await completion
  assert.equal(chunks.filter(c=>c.type==='reasoning-delta').map(c=>c.text).join(''),'Inspecting the workspace.')
  assert.equal(events.filter(e=>e.type==='tool/call').length,1);assert.equal(events.filter(e=>e.type==='tool/result').length,1)
  assert.equal(events.find(e=>e.type==='tool/call').data.name,'exec_command');assert.equal(JSON.parse(events.find(e=>e.type==='tool/call').data.arguments).cmd,'pwd')
  assert.deepEqual(Object.keys(JSON.parse(events.find(e=>e.type==='tool/call').data.arguments)),['cmd'])
  assert.equal(events.find(e=>e.type==='tool/result').data.message.isError,false)
 }finally{await adapter.close();await rm(root,{recursive:true,force:true})}
})

test('installed Codex supports concurrent native threads and model discovery without inference', { skip: !process.env.KODE_TEST_CODEX_EXECUTABLE }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-codex-live-'))
  const profile = { executable: process.env.KODE_TEST_CODEX_EXECUTABLE, env: { CODEX_HOME: root } }
  const probe = new CodexSession(profile, root), session = new CodexSession(profile, root), second = new CodexSession(profile, root)
  try {
    const tools = [{ name: 'kode_sessions_list', description: 'List sessions', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    const [id, otherId] = await Promise.all([session.open({}, tools, AbortSignal.timeout(15000)), second.open({}, tools, AbortSignal.timeout(15000))])
    assert.equal(typeof id, 'string')
    assert.ok(id.length)
    assert.notEqual(id, otherId)
    assert.equal(session.rpc.closed, false)
    assert.equal(second.rpc.closed, false)
    const models = await probe.listModels(AbortSignal.timeout(15000))
    assert.ok(Array.isArray(models))
  } finally { await Promise.all([probe.close(), session.close(), second.close()]); await rm(root, { recursive: true, force: true }) }
})

test('native ACP approvals follow the owning dsh session policy and full-access setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-native-approval-')), log = join(root, 'wire.jsonl')
  const acp = fileURLToPath(new URL('./fixture-acp-server.js', import.meta.url))
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([{ id: 'acp', name: 'ACP', type: 'custom', executable: process.execPath, args: [acp], env: { KODE_ACP_FIXTURE_LOG: log } }])
  let mode = 'workspace-write', policy = 'ask', prompted = 0
  const agent = { id: 'owned', session: { header: { cwd: root }, append() {} }, ctx: {
    parallel: async () => {}, tools: { execute: async () => { throw new Error('Unexpected delegated tool') } },
    get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode, workspaceRoot: root }) } : name === 'approval' ? { effectivePolicy: () => policy, request: async () => { prompted++; return 'rejected' } } : undefined,
  } }
  const adapter = new AgentRuntimeAdapter({ agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) } }, profiles, { recordNative: () => {} })
  const request = id => ({ sessionId: agent.id, provider: profileRoute('acp'), model: 'fixture-fast', tools: [], signal: AbortSignal.timeout(5000), messages: [{ id, role: 'user', content: [{ type: 'text', text: 'APPROVAL' }] }] })
  try {
    await consume(adapter.stream(request('first')))
    assert.equal(prompted, 1)
    mode = 'danger-full-access'; policy = 'never'
    await consume(adapter.stream(request('second')))
    assert.equal(prompted, 1, 'explicit full access never opens a human approval prompt')
    mode = 'read-only'
    await consume(adapter.stream(request('third')))
    assert.equal(prompted, 2, 'confined never does not inherit a full-access grant')
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(records.filter(r => r.method === 'permission-result').map(r => r.params.outcome.optionId), ['deny', 'allow', 'deny'])
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

test('Claude autocompact applies session SDK settings on the same resumed native thread',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kode-autocompact-')),log=join(root,'wire.jsonl')
 const profiles=await new AgentProfiles(join(root,'profiles.json')).open([{id:'claude-fixture',name:'Claude fixture',type:'claude',executable:process.execPath,args:[fileURLToPath(new URL('./fixture-acp-server.js',import.meta.url))],env:{KODE_ACP_FIXTURE_LOG:log}}])
 const events=[],session={header:{cwd:root},snapshotEvents:()=>events,append:(type,data)=>{const event={type,data,seq:events.length};events.push(event);return event}}
 const agent={id:'autocompact-fixture',session,ctx:{parallel:async()=>{},get:()=>undefined,tools:{execute:async()=>{throw new Error('No tools expected')}}}}
 const ctx={agents:{get:()=>agent},sessionProjections:{stateOf:()=>({lastTurn:1,lastStepBoundary:{kind:'start',step:1}})}}
 const adapter=new AgentRuntimeAdapter(ctx,profiles,{recordNative:()=>{},resolveProfile:async profile=>({...profile,type:'custom'})})
 const request=(id,text)=>({sessionId:agent.id,provider:profileRoute('claude-fixture'),model:'fixture-fast',messages:[{id,role:'user',source:{kind:'user'},content:[{type:'text',text}]}],tools:[],signal:AbortSignal.timeout(5000)})
 try{
  await consume(adapter.stream(request('one','first')))
  const thread=profiles.binding(agent.id).threadId
  session.append('plugin:kode/autocompact',{enabled:false})
  await consume(adapter.stream(request('two','second')))
  const rows=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.filter(row=>row.method==='session/new').length,1)
  const resumed=rows.find(row=>row.method==='session/load')
  assert.equal(resumed.params.sessionId,thread);assert.equal(resumed.params._meta.claudeCode.options.settings.autoCompactEnabled,false)
  assert.equal(profiles.binding(agent.id).profile.autoCompactEnabled,undefined,'launch profile remains immutable')
  assert.deepEqual(profiles.binding(agent.id).seenInputs,['one','two'])
 }finally{await adapter.close();await rm(root,{recursive:true,force:true})}
})

test('late native events cannot append a tool lifecycle after its step has closed',()=>{
 const writes=[],agent={id:'closed',session:{append:(...args)=>writes.push(args)}}
 const adapter=new AgentRuntimeAdapter({sessionProjections:{stateOf:()=>({lastTurn:1,lastStepBoundary:{kind:'end',step:1}})}},{},{recordNative(){}})
 assert.throws(()=>adapter.logCall(agent,'late','exec_command',{}),/open dsh step/)
 assert.throws(()=>adapter.logResult(agent,'late',[]),/open dsh step/)
 assert.equal(writes.length,0)
})

test('unconfirmed process stop is persisted and blocks input admission after adapter restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-stop-fence-'))
  const profiles = await new AgentProfiles(join(root, 'agents.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fixture] }])
  const events = [], agent = { id: 'worker', session: { header: { cwd: root } }, ctx: { parallel: async () => {} } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) } }
  let adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: (_, data) => events.push(data) })
  const evidence = { spawned: true, leader_exited: false, exit_code: null, exit_signal: null, signal_scope: 'process_group', descendants_confirmed: false, signal_failures: [] }
  const request = id => ({ sessionId: 'worker', provider: profileRoute('fixture'), model: 'fixture', messages: [{ id, role: 'user', content: [{ type: 'text', text: 'fixture' }] }] })
  let closeStarted, release
  const closing = new Promise(resolve => { closeStarted = resolve })
  const closed = new Promise(resolve => { release = resolve })
  adapter.createRuntime = async () => ({ nativeCalls: new Set(), async *turn() { throw new Error('fixture interrupted') }, close: async () => { closeStarted(); await closed; return evidence } })
  try {
    const first = consume(adapter.stream(request('first')))
    const rejected = assert.rejects(first, /fixture interrupted/)
    await closing
    await assert.rejects(consume(adapter.stream(request('overlap'))), /active native request/)
    release(); await rejected
    assert.equal(profiles.binding('worker').stopBlocked, true)
    assert.deepEqual(events.at(-1).event.params.inputIds, ['first'])
    assert.equal(events.at(-1).event.method, 'kode/process_stop')
    await adapter.close()
    const reopened = await new AgentProfiles(profiles.path).open()
    adapter = new AgentRuntimeAdapter(ctx, reopened, { recordNative: () => {} })
    await assert.rejects(consume(adapter.stream(request('second'))), /session is fenced/)
    assert.deepEqual(reopened.binding('worker').seenInputs, ['first'])
  } finally { release(); await adapter.close(); await rm(root, { recursive: true, force: true }) }
})

test('canceled native fixture records observed process exit without claiming descendant termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-stop-observation-'))
  const profiles = await new AgentProfiles(join(root, 'agents.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fixture] }])
  const events = [], agent = { id: 'worker', session: { header: { cwd: root }, append() {} }, ctx: { parallel: async () => {}, get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) } : undefined, tools: { execute: async () => ({ content: [] }) } } }
  const ctx = { agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) } }
  const adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: (_, data) => events.push(data) })
  const stop = new AbortController()
  try {
    await assert.rejects(consume(adapter.stream({ sessionId: 'worker', provider: profileRoute('fixture'), model: 'fixture', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]), onNativeTurnReady: () => stop.abort(new Error('fixture cancellation')), messages: [{ id: 'cancel-me', role: 'user', content: [{ type: 'text', text: 'WAIT' }] }] })), /fixture cancellation/)
    const observation = events.findLast(row => row.event.method === 'kode/process_stop').event.params
    assert.equal(observation.spawned, true)
    assert.equal(observation.leader_exited, true)
    assert.equal(observation.descendants_confirmed, false)
    assert.deepEqual(observation.inputIds, ['cancel-me'])
    assert.equal(profiles.binding('worker').lastOutcome, 'uncertain')
    assert.equal(profiles.binding('worker').stopBlocked, false)
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})


test('discovery reuses role-only edits but reprobes changed execution configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-discovery-revision-')), log = join(root, 'wire.jsonl')
  const profile = { id: 'fixture', name: 'Original', type: 'codex', executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_RPC_LOG: log } }
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open([profile])
  const adapter = new AgentRuntimeAdapter({}, profiles)
  const provider = profileRoute(profile.id)
  const count = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.method === 'model/list').length
  try {
    await adapter.capabilities(provider, profile, root)
    const assigned = { ...profile, name: 'Reviewer', responsibilities: ['review'], modelRoles: { fixture: ['reviewer'] }, pinned: true, assignedBy: 'owner' }
    assert.notEqual(profileRevision(profile), profileRevision(assigned), 'authority revisions still include assignment changes')
    assert.equal(discoveryRevision(profile), discoveryRevision(assigned))
    await adapter.capabilities(provider, assigned, root)
    assert.equal(await count(), 1, 'metadata edit must not launch a second process')
    const changed = { ...assigned, env: { ...assigned.env, KODE_FIXTURE_AGENT_LABEL: 'changed' } }
    await adapter.capabilities(provider, changed, root)
    assert.equal(await count(), 2, 'execution environment changes invalidate discovery')
    const changedArgs = { ...changed, args: [...changed.args, '--fixture-extra'] }
    await adapter.capabilities(provider, changedArgs, root)
    assert.equal(await count(), 3, 'argument changes invalidate discovery')
    adapter.invalidateModels(provider)
    await adapter.capabilities(provider, changedArgs, root)
    assert.equal(await count(), 4, 'explicit refresh still reprobes')
    const wire = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(wire.every(row => row.method !== 'turn/start'), 'discovery never runs inference')
    assert.notEqual(discoveryRevision(changedArgs), discoveryRevision({ ...changedArgs, futureExecutionSetting: true }))
    assert.notEqual(discoveryRevision(changedArgs), discoveryRevision({ ...changedArgs, executable: '/fixture/another-executable' }))
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
})


test('profile save refresh preserves discovery while runtime replacement invalidates it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-discovery-refresh-')), log = join(root, 'wire.jsonl'), disposers = []
  const profile = { id: 'fixture', name: 'Original', type: 'codex', executable: process.execPath, args: [fixture], env: { KODE_FIXTURE_RPC_LOG: log } }
  const registration = Object.assign(() => {}, { replace() {} })
  const ctx = { sessionProjections: { register: () => () => {} }, effect: fn => disposers.push(fn()), on() {}, emit() {}, parallel: async () => {}, provide() {}, llm: { registerAdapter: () => registration } }
  try {
    const service = await installAgentRuntime(ctx, { agentProfilesFile: join(root, 'profiles.json'), agentProfiles: [profile] })
    const provider = profileRoute(profile.id)
    await service.adapter.listModels(provider)
    await service.profiles.save({ ...profile, name: 'Renamed' }); service.refresh()
    await service.adapter.listModels(provider)
    const count = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.method === 'model/list').length
    assert.equal(await count(), 1)
    const remove = service.registerRuntime('fixture-runtime', { name: 'Fixture', available: true })
    await service.adapter.listModels(provider)
    assert.equal(await count(), 2)
    await remove()
    await service.adapter.listModels(provider)
    assert.equal(await count(), 3)
  } finally { for (const dispose of disposers.reverse()) await dispose?.(); await rm(root, { recursive: true, force: true }) }
})

test('an exited leader does not release a native process-group fence without drainage evidence', async () => {
  for (const empty of [undefined, false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'kode-stop-group-'))
    const profiles = await new AgentProfiles(join(root, 'agents.json')).open([{ id: 'fixture', name: 'Fixture', type: 'codex', executable: process.execPath, args: [fixture] }])
    await profiles.bind('worker', 'fixture')
    const agent = { id: 'worker', session: {} }
    const ctx = { sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { kind: 'start', step: 1 } }) } }
    const adapter = new AgentRuntimeAdapter(ctx, profiles, { recordNative: () => {} })
    try {
      await adapter.recordStop(agent, { close: async () => ({ spawned: true, leader_exited: true, signal_scope: 'process_group', signal_failures: [], ...(empty === undefined ? {} : { process_group_empty: empty }) }) })
      assert.equal(profiles.binding('worker').stopBlocked, empty !== true)
      assert.equal((await new AgentProfiles(profiles.path).open()).binding('worker').stopBlocked, empty !== true)
    } finally { await adapter.close(); await rm(root, { recursive: true, force: true }) }
  }
})
