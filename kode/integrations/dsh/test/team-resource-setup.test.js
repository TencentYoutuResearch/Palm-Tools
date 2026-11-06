import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isolatedHub } from './support/isolated-hub.js'
import { registerTeamResource } from '../src/team-resource-route.js'

test('team resource setup atomically groups declared accounts and assessments without provider access',{skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('team-resource'),routes=new Map();let server,lost=false
 try{
  const root='/api/v1/messaging',teamPath=`${root}/teams/team`,at=Date.now()
  const target=id=>({id,host_id:'host',executor_profile_id:`profile-${id}`,executor_profile_revision:'f'.repeat(64),provider_id:'fixture',model_id:'model',effort:null,account_binding_id:'shared-account',capability_profile_revision:'1'})
  const spec={name:'Team',purpose:'Deliver work',kind:'coordinator',workspace_refs:[],execution_targets:[target('one'),target('two')],workers:[],coordinator_targets:['one'],workflow_pack_refs:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:2,max_active_runs:2},proactive_mode:'off'}
  await hub.client.call(`${root}/teams`,{id:'team',request_id:'new',expected_revision:0,spec})
  const command={request_id:'resource-one',team_revision:1,target_id:'one',create_account:true,
   binding:{host:'host',profile:'profile-one',account_id:'shared-account',account_epoch:1,expected_revision:0},
   capability_profile:{id:'fit-one',expected_revision:0,host:'host',profile:'profile-one',model:'model',assessments:{coding:{evaluation:{kind:'task_fit',tag:'implementation',score:80},source:'user',confidence:0.7,evidence:['Owner-configured preference'],updated_at:at,valid_until:at+60000,pinned:true}},replace_pins:false}}
  command.internal_price={id:'price',model:'model',model_policy:'requested_model',unit:'credits',input_per_million:100,cached_per_million:20,output_per_million:200}
  const registration=await hub.client.call(`${root}/sessions`,{session_id:'worker',title:'Worker',runtime:'external'})
  const worker=hub.client.forSession(registration.owner_token)
  await assert.rejects(worker.call(`${teamPath}/resources`,command),/403/)
  await assert.rejects(hub.client.call(`${teamPath}/resources`,{...command,team_revision:2}),/team changed/)
  const wrong=structuredClone(command);wrong.binding.account_id='foreign'
  await assert.rejects(hub.client.call(`${teamPath}/resources`,wrong),/differs from team target/)
  const wrongPrice=structuredClone(command);wrongPrice.internal_price.model='foreign-model'
  await assert.rejects(hub.client.call(`${teamPath}/resources`,wrongPrice),/configured requested model/)
  const invalidPrice=structuredClone(command);invalidPrice.internal_price.output_per_million=5000000000000000
  await assert.rejects(hub.client.call(`${teamPath}/resources`,invalidPrice),/invalid internal price/)
  await assert.rejects(hub.client.call(`${root}/capability-profiles/fit-one/1`),/404/)
  await assert.rejects(hub.client.call(`${root}/price-versions/price`),/404/)
  const invalid=structuredClone(command);invalid.capability_profile.assessments.coding.confidence=2
  await assert.rejects(hub.client.call(`${teamPath}/resources`,invalid),/invalid capability assessment/)
  await assert.rejects(hub.client.call(`${root}/resource-accounts/shared-account`),/404/)
  assert.equal((await hub.client.call(`${root}/resource-binding?host=host&profile=profile-one`)).binding_current,false)
  assert.deepEqual(await hub.client.call(`${teamPath}/resource-requests/resource-one`),{receipt:null})
  registerTeamResource({webServer:{register:r=>{routes.set(r.path,r);return()=>{}}},connection:{admit:req=>({peer:{principal:{kind:req.headers['x-fixture-owner']==='yes'?'owner':'agent'}}})}},{backendClient:{async call(path,body){
   const value=await hub.client.call(path,body)
   if(path===`${teamPath}/resources`&&body&&!lost){lost=true;throw Error('lost committed resource response')}
   return value
  }}})
  server=createServer((req,res)=>routes.get(new URL(req.url,'http://fixture.invalid').pathname).handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening')
  const url=`http://127.0.0.1:${server.address().port}/api/kode/teams/resource`
  const post=async(body=command,owner=true)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-fixture-owner':owner?'yes':'no'},body:JSON.stringify({team_id:'team',command:body})});return {status:r.status,body:await r.json()}}
  assert.equal((await post(command,false)).status,403)
  const lostReply=await post();assert.equal(lostReply.status,409);assert.equal(lostReply.body.retry,'same_request')
  await hub.stop('SIGKILL');await hub.start()
  const [first,duplicate]=await Promise.all([post(),post()]);assert.equal(first.status,200);assert.deepEqual(duplicate,first)
  const result=first.body;assert.equal(result.binding.revision,1);assert.equal(result.account_created,true)
  assert.equal(result.capability_profile.assessments.coding.source,'user');assert.equal(result.quota_status,'not_checked')
  assert.deepEqual(result.internal_price,{label:'内部计价',basis:'internal_price',provider_invoice:false,price:command.internal_price})
  assert.deepEqual(await hub.client.call(`${root}/price-versions/price`),command.internal_price)
  assert.equal(result.activation_performed,false);assert.equal(result.eligible_for_execution,false)
  const read=await fetch(`${url}?team_id=team&request_id=resource-one`,{headers:{'x-fixture-owner':'yes'}})
  assert.deepEqual(await read.json(),{receipt:{request:command,result}})
  await assert.rejects(worker.call(`${teamPath}/resource-requests/resource-one`),/403/)
  const second=structuredClone(command);second.request_id='resource-two';second.target_id='two';second.create_account=false;second.binding.profile='profile-two';second.capability_profile.profile='profile-two';second.capability_profile.id='fit-two';delete second.internal_price
  const secondResult=await post(second);assert.equal(secondResult.status,200)
  assert.equal(secondResult.body.internal_price,undefined,'omitted price remains compatible with original resource confirmation')
  assert.equal(secondResult.body.account_created,false);assert.equal(secondResult.body.binding.account_epoch,1)
  assert.equal((await hub.client.call(`${root}/resource-binding?host=host&profile=profile-one`)).binding_current,true,'sharing another profile does not rotate the existing account')
  const conflict=structuredClone(command);conflict.capability_profile.assessments.coding.confidence=0.8
  assert.equal((await post(conflict)).status,409)
  await hub.client.call(`${root}/resource-accounts`,{id:'shared-account',expected_epoch:1,enabled:false})
  assert.deepEqual((await post()).body,result,'historical setup cannot reenable an account')
  const account=await hub.client.call(`${root}/resource-accounts/shared-account`);assert.equal(account.epoch,2);assert.equal(account.enabled,false)
  assert.equal((await hub.client.call(`${root}/resource-binding?host=host&profile=profile-two`)).binding_current,false)
  const audit=await hub.client.call(`${teamPath}/events`);assert.equal(audit.events.filter(e=>e.data.kind==='team_resource_configured').length,2)
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await hub.close()}
})

