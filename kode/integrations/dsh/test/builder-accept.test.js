import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { registerBuilderAccept } from '../src/builder-accept-route.js'
const spec={name:'Candidate',purpose:'Work',kind:'coordinator',workspace_refs:[],execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'}
test('accepted Builder proposal and team identity commit once with source audit and restart recovery',{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('builder-accept')
 try{
  const call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b),path='superagents/drafts/draft/accept-proposal'
  const interview={purpose:'Configure',workspace_refs:[],answers:{},questions:[],proposed_team:spec}
  const draft=await call('superagents/drafts',{id:'draft',request_id:'new',expected_revision:0,revoked:false,interview})
  const command={request_id:'accepted',expected_revision:1,team_id:'team',team_revision:0}
  const registration=await call('sessions',{session_id:'builder',title:'Builder',runtime:'external'})
  await assert.rejects(hub.client.forSession(registration.owner_token).call(`/api/v1/messaging/${path}`,command),/403/)
  await assert.rejects(call(path,{...command,team_revision:99}),/team revision conflict/)
  assert.deepEqual((await call('teams')).items,[])
  assert.deepEqual(await call('superagents/drafts/draft/acceptances/accepted'),{acceptance:null})
  const [first,second]=await Promise.all([call(path,command),call(path,command)])
  assert.deepEqual(second,first);assert.equal(first.team.revision,1)
  assert.equal(first.team.status,'draft');assert.equal(first.activation_performed,false)
  assert.equal(first.team.eligible_for_execution,false);assert.ok(first.team.superagent_id)
  assert.deepEqual(first.team.spec,spec)
  const review=await call('teams/team/activation-review',{team_revision:1,request_id:'activate'})
  assert.equal(review.prepared_command,null);assert.ok(review.issues.some(i=>i.code==='configuration_incomplete'))
  assert.equal(review.activation_performed,false)
  assert.deepEqual(await call('superagents/drafts/draft'),draft,'acceptance does not rewrite interview answers')
  assert.deepEqual(await call('superagents/drafts/draft/acceptances/accepted'),{acceptance:first})
  await assert.rejects(call(path,{...command,team_id:'other'}),/identity conflict/)
  await assert.rejects(call(path,{...command,request_id:'stale'}),/team revision conflict/)
  assert.deepEqual(await call('superagents/drafts/draft/acceptances/stale'),{acceptance:null})
  await call('superagents/drafts',{id:'draft',request_id:'edit',expected_revision:1,revoked:false,interview:{...interview,proposed_team:{...spec,name:'Changed'}}})
  await assert.rejects(call(path,{...command,request_id:'old-draft',team_revision:1}),/revision conflict/)
  const updated=await call(path,{request_id:'new-proposal',expected_revision:2,team_id:'team',team_revision:1})
  assert.equal(updated.team.revision,2);assert.equal(updated.team.superagent_id,first.team.superagent_id)
  assert.equal(updated.team.conversation_id,first.team.conversation_id)
  await call('superagents/drafts',{id:'draft',request_id:'revoke',expected_revision:2,revoked:true,interview})
  await assert.rejects(call(path,{...command,request_id:'revoked',expected_revision:3,team_revision:2}),/revoked/)
  await hub.stop('SIGKILL');await hub.start()
  assert.deepEqual(await call(path,command),first,'lost response recovery returns historical acceptance, never reapplies it')
  assert.equal((await call('teams/team')).revision,2)
  const events=(await call('teams/team/events')).events.map(e=>e.data)
  assert.deepEqual(events.map(e=>e.kind),['team_draft_saved','builder_proposal_accepted','team_draft_saved','builder_proposal_accepted'])
  assert.equal(events[1].draft_revision,1);assert.equal(events[3].draft_revision,2)
 }finally{await hub.close()}
})
test('owner proposal acceptance bridge is bounded and never forwards model authority or activation',async()=>{
 let route,kind='agent',status,value,fail=false;const calls=[]
 registerBuilderAccept({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind}}})}},
  {backendClient:{call:async(...args)=>{calls.push(args);if(fail)throw Error('private backend');return {activation_performed:false}}}})
 const res={writeHead:s=>{status=s},end:s=>{value=JSON.parse(s)}}
 const req=body=>({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}})
 const command={draft_id:'draft',request_id:'accepted',expected_revision:1,team_id:'team',team_revision:0}
 await route.handler(req(command),res);assert.equal(status,403);assert.equal(calls.length,0)
 kind='owner'
 await route.handler(req({...command,activate:true}),res);assert.equal(status,400);assert.equal(calls.length,0)
 await route.handler(req(command),res);assert.equal(status,200);assert.equal(value.activation_performed,false)
 const {draft_id,...body}=command
 assert.deepEqual(calls[0],['/api/v1/messaging/superagents/drafts/draft/accept-proposal',body])
 fail=true;await route.handler(req(command),res);assert.equal(status,409);assert.equal(value.retry,'same_request');assert.equal(calls.length,2)
 assert.doesNotMatch(JSON.stringify(value),/private backend/)
 fail=false;await route.handler({method:'GET',url:'/?draft_id=draft&request_id=accepted'},res)
 assert.equal(status,200);assert.deepEqual(calls[2],['/api/v1/messaging/superagents/drafts/draft/acceptances/accepted'])
})
