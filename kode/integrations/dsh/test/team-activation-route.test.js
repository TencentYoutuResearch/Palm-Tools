import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTeamActivation } from '../src/team-activation-route.js'
test('owner activation forwards reviewed versions exactly and never refreshes or retries ambiguous consent',async()=>{
 const routes=new Map(),calls=[];let kind='agent',status,value,fail=false
 const dispose=registerTeamActivation({webServer:{register:r=>{routes.set(r.path,r);return()=>routes.delete(r.path)}},connection:{admit:()=>({peer:{principal:{kind}}})}},
 {backendClient:{call:async(...args)=>{calls.push(args);if(fail)throw Error('private failure');return {active:true}}}})
 const send=async(path,body)=>routes.get(`/api/kode/teams/${path}`).handler({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}},{writeHead:s=>{status=s},end:b=>{value=JSON.parse(b)}})
 const reference={id:'policy',revision:1,hash:'a'.repeat(64)}
 const command={action:'activate',request_id:'consent',expected_revision:0,team_revision:1,grant_revision:3,budget_policy:reference,scheduling_policy:reference}
 await send('activation',{team_id:'team',command});assert.equal(status,403);assert.equal(calls.length,0)
 kind='owner'
 await send('activation',{team_id:'team',command:{...command,actor:'human'}});assert.equal(status,400);assert.equal(calls.length,0)
 await send('activation-review',{team_id:'team',team_revision:1,request_id:'consent'})
 assert.equal(status,200);assert.deepEqual(calls[0],['/api/v1/messaging/teams/team/activation-review',{team_revision:1,request_id:'consent'}])
 fail=true
 await send('activation',{team_id:'team',command})
 assert.equal(status,409);assert.equal(value.retry,'same_request');assert.doesNotMatch(JSON.stringify(value),/private failure/)
 assert.equal(calls.length,2);assert.deepEqual(calls[1],['/api/v1/messaging/teams/team/activation-receipts/consent'])
 dispose();assert.equal(routes.size,0)
})


test('activation checks trusted adapters and preserves exact lost-response receipts without refreshing consent',async()=>{
 const routes=new Map(),calls=[]
 let runtime,status,value,receipt=null,lose=false,changed=false
 const reference={id:'policy',revision:1,hash:'a'.repeat(64)}
 const command={action:'activate',request_id:'consent',expected_revision:0,team_revision:1,grant_revision:3,budget_policy:reference,scheduling_policy:reference}
 const stage={id:'inspect',produces:[],execution:{tools:['kode_read_source']}}
 const review={prepared_command:command,configuration:{bindings:[{id:'local',workflow:{pack:{stages:[stage]}}}]}}
 const dispose=registerTeamActivation({get:()=>({officialExecution:runtime}),webServer:{register:r=>{routes.set(r.path,r);return()=>{}}},connection:{admit:()=>({peer:{principal:{kind:'owner'}}})}}, {backendClient:{async call(path,body){
  calls.push({path,body})
  if(path.includes('/activation-receipts/'))return {receipt}
  if(path.endsWith('/activation-review'))return changed?{...review,prepared_command:{...command,grant_revision:4}}:review
  assert.deepEqual(body,command)
  receipt={request:structuredClone(body),result:{active:true,revision:1}}
  if(lose)throw Error('lost committed response')
  return receipt.result
 }}})
 const send=async(cmd=command)=>routes.get('/api/kode/teams/activation').handler({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({team_id:'team',command:cmd})}},{writeHead:s=>{status=s},end:b=>{value=JSON.parse(b)}})
 try{
  await send();assert.equal(status,409);assert.equal(value.runtime_readiness.status,'runtime_unavailable')
  assert.equal(calls.some(c=>c.path.endsWith('/activation')),false)
  runtime={host:'home'};stage.execution.tools=['unregistered']
  await send();assert.equal(status,409);assert.deepEqual(value.runtime_readiness.stages[0].issues,['default_stage_tool_unavailable'])
  stage.execution.tools=['kode_read_source'];changed=true
  await send();assert.equal(status,409);assert.equal(receipt,null)
  changed=false;lose=true
  await send();assert.equal(status,409);assert.equal(value.retry,'same_request')
  runtime=undefined;changed=true
  await send();assert.equal(status,200);assert.deepEqual(value,receipt.result)
  await send({...command,grant_revision:4});assert.equal(status,409);assert.match(value.error,/identity conflict/)
  assert.equal(calls.filter(c=>c.path.endsWith('/activation')).length,1)
 }finally{dispose()}
})


for(const reviewFailure of [false,true])test(`concurrent committed consent is read after review changes (review failure=${reviewFailure})`,async()=>{
 const routes=new Map();let receipt=null,status,value,reads=0,writes=0
 const reference={id:'policy',revision:1,hash:'a'.repeat(64)}
 const command={action:'activate',request_id:'consent',expected_revision:0,team_revision:1,grant_revision:3,budget_policy:reference,scheduling_policy:reference}
 registerTeamActivation({webServer:{register:r=>{routes.set(r.path,r);return()=>{}}},connection:{admit:()=>({peer:{principal:{kind:'owner'}}})}}, {backendClient:{async call(path){
  if(path.includes('/activation-receipts/')){reads++;return {receipt}}
  if(path.endsWith('/activation-review')){
   receipt={request:command,result:{active:true,revision:1}}
   if(reviewFailure)throw Error('configuration changed during review')
   return {prepared_command:{...command,expected_revision:1}}
  }
  writes++;throw Error('must not submit another mutation')
 }}})
 await routes.get('/api/kode/teams/activation').handler({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify({team_id:'team',command})}},{writeHead:s=>{status=s},end:b=>{value=JSON.parse(b)}})
 assert.equal(status,200);assert.deepEqual(value,receipt.result);assert.equal(reads,2);assert.equal(writes,0)
})
