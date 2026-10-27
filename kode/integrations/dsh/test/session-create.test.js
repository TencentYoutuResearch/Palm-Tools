import test from 'node:test'
import assert from 'node:assert/strict'
import { installSessionCreator } from '../src/session-create.js'
import { backendProfile } from '../src/workbench-import.js'
function fixture() {
  let state = null, revision = 0, creator, starts = 0
  const permissions = [], client = { call: async (_path, update) => { if (!update) return { value: state && structuredClone(state), revision }; assert.equal(update.expected_revision, revision); state = structuredClone(update.value); return { value: state, revision: ++revision } } }
  const binding = {}, profile = { id: 'worker', name: '远端代码助手', type: 'codex' }
  const agent = { id: '', session: { header: { cwd: '/example/project' } }, followup: () => { starts++ }, ctx: { sessions: { flush: async () => {} } } }
  const services = {
    kodeAgents: { profiles: { list: () => [profile], binding: id => binding[id], bind: async id => binding[id] = { profile } }, hasRuntime: () => true, recordBinding() {}, adapter: { listModels: async () => [{ id: 'real-model', isDefault: true }] } },
    workspaceRegistry: { list: () => [{ id: 'workspace', path: '/example/project', title: '项目' }] },
    sessionController: { create: async request => { agent.id = request.sessionId; return { sessionId: request.sessionId } }, resolveAgent: async () => ({ agent }), selectModel: async () => {}, rename: async () => {} },
    permissionPresets: { set: (_session, mode) => permissions.push(mode) },
  }
  installSessionCreator({ get: name => services[name], provide: (_name,value) => creator=value, effect() {} },client,'host.example')
  return { create: (...args) => creator.create(...args), starts: () => starts, permissions }
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
