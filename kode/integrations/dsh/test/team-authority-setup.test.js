import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isolatedHub } from './support/isolated-hub.js'
import { registerTeamAuthority } from '../src/team-authority-route.js'

test('owner policy and grant bundle is atomic, scope-bound and recoverable without renewing revoked authority',{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('team-authority'),routes=new Map();let server,lost=false
 try{
  const root='/api/v1/messaging',teamPath=`${root}/teams/team`,at=Date.now()
  const workspace={host_id:'host',workspace_id:'workspace',root_ref:'/srv/fixture'}
  const target={id:'target',host_id:'host',executor_profile_id:'profile',executor_profile_revision:'f'.repeat(64),provider_id:'fixture',model_id:'model',effort:null,account_binding_id:'account',capability_profile_revision:'1'}
  const spec={name:'Team',purpose:'Deliver work',kind:'coordinator',workspace_refs:[workspace],execution_targets:[target],workers:[],coordinator_targets:['target'],workflow_pack_refs:[],grant_id:'grant',budget_policy_id:'budget-policy',scheduling_policy_id:'schedule-policy',limits:{max_active_assignments:2,max_active_runs:2},proactive_mode:'off'}
  await hub.client.call(`${root}/teams`,{id:'team',request_id:'new',expected_revision:0,spec})
  await hub.client.call(`${teamPath}/budgets`,{request_id:'allowance',team_revision:1,budget:{id:'budget',scope:'team',scope_id:'team',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+60000,expected_revision:0}})
  const command={request_id:'configure',team_revision:1,
   budget_policy:{id:'budget-policy',team_id:'team',expected_revision:0,policy:{kind:'budget',budget_ids:['budget'],unit:'credits',max_assignment_charge:10}},
   scheduling_policy:{id:'schedule-policy',team_id:'team',expected_revision:0,policy:{kind:'scheduling',targets:{target:{resource:{host:'host',profile:'profile',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'},capability_id:'capability',capability_revision:1,preferred:false}},weights:{quality:100,cost:50,latency:20},minimum_quality:60,minimum_confidence:0.7}},
   grant:{expected_revision:0,policy:{id:'grant',team_id:'team',enabled:true,expires_at:at+60000,targets:[{host:'host',workspace:'workspace',root:'/srv/fixture'}],capabilities:['read','delegate'],tools:['kode_capture_output'],network:false,budget_ids:['budget']}}}
  const registration=await hub.client.call(`${root}/sessions`,{session_id:'worker',title:'Worker',runtime:'external'})
  const worker=hub.client.forSession(registration.owner_token)
  await assert.rejects(worker.call(`${teamPath}/authority`,command),/403/)
  await assert.rejects(hub.client.call(`${teamPath}/authority`,{...command,team_revision:2}),/team changed/)
  const outside=structuredClone(command);outside.grant.policy.targets[0].root='/srv/outside'
  await assert.rejects(hub.client.call(`${teamPath}/authority`,outside),/outside team draft/)
  const foreign=structuredClone(command);foreign.scheduling_policy.policy.targets.target.resource.account_id='other'
  await assert.rejects(hub.client.call(`${teamPath}/authority`,foreign),/targets differ/)
  const expired=structuredClone(command);expired.grant.policy.expires_at=at-1000
  await assert.rejects(hub.client.call(`${teamPath}/authority`,expired),/already expired/)
  for(const id of ['budget-policy','schedule-policy'])await assert.rejects(hub.client.call(`${root}/team-policies/${id}`),/404/)
  assert.deepEqual(await hub.client.call(`${teamPath}/authority-requests/configure`),{receipt:null},'failure in final grant write rolls back both policies and receipt')
  registerTeamAuthority({webServer:{register:r=>{routes.set(r.path,r);return()=>{}}},connection:{admit:req=>({peer:{principal:{kind:req.headers['x-fixture-owner']==='yes'?'owner':'agent'}}})}},{backendClient:{async call(path,body){
   const value=await hub.client.call(path,body)
   if(path===`${teamPath}/authority`&&body&&!lost){lost=true;throw Error('lost committed authority response')}
   return value
  }}})
  server=createServer((req,res)=>routes.get(new URL(req.url,'http://fixture.invalid').pathname).handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening')
  const url=`http://127.0.0.1:${server.address().port}/api/kode/teams/authority`
  const post=async(body=command,owner=true)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-fixture-owner':owner?'yes':'no'},body:JSON.stringify({team_id:'team',command:body})});return {status:r.status,body:await r.json()}}
  assert.equal((await post(command,false)).status,403)
  const unknownScope=structuredClone(command);unknownScope.grant.policy.team_id='other';assert.equal((await post(unknownScope)).status,400)
  const lostReply=await post();assert.equal(lostReply.status,409);assert.equal(lostReply.body.retry,'same_request')
  await hub.stop('SIGKILL');await hub.start()
  const [first,second]=await Promise.all([post(),post()]);assert.equal(first.status,200);assert.deepEqual(second,first)
  const stale={...command,request_id:'stale-new-confirmation'}
  assert.equal((await post(stale)).status,409)
  assert.deepEqual(await hub.client.call(`${teamPath}/authority-requests/stale-new-confirmation`),{receipt:null})
  const result=first.body;assert.equal(result.activation_performed,false);assert.equal(result.grant.revision,1)
  assert.equal(result.budget_policy.revision,1);assert.equal(result.scheduling_policy.revision,1)
  assert.equal((await hub.client.call(`${root}/budgets/budget`)).budget.reserved,0)
  await assert.rejects(hub.client.call(`${teamPath}/activation`),/404/)
  const read=await fetch(`${url}?team_id=team&request_id=configure`,{headers:{'x-fixture-owner':'yes'}})
  assert.deepEqual(await read.json(),{receipt:{request:command,result}})
  await assert.rejects(worker.call(`${teamPath}/authority-requests/configure`),/403/)
  assert.deepEqual(await hub.client.call(`${root}/teams/other/authority-requests/configure`),{receipt:null})
  const changed=structuredClone(command);changed.grant.policy.network=true;assert.equal((await post(changed)).status,409)
  const revoked=await hub.client.call(`${root}/team-grants`,{expected_revision:1,policy:{...command.grant.policy,enabled:false}})
  assert.deepEqual((await post()).body,result,'historical setup cannot renew a revoked grant')
  assert.deepEqual(await hub.client.call(`${root}/team-grants/grant`),revoked.grant)
  const audit=await hub.client.call(`${teamPath}/events`)
  assert.equal(audit.events.filter(e=>e.data.kind==='team_authority_configured').length,1)
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await hub.close()}
})