test('adding assessment can reuse exact current binding without invalidating shared resources', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const { conversationTeam } = await import('./support/conversation-team.js')
  const hub = await isolatedHub('reuse-resource-binding')
  try {
    await conversationTeam(hub)
    const base = '/api/v1/messaging/', path = base + 'teams/team/resources'
    const command = { request_id: 'assessment', team_revision: 1, target_id: 'control', create_account: false, reuse_binding: true, binding: { host: hub.node, profile: 'profile', account_id: 'account', account_epoch: 1, expected_revision: 1 }, capability_profile: { id: 'owner-assessment', expected_revision: 0, host: hub.node, profile: 'profile', model: 'model', assessments: {}, replace_pins: false } }
    await assert.rejects(hub.client.call(path, { ...command, create_account: true }), /cannot create and reuse/)
    await assert.rejects(hub.client.call(path, { ...command, binding: { ...command.binding, expected_revision: 2 } }), /reused account binding changed/)
    await assert.rejects(hub.client.call(base + 'capability-profiles/owner-assessment/1'), /404/)
    const results = await Promise.all([hub.client.call(path, command), hub.client.call(path, command)])
    assert.deepEqual(results[0], results[1]); const saved = results[0]
    assert.equal(saved.binding_reused, true); assert.equal(saved.binding.revision, 1); assert.equal(saved.capability_profile.revision, 1)
    await hub.client.call(base + 'resource-accounts', { id: 'account', expected_epoch: 1, enabled: false })
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'new', capability_profile: { ...command.capability_profile, id: 'another' } }), /reused account binding changed/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path, command), saved)
    const binding = await hub.client.call(base + 'resource-binding?host=' + hub.node + '&profile=profile')
    assert.equal(binding.revision, 1); assert.equal(binding.binding_current, false)
  } finally { await hub.close() }
})
