import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { installSessionCreator } from '../src/session-create.js'
import { backendProfile } from '../src/workbench-import.js'
import { Session } from '@deepseek-ai/dsh-session'
function fixture() {
  let state = null, revision = 0, creator, starts = 0, creations = 0
  const selections = [], createdIds = []
  const permissions = [], client = { call: async (_path, update) => { if (!update) return { value: state && structuredClone(state), revision }; assert.equal(update.expected_revision, revision); state = JSON.parse(JSON.stringify(update.value)); return { value: state, revision: ++revision } } }
  const binding = {}, profile = { id: 'worker', name: '远端代码助手', type: 'codex' }
  const agent = { id: '', session: { header: { cwd: '/example/project' }, snapshotEvents: () => [] },selectModel(value){ selections.push(value) }, followup: () => { starts++ }, ctx: { sessions: { flush: async () => {} } } }
  const workspace = { id: 'workspace', path: '/example/project', title: '项目', sessionIds: [], async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) } }
  const services = {
    agents: { get: id => createdIds.includes(id) ? agent : undefined },
    kodeAgents: { profiles: { list: () => [profile], binding: id => binding[id], bind: async id => binding[id] = { profile } }, hasRuntime: () => true, recordBinding() {}, adapter: { listModels: async () => [{ id: 'real-model', isDefault: true }] } },
    workspaceRegistry: { list: () => [workspace], archivedSessionIds: [] },
    sessionController: { create: async request => { creations++; createdIds.push(request.sessionId); agent.id = request.sessionId; return { sessionId: request.sessionId } }, resolveAgent: async () => ({ agent }), selectModel: async () => {}, rename: async () => {} },
    permissionPresets: { set: (_session, mode) => permissions.push(mode) },
  }
  const restart = () => installSessionCreator({ get: name => services[name], provide: (_name,value) => creator=value, effect() {} },client,'host.example')
  restart()
  return { create: (...args) => creator.create(...args), lookup: (...args) => creator.lookup(...args), restart, agent, profile, services, starts: () => starts, creations: () => creations, permissions, selections, createdIds, state: () => structuredClone(state), seed: value => { state = structuredClone(value) } }

}
test('creation retries share one durable identity and submit the task once', async () => {
  const h=fixture(), input={title:'问题排查',task:'请帮我检查环境',idempotency_key:'create-one'}
  const [a,b]=await Promise.all([h.create(input),h.create(input)])
  assert.deepEqual(a,b);assert.equal(h.starts(),1)
  assert.deepEqual(await h.create(input),a);assert.equal(h.starts(),1)
  await assert.rejects(h.create({...input,task:'another task'}),/different task/)
  assert.deepEqual(h.permissions,['workspace-write'])
})
test('new helper cannot escalate a read-only caller',async()=>{
  const h=fixture(), source={id:'reader',session:{header:{}},ctx:{get:name=>name==='sandboxPolicy'?{resolve:()=>({mode:'read-only'})}:undefined}}
  await assert.rejects(h.create({title:'helper',task:'inspect',idempotency_key:'deny',permission:'danger-full-access'},source),/cannot escalate/)
  assert.equal(h.starts(),0)
})
test('model-created helper waits for its durable peer assignment and inherits read-only policy',async()=>{
  const h=fixture(), source={id:'reader',session:{header:{}},ctx:{get:name=>name==='sandboxPolicy'?{resolve:()=>({mode:'read-only'})}:undefined}}
  const result=await h.create({title:'helper',task:'inspect',idempotency_key:'delegate'},source)
  assert.equal(result.status,'ready');assert.equal(h.starts(),0);assert.deepEqual(h.permissions,['read-only'])
})
test('Kode declarations select the protocol while preserving custom executable names',()=>{
  assert.deepEqual(backendProfile('team-worker',{command:'/example/tcodex',args:[],mcp_setup:{style:'codex'}}),{id:'kode-team-worker',name:'team-worker',type:'codex',executable:'/example/tcodex',args:[]})
  assert.equal(backendProfile('worker',{command:'worker',enabled:false,mcp_setup:{style:'claude'}}),undefined)
  assert.equal(backendProfile('company-buddy',{command:'company-cli',mcp_setup:{style:'codebuddy'}}).type,'codebuddy')
})

