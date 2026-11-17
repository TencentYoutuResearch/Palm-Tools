import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { demoTeamCommands, prepareTeamDemo, seedTeamDemo, guardTeamDemoClient, seedTeamDemoScope } from '../src/team-demo-fixture.js'
import { registerCollabTeams } from '../src/collab-api.js'
import { registerTeamConfiguration } from '../src/team-configuration-route.js'
const prefix = '/api/v1/messaging/'
const scope = { home_hub: 'demo-home', host_id: 'demo-home', workspace_id: 'demo-workspace', root_ref: '/fixture/demo' }
const ids = ['demo-product', 'demo-quality', 'demo-delivery']

test('draft schema has explicit demo labels and no execution authority', () => {
  const commands = demoTeamCommands(scope)
  assert.deepEqual(commands.map(c => c.id), ids)
  for (const {spec} of commands) {
    assert.match(spec.name, /^【演示】/)
    for (const key of ['execution_targets','coordinator_targets','workflow_pack_refs']) assert.deepEqual(spec[key], [])
    for (const key of ['grant_id','budget_policy_id','scheduling_policy_id']) assert.equal(spec[key], null)
    assert.equal(spec.proactive_mode, 'off')
    assert.equal(spec.workers.length, 2)
  }
})

test('allowlist refuses execution, authority, external resources and unscoped writes before forwarding', async () => {
  const calls = [], backend = guardTeamDemoClient({ call: async (...args) => { calls.push(args); return {} } }, {scope, teamIds: ids, surfaceIds: ['demo-private']})
  for (const path of ['teams/demo-product/activation','work-runs','team-grants','budgets','resource-accounts','workbench/agent-hub','collaboration/tasks','conversations/anything/messages','external-resources','node']) {
    await assert.rejects(backend.call(prefix + path, {}), { code: 'DEMO_OPERATION_BLOCKED' })
  }
  for (const mutate of [s => s.execution_targets.push({id:'real'}),s => s.grant_id='grant',s=>s.proactive_mode='auto',s=>s.workspace_refs[0].root_ref='/real']) {
    const command=demoTeamCommands(scope)[0];mutate(command.spec)
    await assert.rejects(backend.call(prefix+'teams',command), {code:'DEMO_OPERATION_BLOCKED'})
  }
  await assert.rejects(backend.call(prefix+'collaboration/surfaces/demo-private/messages',{mentions:['worker']}), {code:'DEMO_OPERATION_BLOCKED'})
  await assert.rejects(backend.call(prefix+'teams/real-team'), {code:'DEMO_OPERATION_BLOCKED'})
  assert.equal(calls.length,0)
  await backend.call(prefix+'teams',demoTeamCommands(scope)[0])
  await backend.call(prefix+'collaboration/surfaces/demo-private/messages',{mentions:[],content:'本地演示'})
  assert.equal(calls.length,2)
})

test('preparation allocates new isolated config; seeding is one-shot, no runtime, no fake agent output', async () => {
  const handle = await prepareTeamDemo(), calls=[], workspaces=[]
  try {
    const config=JSON.parse(await readFile(handle.configPath,'utf8'))
    assert.equal(config.node_id,handle.node);assert.ok(config.database.startsWith(handle.root+'/'));assert.deepEqual(config.peers,[])
    const client={url:'http://127.0.0.1:12345',call:async(path,body)=>{
      calls.push({path,body})
      if(path===prefix+'node')return {node_id:handle.node}
      if(path===prefix+'teams?limit=1')return {items:[]}
      if(path===prefix+'workbench/workspaces') {if(body)workspaces.push({id:'workspace',path:body.path});return {workspaces}}
      if(path===prefix+'teams')return {...body,revision:1,status:'draft',eligible_for_execution:false}
      return {revision:1}
    }}
    const seeded=await seedTeamDemo(handle,client)
    assert.equal(seeded.teams.length,3);assert.equal(seeded.surfaceIds.length,3)
    assert.ok(calls.filter(c=>c.body).every(c=>c.path===prefix+'teams'||c.path===prefix+'workbench/workspaces'||c.path.startsWith(prefix+'collaboration/surfaces/')))
    for(const c of calls.filter(c=>c.path.endsWith('/messages')))assert.match(c.body.content,/非模型输出/)
    await assert.rejects(seedTeamDemo(handle,client),/Fresh disposable/)
  } finally { await rm(handle.root,{recursive:true,force:true}) }
})

test('identity mismatch and malformed directory fail without writes', async () => {
  for(const mismatch of [true,false]) {
    const handle=await prepareTeamDemo(),writes=[]
    try {
      await assert.rejects(seedTeamDemo(handle,{url:'http://127.0.0.1:12345',call:async(path,body)=>{
        if(body)writes.push(body)
        return path===prefix+'node'?{node_id:mismatch?'daily-home':handle.node}:{}
      }}),mismatch?/identity mismatch/:/must be empty/)
      assert.equal(writes.length,0)
    }finally{await rm(handle.root,{recursive:true,force:true})}
  }
})

