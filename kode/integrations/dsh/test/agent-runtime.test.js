import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AgentRuntimeAdapter, profileRoute } from '../src/agent-runtime.js'
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
    const first = input('one', 'TOOL first'), second = input('two', 'second')
    const results = await Promise.all([consume(adapter.stream(request('first', 'codex', [first]))), consume(adapter.stream(request('second', 'tcodex', [second])))])
    assert.equal(results[0].find(c => c.type === 'text-delta').text, 'codex: TOOL first')
    assert.equal(results[1].find(c => c.type === 'text-delta').text, 'tcodex: second')
    assert.equal(calls, 1)
    assert.ok(events.some(e => e.type === 'tool/result'))
    assert.equal(profiles.binding('first').threadId, profiles.binding('second').threadId)
    assert.notEqual(profiles.binding('first').profile.id, profiles.binding('second').profile.id)
    await assert.rejects(consume(adapter.stream(request('first', 'codex', [first]))), /refusing to replay/)
    await adapter.close()
    adapter = new AgentRuntimeAdapter(ctx, await new AgentProfiles(profiles.path).open(), { recordNative: (session, data) => session.append("plugin:kode/native-event", data) })
    const followup = await consume(adapter.stream(request('first', 'codex', [first, input('three', 'followup after restart')])))
    assert.equal(followup.find(c => c.type === 'text-delta').text, 'codex: followup after restart')
    const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    const turns = records.filter(r => r.method === 'turn/start')
    assert.equal(records.filter(r => r.method === 'model/list').length, 1, 'global and per-session catalogs share discovery for the same profile snapshot')
    assert.equal(turns.length, 3)
    assert.deepEqual(turns[0].params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [root] })
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
  const adapter = new AgentRuntimeAdapter({ agents: { get: () => agent }, sessionProjections: { stateOf: () => ({ lastTurn: 1, lastStepBoundary: { step: 1 } }) } }, profiles, { recordNative: () => {} })
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