test('creation never selects the first of multiple target workspaces',async()=>{
  let creator, created=0
  const profiles={list:()=>[{id:'worker',name:'Worker',type:'codex'}],reload:async()=>{}}
  let value=null,revision=0
  const client={call:async(_path,body)=>body?({value:value=structuredClone(body.value),revision:++revision}):({value:structuredClone(value),revision})}
  const workspaces=[{id:'a',title:'A',path:'/example/a'},{id:'b',title:'B',path:'/example/b'}]
  const ctx={get:name=>name==='kodeAgents'?{profiles,hasRuntime:()=>true}:name==='workspaceRegistry'?{list:()=>workspaces,get:id=>workspaces.find(row=>row.id===id)}:name==='sessionController'?{create:async()=>{created++}}:undefined,provide:(_key,service)=>creator=service,effect(){}}
  installSessionCreator(ctx,client,'server.example')
  await assert.rejects(creator.create({title:'Helper',task:'Inspect',idempotency_key:'no-workspace'}),/Select a Kode workspace/)
  await assert.rejects(creator.create({title:'Helper',task:'Inspect',workspace_id:'local-only-id',idempotency_key:'wrong-host'}),/does not exist on this execution Host/)
  assert.equal(created,0)
})

const readOnlySource = () => ({ id: 'reader', session: { header: {} }, ctx: { get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only' }) } : undefined } })
test('creation promotes the official executor and applies read-only permission to both sessions', async () => {
  const h = fixture(), native = { ...h.agent, session: { header: { cwd: '/example/project' } } }
  delete h.agent.selectModel
  let promoted = 0
  h.services.kodeNativeFactory = { promote: async (agent, selection) => {
    assert.equal(agent, h.agent); assert.equal(selection.model, 'real-model'); promoted++
    native.id = agent.id
    return native
  } }
  const result = await h.create({ title: 'Helper', task: 'Inspect', idempotency_key: 'promote' }, readOnlySource())
  assert.equal(promoted, 1); assert.equal(result.status, 'ready'); assert.equal(h.starts(), 0)
  assert.deepEqual(h.permissions, ['read-only', 'read-only'])
  assert.deepEqual(h.selections, [{ provider: 'kode-agent-worker', model: 'real-model' }])
})
test('failed promotion recovers the same half-created identity and submits once on retry', async () => {
  const h = fixture(), select = h.agent.selectModel
  delete h.agent.selectModel
  const input = { title: 'Helper', task: 'Inspect', model: 'real-model', idempotency_key: 'recover' }
  let attempt = 0
  h.services.kodeNativeFactory = { promote: async agent => {
    if (++attempt === 1) throw new Error('fixture promotion failed')
    agent.selectModel = select
    return agent
  } }
  await assert.rejects(h.create(input), /promotion failed/)
  const prior = Object.values(h.state().creations)[0]
  assert.equal(prior.stage, 'created'); assert.equal(h.starts(), 0)
  const result = await h.create(input)
  assert.equal(result.address.session_id, prior.sessionId)
  assert.deepEqual(h.createdIds, [prior.sessionId])
  assert.equal(Object.values(h.state().creations)[0].inputId, prior.inputId)
  assert.equal(h.starts(), 1); assert.deepEqual(await h.create(input), result); assert.equal(h.starts(), 1)
})
test('explicit models are validated and passed as discovery hints without changing the shared profile', async () => {
  const h = fixture(), probes = []
  h.services.kodeAgents.adapter.listModels = async (...args) => { probes.push(args); return [{ id: 'default-model', isDefault: true }, { id: 'deepseek-v4.1-flash', name: 'Flash' }] }
  const result = await h.create({ title: 'Helper', task: 'Inspect', model: 'deepseek-v4.1-flash', idempotency_key: 'model' })
  assert.equal(probes[0][2], 'deepseek-v4.1-flash'); assert.equal(result.model, 'deepseek-v4.1-flash')
  assert.equal(h.selections[0].model, result.model)
  assert.equal(h.services.kodeAgents.profiles.list()[0].defaultModel, undefined)
  await assert.rejects(h.create({ title: 'Helper', task: 'Inspect', model: 'other', idempotency_key: 'model' }), /different task/)
})
test('unadvertised models fail before creating a session and never fall back to the default', async () => {
  const h = fixture()
  await assert.rejects(h.create({ title: 'Helper', task: 'Inspect', model: 'missing-model', idempotency_key: 'missing' }), /未公布该模型/)
  assert.equal(h.createdIds.length, 0); assert.equal(h.starts(), 0)
})
test('legacy unsubmitted requests may add a model while retaining their original creation key and input identity', async () => {
  const h = fixture(), input = { title: 'Helper', task: 'Inspect', agent: '远端代码助手', idempotency_key: 'legacy' }
  const digest = value => createHash('sha256').update(value).digest('hex')
  const key = digest('owner:legacy'), identity = { title: input.title, task: input.task, agent: input.agent }
  h.seed({ version: 1, creations: { [key]: { sessionId: 'session-original', inputId: 'input-original', fingerprint: digest(JSON.stringify(identity)), stage: 'prepared' } } })
  const result = await h.create({ ...input, model: 'real-model' })
  assert.equal(result.address.session_id, 'session-original')
  assert.equal(h.state().creations[key].inputId, 'input-original'); assert.equal(h.starts(), 1)
})
test('concurrent retries reject a different model rather than returning another request result', async () => {
  const h = fixture(), gate = Promise.withResolvers()
  h.services.kodeAgents.adapter.listModels = () => gate.promise
  const input = { title: 'Helper', task: 'Inspect', model: 'real-model', idempotency_key: 'inflight' }
  const first = h.create(input)
  await assert.rejects(h.create({ ...input, model: 'different-model' }), /different task/)
  gate.resolve([{ id: 'real-model' }]); await first
  assert.equal(h.starts(), 1)
})
test('a retry retains its resolved default model when the profile default changes', async () => {
  const h = fixture(), profile = h.services.kodeAgents.profiles.list()[0]
  h.services.kodeAgents.adapter.listModels = async () => [{ id: 'real-model', isDefault: true }, { id: 'new-default' }]
  let attempt = 0
  h.services.sessionController.rename = async () => { if (++attempt === 1) throw new Error('fixture rename failed') }
  const input = { title: 'Helper', task: 'Inspect', idempotency_key: 'default-retry' }
  await assert.rejects(h.create(input), /rename failed/)
  profile.defaultModel = 'new-default'
  assert.equal((await h.create(input)).model, 'real-model')
  assert.equal(h.starts(), 1)
})

test('new sessions apply the configured default model, effort and Fast preference', async () => {
  const h = fixture(), profiles = h.services.kodeAgents.profiles, probes = []
  profiles.defaultProfileId = 'worker'
  profiles.defaultModelFor = () => ({ model: 'fast-model', reasoningEffort: 'high', fast: true })
  h.services.kodeAgents.adapter.listModels = async (...args) => {
    probes.push(args)
    return [{ id: 'real-model', isDefault: true }, { id: 'fast-model', ...(args[2] === 'fast-model' ? { reasoningEfforts: [{ id: 'medium' }, { id: 'high' }], defaultReasoningEffort: 'medium', fastCapability: { transport: 'service-tier', tier: 'priority', defaultEnabled: false } } : {}) }]
  }
  h.agent.session = Session.create('default-model-session')
  h.agent.session = Session.create('default-model-session', [], { ...h.agent.session.header, cwd: '/example/project' })
  const result = await h.create({ title: 'Helper', task: 'Inspect', idempotency_key: 'default-model' })
  assert.equal(probes[0][2], 'fast-model', 'ACP discovery receives the configured default model')
  assert.equal(result.model, 'fast-model')
  assert.deepEqual(h.selections, [{ provider: 'kode-agent-worker', model: 'fast-model', reasoningEffort: 'high' }])
  const fast = h.agent.session.snapshotEvents().find(event => event.type === 'plugin:kode/model-fast')
  assert.equal(fast.data.fast, true); assert.equal(fast.data.serviceTier, 'priority')
  assert.deepEqual(Object.values(h.state().creations)[0].selection, { model: 'fast-model', reasoningEffort: 'high', fast: true })
})

test('a partial native session with new activity cannot replay the creation task', async () => {
  const h = fixture(), input = { title: 'Helper', task: 'Inspect', idempotency_key: 'already-used' }
  h.services.sessionController.rename = async () => { throw new Error('fixture rename failed') }
  await assert.rejects(h.create(input), /rename failed/)
  h.agent.session.snapshotEvents = () => [{ type: 'turn/start' }]
  await assert.rejects(h.create(input), /already has activity/)
  assert.equal(h.createdIds.length, 1); assert.equal(h.starts(), 0)
})

test('creation promotes an official executor that cannot select Kode models',async()=>{
  let state=null,revision=0,creator,promoted=0
  const client={call:async(_p,u)=>{if(!u)return{value:state&&structuredClone(state),revision};state=structuredClone(u.value);return{value:state,revision:++revision}}}
  const profile={id:'worker',name:'Codex',type:'codex'},selections=[]
  const official={id:'',session:{header:{cwd:'/example/project'}}}
  const native={id:'',session:{header:{cwd:'/example/project'}},selectModel:s=>selections.push(s),followup(){},ctx:{sessions:{flush:async()=>{}}}}
  const services={
    kodeAgents:{profiles:{list:()=>[profile],binding:()=>undefined,bind:async()=>{}},hasRuntime:()=>true,recordBinding(){},adapter:{listModels:async()=>[{id:'real-model',isDefault:true}]}},
    workspaceRegistry:{list:()=>[{id:'workspace',path:'/example/project',title:'项目'}]},
    sessionController:{create:async r=>{official.id=native.id=r.sessionId;return{sessionId:r.sessionId}},resolveAgent:async()=>({agent:official}),rename:async()=>{}},
    kodeNativeFactory:{promote:async(agent,selection)=>{assert.equal(agent,official);assert.deepEqual(selection,{provider:'kode-agent-worker',model:'real-model'});promoted++;return native}},
  }
  installSessionCreator({get:n=>services[n],provide:(_n,v)=>creator=v,effect(){}},client,'host.example')
  const result=await creator.create({agent:'Codex',title:'接手',task:'读文档',idempotency_key:'promote'})
  assert.equal(promoted,1);assert.deepEqual(selections,[{provider:'kode-agent-worker',model:'real-model'}]);assert.equal(result.status,'started')
})

 test('concurrent conflicting creation keys reject rather than joining another task', async () => {
  const h = fixture(), input = { title: 'helper', task: 'first task', idempotency_key: 'concurrent' }
  const first = h.create(input)
  await assert.rejects(h.create({ ...input, task: 'different task' }), /different task/)
  await first
  assert.equal(h.creations(), 1)
  assert.equal(h.starts(), 1)
})
 test('read-only callers cannot request workspace-write or leave a created session behind', async () => {
  const h = fixture()
  const source = { id: 'reader', session: { header: {} }, ctx: { get: name => name === 'sandboxPolicy' ? { resolve: () => ({ mode: 'read-only' }) } : undefined } }
  await assert.rejects(h.create({ title: 'helper', task: 'write', idempotency_key: 'write-denied', permission: 'workspace-write' }, source), /cannot escalate/)
  assert.equal(h.creations(), 0)
  assert.equal(h.starts(), 0)
  assert.deepEqual(h.permissions, [])
})
 test('an agent with unavailable authority fails closed before creating a session', async () => {
  const h = fixture(), source = { id: 'unknown', session: { header: {} }, ctx: { get: () => undefined } }
  await assert.rejects(h.create({ title: 'helper', task: 'inspect', idempotency_key: 'no-policy' }, source), /cannot escalate/)
  assert.equal(h.creations(), 0)
})

test('creation lookup survives creator restart without starting or recreating the session', async () => {
  const h = fixture(), input = { title: 'helper', task: 'inspect', idempotency_key: 'lookup' }
  assert.deepEqual(await h.lookup(input), { status: 'not_found' })
  assert.equal(h.creations(), 0)
  const result = await h.create(input)
  h.restart()
  const status = await h.lookup({ idempotency_key: input.idempotency_key })
  assert.equal(status.status, 'completed')
  assert.deepEqual(status.result, result)
  assert.equal(h.creations(), 1)
  assert.equal(h.starts(), 1)
})
test('submission with lost flush confirmation stays uncertain across restart and is never replayed', async () => {
  const h = fixture(), input = { title: 'helper', task: 'inspect', idempotency_key: 'uncertain' }
  h.agent.ctx.sessions.flush = async () => { throw new Error('flush interrupted') }
  await assert.rejects(h.create(input), /flush interrupted/)
  h.restart()
  const status = await h.lookup(input)
  assert.equal(status.status, 'uncertain')
  assert.equal(status.stage, 'submitting')
  assert.equal(status.result, undefined)
  await assert.rejects(h.create(input), /outcome is uncertain/)
  assert.equal(h.creations(), 1)
  assert.equal(h.starts(), 1)
})
test('creation lookup is scoped to its requester and does not expose task contents', async () => {
  const h = fixture(), input = { title: 'helper', task: 'private task', idempotency_key: 'scoped', requester: 'remote.example/alice' }
  await h.create(input)
  assert.equal((await h.lookup(input)).status, 'completed')
  assert.deepEqual(await h.lookup({ ...input, requester: 'remote.example/bob' }), { status: 'not_found' })
  assert.deepEqual(await h.lookup(input, { id: 'bob' }), { status: 'not_found' })
  assert.doesNotMatch(JSON.stringify(await h.lookup(input)), /private task|fingerprint|inputId/)
  assert.equal(h.starts(), 0)
})

test('explicit creation model and effort are validated before session creation and included in identity', async () => {
  const h = fixture(), selected = []
  h.services.kodeAgents.adapter.listModels = async () => [{ id: 'small', isDefault: true, reasoningEfforts: [{ id: 'low' }] }, { id: 'large' }]
  h.agent.selectModel = selection => selected.push(selection)
  const input = { title: 'Selected worker', task: 'Fixture', idempotency_key: 'selection', model: 'small', reasoningEffort: 'low' }
  const result = await h.create(input)
  assert.deepEqual(selected, [{ provider: 'kode-agent-worker', model: 'small', reasoningEffort: 'low' }])
  assert.equal(result.selection.verification, 'requested')
  await assert.rejects(h.create({ ...input, model: 'large' }), /different task/)
  const bad = fixture()
  await assert.rejects(bad.create({ ...input, model: 'missing' }), /模型/)
  assert.equal(bad.creations(), 0)
  await assert.rejects(bad.create({ ...input, idempotency_key: 'bad-effort', model: 'real-model' }), /reasoning effort/)
  assert.equal(bad.creations(), 0)
})
test('prepared selection cannot drift after a partial creation and profile change', async () => {
  const h = fixture(), input = { title: 'Stable worker', task: 'Fixture', idempotency_key: 'frozen-selection' }
  h.agent.selectModel = async () => { throw new Error('fixture selection failed') }
  await assert.rejects(h.create(input), /selection failed/)
  assert.equal(h.starts(), 0)
  h.profile.executable = '/example/changed-codex'
  h.restart()
  await assert.rejects(h.create(input), /configuration changed/)
  assert.equal(h.creations(), 1)
})


test('creation side effect with lost response resolves its original identity without a second create', async () => {
  const h = fixture(), input = { title: 'Recover', task: 'Fixture', idempotency_key: 'lost-create' }
  const create = h.services.sessionController.create
  h.services.sessionController.create = async args => { await create(args); throw new Error('response lost') }
  await assert.rejects(h.create(input), /response lost/)
  assert.equal((await h.lookup(input)).status, 'uncertain')
  assert.equal(h.creations(), 1); assert.equal(h.starts(), 0)
  h.restart()
  const result = await h.create(input)
  assert.equal(result.address.session_id, h.agent.id)
  assert.equal(h.creations(), 1); assert.equal(h.starts(), 1)
})
test('unresolved or already active partial creation never calls create again', async () => {
  for (const active of [false, true]) {
    const h = fixture(), input = { title: 'Recover', task: 'Fixture', idempotency_key: 'blocked-create' }
    const create = h.services.sessionController.create
    h.services.sessionController.create = async args => { await create(args); throw new Error('response lost') }
    await assert.rejects(h.create(input), /response lost/)
    if (active) h.agent.session.snapshotEvents = () => [{ type: 'turn/start' }]
    else h.services.sessionController.resolveAgent = async () => ({ error: { message: 'not found' } })
    h.restart()
    await assert.rejects(h.create(input), /uncertain|proven blank/)
    assert.equal(h.creations(), 1); assert.equal(h.starts(), 0)
  }
})

test('late create response cannot rewind a recovered operation or submit twice', async () => {
  const h = fixture(), input = { title: 'Recover', task: 'Fixture', idempotency_key: 'late-create' }
  const create = h.services.sessionController.create
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), blocked = new Promise(resolve => { release = resolve })
  h.services.sessionController.create = async args => { const result = await create(args); entered(); await blocked; return result }
  const original = h.create(input)
  await started
  h.restart()
  try {
    const recovered = await h.create(input)
    release()
    assert.deepEqual(await original, recovered)
    assert.equal(h.creations(), 1); assert.equal(h.starts(), 1)
    assert.equal((await h.lookup(input)).status, 'completed')
  } finally { release(); await original }
})

test('partial creation recovery refuses moved, archived or unconfirmed workspace membership', async () => {
  for (const failure of ['cwd', 'archived', 'moved', 'unconfirmed', 'unavailable']) {
    const h = fixture(), input = { title: 'Helper', task: 'Inspect', idempotency_key: `membership-${failure}` }
    const original = h.services.sessionController.create
    h.services.sessionController.create = async request => { await original(request); throw new Error('lost response') }
    await assert.rejects(h.create(input), /lost response/)
    const registry = h.services.workspaceRegistry, workspace = registry.list()[0]
    if (failure === 'cwd') h.agent.session.header.cwd = '/example/other'
    if (failure === 'archived') registry.archivedSessionIds.push(h.agent.id)
    if (failure === 'moved') registry.list = () => [workspace, { id: 'other', sessionIds: [h.agent.id] }]
    if (failure === 'unconfirmed') workspace.attachSession = async () => {}
    if (failure === 'unavailable') delete workspace.sessionIds
    h.restart()
    await assert.rejects(h.create(input), /workspace|archived/)
    assert.equal(h.starts(), 0); assert.equal(h.creations(), 1)
    assert.equal((await h.lookup(input)).status, 'uncertain')
  }
})


test('legacy partial plans recover after JSON persistence without adding another session', async () => {
  const h = fixture(), input = { title: 'Legacy helper', task: 'Inspect', idempotency_key: 'legacy-plan' }
  h.profile.defaultModel = 'real-model'
  let attempt = 0
  h.services.sessionController.rename = async () => { if (++attempt === 1) throw new Error('fixture rename failed') }
  await assert.rejects(h.create(input), /rename failed/)
  const state = h.state()
  delete Object.values(state.creations)[0].plan.profile_defaults
  h.seed(state); h.restart()
  const result = await h.create(input)
  assert.equal(result.model, 'real-model')
  assert.equal(h.creations(), 1); assert.equal(h.starts(), 1)
})
