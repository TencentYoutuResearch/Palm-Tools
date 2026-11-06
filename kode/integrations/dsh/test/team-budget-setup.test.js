import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { isolatedHub } from './support/isolated-hub.js'
import { registerTeamBudget } from '../src/team-budget-route.js'
const spec={name:'Budget team',purpose:'Configured work',kind:'coordinator',workspace_refs:[],execution_targets:[],workers:[],coordinator_targets:[],workflow_pack_refs:[],grant_id:null,budget_policy_id:null,scheduling_policy_id:null,limits:{max_active_assignments:2,max_active_runs:2},proactive_mode:'off'}
test('owner team budget confirmation survives lost reply and restart without repeating allowance changes', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
 const hub=await isolatedHub('team-budget-setup'),routes=new Map();let server,lost=false
 try{
  const root='/api/v1/messaging',teamPath=`${root}/teams/team`
  await hub.client.call(`${root}/teams`,{id:'team',request_id:'new',expected_revision:0,spec})
  const registration=await hub.client.call(`${root}/sessions`,{session_id:'worker',title:'Worker',runtime:'external'})
  const worker=hub.client.forSession(registration.owner_token)
  registerTeamBudget({webServer:{register:r=>{routes.set(r.path,r);return()=>{}}},connection:{admit:req=>({peer:{principal:{kind:req.headers['x-fixture-owner']==='yes'?'owner':'agent'}}})}}, {backendClient:{async call(path,body){
   const value=await hub.client.call(path,body)
   if(body&&path===`${teamPath}/budgets`&&!lost){lost=true;throw Error('lost committed allowance reply')}
   return value
  }}})
  server=createServer((req,res)=>routes.get(new URL(req.url,'http://fixture.invalid').pathname).handler(req,res))
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const url=`http://127.0.0.1:${server.address().port}/api/kode/teams/budget`
  const post=async(command,owner=true)=>{
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-fixture-owner':owner?'yes':'no'},body:JSON.stringify({team_id:'team',command})})
   return {status:response.status,body:await response.json()}
  }
  const at=Date.now(),command={request_id:'allowance',team_revision:1,budget:{id:'budget',scope:'team',scope_id:'team',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+60000,expected_revision:0}}
  assert.equal((await post(command,false)).status,403)
  await assert.rejects(worker.call(`${teamPath}/budgets`,command),/403/)
  assert.equal((await post({...command,budget:{...command.budget,scope_id:'other'}})).status,400)
  await assert.rejects(hub.client.call(`${teamPath}/budgets`,{...command,team_revision:2}),/team changed/)
  assert.deepEqual(await hub.client.call(`${teamPath}/budget-requests/allowance`),{receipt:null})
  const ambiguous=await post(command);assert.equal(ambiguous.status,409);assert.equal(ambiguous.body.retry,'same_request')
  await hub.stop('SIGKILL');await hub.start()
  const retry=await post(command);assert.equal(retry.status,200)
  assert.equal(retry.body.label,'团队预算');assert.equal(retry.body.budget.limit,100);assert.equal(retry.body.budget.revision,1)
  assert.equal(retry.body.activation_performed,false)
  assert.equal((await hub.client.call(teamPath)).status,'draft')
  const receiptResponse=await fetch(`${url}?team_id=team&request_id=allowance`,{headers:{'x-fixture-owner':'yes'}})
  assert.equal(receiptResponse.status,200)
  assert.deepEqual(await receiptResponse.json(),{receipt:{request:command,result:retry.body}})
  await assert.rejects(worker.call(`${teamPath}/budget-requests/allowance`),/403/)
  assert.deepEqual(await hub.client.call(`${root}/teams/other/budget-requests/allowance`),{receipt:null})
  assert.equal((await post({...command,budget:{...command.budget,limit:200}})).status,409)
  await hub.client.call(`${root}/budget-reservations`,{id:'hold',budget_ids:['budget'],amount:25,unit:'credits',operation_id:'fixture-operation'})
  const latest=(await hub.client.call(`${root}/budgets/budget`)).budget
  const raise={...command,request_id:'raise',budget:{...command.budget,expected_revision:latest.revision,limit:150}}
  const [raised,duplicate]=await Promise.all([post(raise),post(raise)]);assert.equal(raised.status,200);assert.deepEqual(duplicate,raised);assert.equal(raised.body.budget.reserved,25)
  const reject={...raise,request_id:'discard-held',budget:{...raise.budget,expected_revision:raised.body.budget.revision,limit:10}}
  assert.equal((await post(reject)).status,409)
  assert.deepEqual(await hub.client.call(`${teamPath}/budget-requests/discard-held`),{receipt:null},'failed accounting update cannot leave a successful receipt')
  await hub.client.call(`${root}/teams`,{id:'team',request_id:'edit',expected_revision:1,spec:{...spec,name:'Changed'}})
  assert.deepEqual((await post(command)).body,retry.body,'historical receipt survives changed team and budget')
  const final=await hub.client.call(`${root}/budgets/budget`)
  assert.equal(final.available,125);assert.equal(final.budget.limit,150)
  const events=await hub.client.call(`${root}/budgets/budget/events`)
  assert.equal(events.events.filter(e=>e.data.kind==='budget_configured').length,2)
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}await hub.close()}
})

