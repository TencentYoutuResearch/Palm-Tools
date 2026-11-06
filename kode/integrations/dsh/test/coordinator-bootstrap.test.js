import test from 'node:test'
import assert from 'node:assert/strict'
import { CoordinatorBootstrap, coordinatorBootstrapInput } from '../src/coordinator-bootstrap.js'
function fixture(){
 const active=id=>({active:true,authority_valid:true,revision:1,snapshot:{team:{id,home_hub:'home',conversation_id:`conversation-${id}`,spec:{coordinator_startup:{workspace_id:'workspace',task_tag:'coordination'}}}}})
 const starts=[],controls={},plans={},messages=new Set(['a','b'])
 const host={stop:new AbortController(),handles:new Map(),execution:{host:'home',profiles:{coordinatorStartPlans:plans},client:{async call(path){
  if(path.includes('teams?'))return {home_hub:'home',items:[{id:'a'},{id:'b'}],next_cursor:null}
  const id=path.includes('/teams/')?path.split('/teams/')[1].split('/')[0]:path.split('conversation-')[1].split('/')[0]
  if(path.endsWith('/activation'))return active(id)
  if(path.endsWith('/coordinator-control'))return {control:controls[id]??null}
  if(path.endsWith('/coordinator-recovery'))return {recovery:{blockers:['budget_not_finalized'],resume_authorized:false}}
  return {team_id:id,home_hub:'home',conversation_id:`conversation-${id}`,items:messages.has(id)?[{message_id:'message',sequence:1}]:[]}
 }}},async startPlannedCoordinator(input){starts.push(input);if(input.team_id==='a')throw Error('unavailable resource');return {state:'created'}}}
 return {host,active,starts,controls,plans,messages}
}
test('bootstrap only wakes durable requests, continues after blocked team, and does not imply resumed runtime',async()=>{
 const f=fixture(),pump=new CoordinatorBootstrap(f.host)
 const result=await pump.scan()
 assert.deepEqual(result.map(r=>r.state),['pending','recovery_required'])
 assert.deepEqual(f.starts.map(r=>r.team_id),['a','b'])
 assert.deepEqual(f.starts[1],coordinatorBootstrapInput('home',f.active('b')))
 f.messages.clear();f.starts.length=0
 assert.deepEqual(await pump.scan(),[]);assert.equal(f.starts.length,0)
 await pump.close()
})
test('foreign control is not replaced and historical own plan may recover only its exact intent',async()=>{
 const f=fixture(),pump=new CoordinatorBootstrap(f.host)
 f.controls.a={request:{request_id:'foreign'},worker:{session_id:'foreign'}}
 const input=coordinatorBootstrapInput('home',f.active('b'))
 f.controls.b={request:{request_id:input.request_id},worker:{session_id:input.session_id}}
 f.plans[JSON.stringify(['home','b',input.request_id])]={input}
 const result=await pump.scan()
 assert.deepEqual(f.starts,[input]);assert.deepEqual(result.map(r=>r.state),['recovery_required','recovery_required']);assert.deepEqual(result[0].recovery.blockers,['budget_not_finalized']);assert.equal(result[1].recovery.resume_authorized,false)
 f.host.handles.set(input.session_id,{run:{signal:new AbortController().signal}})
 f.starts.length=0;await pump.scan();assert.equal(f.starts.length,0)
 await pump.close()
})
test('confirmed recovery requires demand and exact prior local ownership, then preserves session and target',async()=>{
 const f=fixture();f.messages.clear()
 const control={revision:1,worker:{node_id:'home',session_id:'old-session'},request:{request_id:'old',operation_id:'old-op',attempt:1,epoch:1,target_id:'target',activation_revision:1,team_revision:1}}
 f.controls.b=control
 let demand=1,localRevision=1
 f.host.execution.profiles.binding=id=>id==='old-session'?{managedCoordinator:{team_id:'b',conversation_id:'conversation-b',control_revision:localRevision},managedOperation:{id:'old-op',attempt:1,epoch:1}}:undefined
 const original=f.host.execution.client.call
 f.host.execution.client.call=async(path,...args)=>{
  if(path.endsWith('/coordinator-recovery'))return {recovery:{replacement_prerequisites_satisfied:true,pending_work_count:demand}}
  const result=await original(path,...args)
  if(path.endsWith('/activation'))result.team_revision=1
  return result
 }
 const pump=new CoordinatorBootstrap(f.host)
 await pump.scan();assert.equal(f.starts.length,1)
 const input=f.starts[0];assert.equal(input.session_id,'old-session');assert.equal(input.target_id,'target');assert.equal(input.expected_control_revision,1);assert.match(input.request_id,/^recover-/)
 f.starts.length=0;demand=0;await pump.scan();assert.equal(f.starts.length,0)
 demand=1;localRevision=2;assert.equal((await pump.scan())[0].state,'recovery_required');assert.equal(f.starts.length,0)
 await pump.close()
})

test('bootstrap ignores unactivated drafts but retains actual activation read failures', async () => {
 const f=fixture(),original=f.host.execution.client.call
 f.host.execution.client.call=async path=>{
  if(path.endsWith('/teams/a/activation'))throw Object.assign(Error('no activation yet'),{status:404})
  if(path.endsWith('/teams/b/activation'))throw Object.assign(Error('unavailable'),{status:503})
  return original(path)
 }
 const pump=new CoordinatorBootstrap(f.host),result=await pump.scan()
 assert.deepEqual(result.map(row=>[row.team_id,row.state,row.error.status]),[['b','pending',503]])
 assert.deepEqual(f.starts,[])
 await pump.close()
})


test('bootstrap wakeup availability follows start, close and host shutdown', async () => {
 const f = fixture(), pump = new CoordinatorBootstrap(f.host)
 assert.equal(pump.running, false)
 pump.start()
 assert.equal(pump.running, true)
 await pump.close()
 assert.equal(pump.running, false)
 const next = new CoordinatorBootstrap(f.host)
 next.start()
 assert.equal(next.running, true)
 f.host.stop.abort()
 assert.equal(next.running, false)
 await next.close()
})
