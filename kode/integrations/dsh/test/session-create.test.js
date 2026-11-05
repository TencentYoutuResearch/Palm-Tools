import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { installSessionCreator } from '../src/session-create.js'
import { backendProfile } from '../src/workbench-import.js'
import { Session } from '@deepseek-ai/dsh-session'
function fixture() {
  let state = null, revision = 0, creator, starts = 0
  const selections = [], createdIds = []
  const permissions = [], client = { call: async (_path, update) => { if (!update) return { value: state && structuredClone(state), revision }; assert.equal(update.expected_revision, revision); state = structuredClone(update.value); return { value: state, revision: ++revision } } }
  const binding = {}, profile = { id: 'worker', name: '远端代码助手', type: 'codex' }
  const agent = { id: '', session: { header: { cwd: '/example/project' } },selectModel(value){ selections.push(value) }, followup: () => { starts++ }, ctx: { sessions: { flush: async () => {} } } }
  const services = {
    agents: { get: id => createdIds.includes(id) ? agent : undefined },
    kodeAgents: { profiles: { list: () => [profile], binding: id => binding[id], bind: async id => binding[id] = { profile } }, hasRuntime: () => true, recordBinding() {}, adapter: { listModels: async () => [{ id: 'real-model', isDefault: true }] } },
    workspaceRegistry: { list: () => [{ id: 'workspace', path: '/example/project', title: '项目' }] },
    sessionController: { create: async request => { createdIds.push(request.sessionId); agent.id = request.sessionId; return { sessionId: request.sessionId } }, resolveAgent: async () => ({ agent }), selectModel: async () => {}, rename: async () => {} },
    permissionPresets: { set: (_session, mode) => permissions.push(mode) },
  }
  installSessionCreator({ get: name => services[name], provide: (_name,value) => creator=value, effect() {} },client,'host.example')
  return { create: (...args) => creator.create(...args), starts: () => starts, permissions, services, agent, selections, createdIds, state: () => structuredClone(state), seed: value => { state = structuredClone(value) } }
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
  assert.equal(prior.stage, 'prepared'); assert.equal(h.starts(), 0)
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