test('existing authenticated Team routes can browse and edit through guarded client',async()=>{
  const rows=demoTeamCommands(scope).map(c=>({...c,revision:1,status:'draft'})),routes=new Map()
  const backendClient=guardTeamDemoClient({call:async(path,body)=>body?{...body,revision:2}:path.includes('?')?{items:rows}:rows[0]}, {scope,teamIds:ids,surfaceIds:[]})
  const ctx={webServer:{register:r=>routes.set(r.path,r)},connection:{admit:()=>({peer:{principal:{kind:'owner'}}})}}
  registerCollabTeams(ctx,{backendClient});registerTeamConfiguration(ctx,{backendClient})
  async function request(path,body){
    const req=Readable.from(body?[JSON.stringify(body)]:[]);Object.assign(req,{url:path,method:body?'POST':'GET',headers:{'content-type':'application/json'}})
    let status,result;await routes.get(path.split('?')[0]).handler(req,{writeHead:s=>status=s,end:v=>result=JSON.parse(v)})
    return {status,result}
  }
  const listed=await request('/api/kode/collab/teams');assert.equal(listed.status,200);assert.equal(listed.result.items.length,3)
  const edit={...demoTeamCommands(scope)[0],expected_revision:1};edit.spec.coordinator_prompt='【演示】更新后的配置'
  const saved=await request('/api/kode/teams/configuration',edit);assert.equal(saved.status,200);assert.equal(saved.result.revision,2)
})

function sameHubFixture({lostWrites=false}={}) {
  const data={workspaces:[{id:'real',path:'/real/project',title:'Real project'}],teams:new Map(),surfaces:new Map(),messages:new Map()},writes=[]
  const client={url:'http://127.0.0.1:48984',call:async(path,body)=>{
    const route=path.slice(prefix.length).split('?')[0]
    if(body)writes.push({route,body:structuredClone(body)})
    let result
    if(route==='node')return {node_id:'fixture-home'}
    if(route==='workbench/workspaces') {
      if(body)data.workspaces.push({id:'demo-workspace',path:body.path,title:body.title})
      result={workspaces:structuredClone(data.workspaces)}
    }else if(route==='teams') {
      result={...structuredClone(body),home_hub:'fixture-home',revision:1,status:'draft',active_revision:null,eligible_for_execution:false,superagent_id:'super-'+body.id,conversation_id:'conversation-'+body.id}
      data.teams.set(body.id,result)
    }else if(route.startsWith('teams/')) {
      const id=route.split('/')[1]
      if(!data.teams.has(id))throw Object.assign(Error('missing'),{status:404})
      if(route.endsWith('/activation'))throw Object.assign(Error('no activation record'),{status:404})
      return structuredClone(data.teams.get(id))
    }else if(route==='collaboration/surfaces')return {items:[...data.surfaces.values()]}
    else if(route.startsWith('collaboration/surfaces/')) {
      const id=route.split('/')[2]
      if(route.endsWith('/messages')) {
        if(!body)return {items:data.messages.get(id)??[],has_more:false,next_cursor:null}
        result={id:'message-'+id,actor:{kind:'human',id:'local_owner'},content:body.content}
        data.messages.set(id,[...(data.messages.get(id)??[]),result])
      }else {
        result={...structuredClone(body),id,revision:1};data.surfaces.set(id,result)
      }
    }else throw Error('Unexpected fixture route '+route)
    if(body&&lostWrites)throw Error('fixture committed response lost')
    return result
  }}
  return {data,writes,client}
}
const scopeOptions={expectedNodeId:'fixture-home',workspacePath:'/fixture/dedicated-team-demo',seedKey:'walkthrough-v1'}

test('same-Hub seed is additive and idempotent, preserves edited roles and real workspace',async()=>{
  const f=sameHubFixture(), first=await seedTeamDemoScope(f.client,scopeOptions)
  assert.equal(first.teams.length,3);assert.ok(first.teams.every(t=>t.superagent_id&&t.conversation_id))
  const writes=f.writes.length
  f.data.teams.get(first.teams[0].id).spec.coordinator_prompt='【演示】保留用户编辑'
  const second=await seedTeamDemoScope(f.client,scopeOptions)
  assert.equal(f.writes.length,writes);assert.equal(second.teams[0].spec.coordinator_prompt,'【演示】保留用户编辑')
  assert.deepEqual(f.data.workspaces[0],{id:'real',path:'/real/project',title:'Real project'})
  assert.ok(f.writes.every(({route,body})=>route==='workbench/workspaces'||route==='teams'||route.startsWith('collaboration/surfaces/'+first.namespace)))
  assert.equal(second.nativeConversationSamples,false)
})

test('lost responses recover by reads without duplicate writes or new request IDs',async()=>{
  const f=sameHubFixture({lostWrites:true}),first=await seedTeamDemoScope(f.client,scopeOptions)
  assert.equal(first.teams.length,3);assert.equal(f.writes.length,10)
  await seedTeamDemoScope(f.client,scopeOptions)
  assert.equal(f.writes.length,10);assert.ok([...f.data.messages.values()].every(rows=>rows.length===1))
})

test('same-Hub seed refuses an occupied real workspace path and wrong node without writes',async()=>{
  for(const options of [{...scopeOptions,workspacePath:'/real/project'},{...scopeOptions,expectedNodeId:'other'}]) {
    const f=sameHubFixture();await assert.rejects(seedTeamDemoScope(f.client,options));assert.equal(f.writes.length,0)
  }
})

test('same-Hub seed does not overwrite a demo that acquired execution configuration',async()=>{
  const f=sameHubFixture(),first=await seedTeamDemoScope(f.client,scopeOptions),count=f.writes.length
  f.data.teams.get(first.teams[0].id).spec.grant_id='real-grant'
  await assert.rejects(seedTeamDemoScope(f.client,scopeOptions),/changed or became executable/)
  assert.equal(f.writes.length,count)
})