test('initial team budget and referenced policy commit once without granting authority', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('initial-team-budget')
  try {
    const base = '/api/v1/messaging/', path = base + 'teams/team/budgets'
    await hub.client.call(base + 'teams', { id: 'team', request_id: 'new', expected_revision: 0, spec: { ...spec, budget_policy_id: 'initial-policy' } })
    const at = Date.now(), command = { request_id: 'initial', team_revision: 1, budget: { id: 'initial-budget', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100, starts_at: at - 1000, ends_at: at + 60000, expected_revision: 0 }, initial_policy: { max_assignment_charge: 10 } }
    await assert.rejects(hub.client.call(path, { ...command, initial_policy: { max_assignment_charge: 101 } }), /sufficient budget/)
    await assert.rejects(hub.client.call(base + 'budgets/initial-budget'), /404|Query returned no rows/)
    await assert.rejects(hub.client.call(path, { ...command, budget: { ...command.budget, ends_at: at - 2000 } }), /budget/)
    await assert.rejects(hub.client.call(base + 'team-policies/initial-policy'), /404/)
    const values = await Promise.all([hub.client.call(path, command), hub.client.call(path, command)])
    assert.deepEqual(values[0], values[1]); const saved = values[0]
    assert.equal(saved.budget.revision, 1); assert.equal(saved.budget.spent, 0); assert.equal(saved.budget.reserved, 0)
    assert.equal(saved.budget_policy.revision, 1); assert.equal(saved.budget_policy.id, 'initial-policy')
    assert.deepEqual(saved.budget_policy.policy, { kind: 'budget', budget_ids: ['initial-budget'], unit: 'credits', max_assignment_charge: 10 })
    assert.equal(saved.activation_performed, false)
    await assert.rejects(hub.client.call(path, { ...command, request_id: 'other', budget: { ...command.budget, id: 'another-budget' } }), /already configured/)
    await assert.rejects(hub.client.call(base + 'budgets/another-budget'), /404|Query returned no rows/)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await hub.client.call(path, command), saved)
    await assert.rejects(hub.client.call(base + 'teams/team/activation'), /404/)
  } finally { await hub.close() }
})

test('explicit internal-price settlement is durable and invalid settlement rolls back the allowance', { skip: !process.env.KODE_TEST_BACKEND_URL, timeout: 30000 }, async () => {
  const hub = await isolatedHub('team-budget-settlement')
  try {
    const call = (path, body) => hub.client.call('/api/v1/messaging/' + path, body)
    await call('teams', { id: 'team', request_id: 'create', expected_revision: 0, spec: { ...spec, budget_policy_id: 'settlement-policy' } })
    const at = Date.now(), command = { request_id: 'configure', team_revision: 1, budget: { id: 'allowance', scope: 'team', scope_id: 'team', unit: 'credits', limit: 100, starts_at: at - 1000, ends_at: at + 60000, expected_revision: 0 }, initial_policy: { max_assignment_charge: 10, settlement: 'provider_invoice' } }
    await assert.rejects(call('teams/team/budgets', command), /settlement/)
    await assert.rejects(call('budgets/allowance'), /404|Query returned no rows/)
    assert.deepEqual(await call('teams/team/budget-requests/configure'), { receipt: null })
    command.initial_policy.settlement = 'internal_price'
    const saved = await call('teams/team/budgets', command)
    assert.equal(saved.budget_policy.policy.settlement, 'internal_price'); assert.equal(saved.activation_performed, false)
    await hub.stop('SIGKILL'); await hub.start()
    assert.deepEqual(await call('teams/team/budgets', command), saved)
    await assert.rejects(call('teams/team/budgets', { ...command, initial_policy: { max_assignment_charge: 10 } }), /identity conflict/)
    assert.equal((await call('budgets/allowance')).budget.reserved, 0)
  } finally { await hub.close() }
})
