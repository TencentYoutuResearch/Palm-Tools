import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { registerBuilderAnswers } from '../src/builder-answers.js'
test('owner answers commit once, invalidate stale proposals and recover after Hub restart', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('builder-owner-answers')
 try{
  const path='/api/v1/messaging/superagents/drafts'
  const spec={name:'Candidate',purpose:'Work',kind:'coordinator',workspace_refs:[],execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:1,max_active_runs:1},proactive_mode:'off'}
  const interview={purpose:'Interview',workspace_refs:[],answers:{kind:'bug',proof:'fixture'},questions:[{id:'delivery',prompt:'Where to end?'}],proposed_team:spec,questionnaire:{id:'custom',version:'1',questions:[{id:'kind',prompt:'Which work?'},{id:'proof',prompt:'Reproduction?',when_answer:{question_id:'kind',equals:'bug'}},{id:'delivery',prompt:'Where to end?'},{id:'budget',prompt:'Team budget?'}]}}
  await hub.client.call(path,{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview})
  const worker=await hub.client.call('/api/v1/messaging/sessions',{session_id:'worker',title:'Worker',runtime:'external'})
  const command={request_id:'answer-delivery',expected_revision:1,answers:{delivery:'local report'}}
  await assert.rejects(hub.client.forSession(worker.owner_token).call(`${path}/draft/answers`,command),/403/)
  let committed
  await assert.rejects((async()=>{committed=await hub.client.call(`${path}/draft/answers`,command);throw new Error('fixture committed response lost')})(),/response lost/)
  assert.equal(committed.actor.kind,'human');assert.equal(committed.revision,2)
  assert.equal(committed.interview.proposed_team,null)
  assert.deepEqual(committed.interview.questions.map(q=>q.id),['budget'])
  assert.deepEqual(committed.interview.answers,{kind:'bug',proof:'fixture',delivery:'local report'})
  await hub.stop('SIGKILL');await hub.start()
  assert.deepEqual(await hub.client.call(`${path}/draft/answers`,command),committed)
  await assert.rejects(hub.client.call(`${path}/draft/answers`,{...command,answers:{delivery:'deploy'}}),/identity conflict/)
  const race=await Promise.allSettled(['100','200'].map(value=>hub.client.call(`${path}/draft/answers`,{request_id:`budget-${value}`,expected_revision:2,answers:{budget:value}})))
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
  assert.match(race.find(r=>r.status==='rejected').reason.message,/revision conflict/)
  const changed=await hub.client.call(`${path}/draft/answers`,{request_id:'change-kind',expected_revision:3,answers:{kind:'research'},clear_answers:['delivery']})
  assert.equal(changed.revision,4);assert.equal(changed.interview.answers.proof,undefined)
  assert.deepEqual(changed.interview.questions.map(q=>q.id),['delivery'])
  for(const answers of [{proof:'inactive'},{unknown:'invented'}])await assert.rejects(hub.client.call(`${path}/draft/answers`,{request_id:'invalid',expected_revision:4,answers}),/inactive|unknown/)
  await assert.rejects(hub.client.call(`${path}/draft/answers`,{request_id:'spoof',expected_revision:4,answers:{delivery:'local'},actor:{kind:'human'}}),/400|422/)
  assert.deepEqual(await hub.client.call(`${path}/draft`),changed,'failed answers have no partial effect')
  assert.deepEqual(await hub.client.call(`${path}/draft/answers`,command),committed,'old reply is not replaced by current draft')
  await hub.client.call(path,{id:'draft',request_id:'revoke',expected_revision:4,revoked:true,interview:changed.interview})
  await assert.rejects(hub.client.call(`${path}/draft/answers`,{request_id:'after-revoke',expected_revision:5,answers:{delivery:'local'}}),/revoked/)
  assert.deepEqual((await hub.client.call('/api/v1/messaging/teams')).items,[])
 }finally{await hub.close()}
})
test('owner answer bridge refuses agents and unexpected authority fields before forwarding',async()=>{
 let route,kind='agent',status,calls=0
 registerBuilderAnswers({webServer:{register:r=>{route=r}},connection:{admit:()=>({peer:{principal:{kind}}})}},{backendClient:{call:async()=>{calls++;return {}}}})
 const res={writeHead:s=>{status=s},end:()=>{}}
 const request=body=>({method:'POST',headers:{'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body)}})
 await route.handler(request({}),res);assert.equal(status,403);assert.equal(calls,0)
 kind='owner'
 await route.handler(request({draft_id:'draft',request_id:'x',expected_revision:1,answers:{q:'yes'},builder_operation:{id:'spoof'}}),res)
 assert.equal(status,400);assert.equal(calls,0)
 await route.handler(request({draft_id:'draft',request_id:'x',expected_revision:1,answers:{q:'yes'}}),res)
 assert.equal(status,200);assert.equal(calls,1)
})
