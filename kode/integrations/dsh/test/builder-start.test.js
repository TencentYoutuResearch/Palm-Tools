import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedHub } from './support/isolated-hub.js'
import { OFFICIAL_BUILDER_TOOLS } from '../src/official-builder-tools.js'

test('Builder start atomically funds, prices and binds an operation with durable replay', {skip:!process.env.KODE_TEST_BACKEND_URL,timeout:30000},async()=>{
  const hub=await isolatedHub('builder-start')
  try{
    const call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b),path='superagents/builder-starts',at=Date.now()
    const registration=await call('sessions',{session_id:'builder',title:'Builder',runtime:'external'})
    const worker=hub.client.forSession(registration.owner_token)
    await call('resource-accounts',{id:'account',expected_epoch:0,enabled:true})
    await call('resource-bindings',{host:hub.node,profile:'profile',account_id:'account',account_epoch:1,expected_revision:0})
    await call('budgets',{id:'creation',scope:'team',scope_id:'builder',unit:'credits',limit:30,starts_at:at-1000,ends_at:at+60000,expected_revision:0})
    const target={host:hub.node,workspace:'fixture',root:'/fixture'}
    const scope={team_id:'builder',revision:1,target,capabilities:['read','builder_draft_write'],tools:[...OFFICIAL_BUILDER_TOOLS],network:false,budget_ids:['creation']}
    await call('team-grants',{expected_revision:0,policy:{id:'grant',team_id:'builder',enabled:true,expires_at:at+60000,targets:[target],capabilities:scope.capabilities,tools:scope.tools,network:false,budget_ids:['creation']}})
    await call('price-versions',{id:'price',model:'model',model_policy:'requested_model',unit:'credits',input_per_million:1000000,cached_per_million:1000000,output_per_million:1000000})
    await call('superagents/drafts',{id:'draft',request_id:'create',expected_revision:0,revoked:false,interview:{purpose:'Create a team',workspace_refs:[{host_id:hub.node,workspace_id:'fixture',root_ref:'/fixture'}],answers:{},questions:[],proposed_team:null}})
    const request={draft_id:'draft',draft_revision:1,price_id:'price',operation:{owner_session:'owner',request_key:'start',worker:{node_id:hub.node,session_id:'builder'},selection_policy:{profile_revision:'a'.repeat(64),model:'model',effort:null,scope:'executor_configuration'},funding:{budget_ids:['creation'],amount:10,unit:'credits'},resource:{host:hub.node,profile:'profile',account_id:'account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'},grant_id:'grant',grant_scope:scope}}
    await assert.rejects(worker.call(`/api/v1/messaging/${path}`,request),/403/)
    for(const [mutate,error] of [
      [r=>r.draft_revision=2,/revision conflict/],
      [r=>r.operation.resource.account_epoch=2,/binding_unavailable/],
      [r=>r.operation.funding.amount=31,/insufficient team budget/],
      [r=>r.operation.grant_scope.tools.pop(),/complete Builder tool grant/],
      [r=>r.operation.grant_scope.target.workspace='foreign',/outside selected draft/],
      [r=>r.operation.selection_policy.model='foreign',/matching requested-model/],
    ]){
      const bad=structuredClone(request);mutate(bad)
      await assert.rejects(call(path,bad),error)
      assert.equal((await call('budgets/creation')).budget.reserved,0)
      assert.equal((await call('budgets/creation/reservations')).reservations.length,0)
    }
    // Discard first response to model committed response loss, then retry exact bytes concurrently.
    await call(path,request)
    const [saved,retry]=await Promise.all([call(path,request),call(path,request)])
    assert.deepEqual(saved,retry)
    const op=saved.bundle.operation
    assert.equal(saved.dispatch_state,'not_dispatched')
    assert.equal(op.state,'prepared');assert.equal(op.resource_required,true)
    assert.equal(saved.bundle.resource_decision.requires_team_budget,true,'unknown vendor quota remains explicit')
    assert.equal(saved.scope.request.draft_id,'draft');assert.equal(saved.pricing.price_id,'price')
    assert.equal((await call('budgets/creation')).budget.reserved,10)
    assert.equal((await call('budgets/creation')).budget.spent,0)
    assert.equal((await call('budgets/creation/reservations')).reservations.length,1)
    assert.equal((await call(`operations/${op.id}/budget?attempt=1`)).price.id,'price')
    assert.deepEqual((await call(`operations/${op.id}/builder-scope`)).scope,saved.scope)
    await assert.rejects(call(path,{...request,draft_revision:2}),/identity conflict/)
    await hub.stop('SIGKILL');await hub.start()
    assert.deepEqual(await call(path,request),saved)
    assert.deepEqual((await call('teams')).items,[])
    const claimed=await worker.call(`/api/v1/messaging/operations/${op.id}`,{attempt:1,epoch:1,expected_revision:op.revision,selection_ack:request.operation.selection_policy,action:{kind:'claim_resource',lease_ms:3000,resource:{profile:'profile',account_epoch:1,binding_revision:1}}})
    assert.equal(claimed.operation.state,'active')
    assert.deepEqual(await call(path,request),saved,'replay is historical and does not recreate the operation')
    assert.equal((await call(`operations/${op.id}`)).state,'active')
    const inputPath=`operations/${op.id}/builder-inputs`,input={request_id:'question',draft_id:'draft',attempt:1,epoch:1,content:'Please inspect this project'}
    await assert.rejects(worker.call(`/api/v1/messaging/${inputPath}`,input),/403/)
    await assert.rejects(call(inputPath,{...input,epoch:2}),/active authorized/)
    const record=await call(inputPath,input)
    assert.deepEqual(await call(inputPath,input),record)
    await assert.rejects(call(inputPath,{...input,content:'changed'}),/identity conflict/)
    assert.equal(record.receipt.actor.kind,'human')
    assert.deepEqual((await call(`${inputPath}/question`)).input,record)
    await assert.rejects(worker.call(`/api/v1/messaging/${inputPath}/question`),/403/)
    const closePath=`operations/${op.id}/builder-close`,closeCommand={request_id:'close',attempt:1,epoch:1,price_id:'price',settlement:'internal_price'}
    await assert.rejects(worker.call(`/api/v1/messaging/${closePath}`,closeCommand),/403/)
    await assert.rejects(worker.call(`/api/v1/messaging/${closePath}`),/403/)
    const closeIntent=await call(closePath,closeCommand)
    assert.equal((await call(closePath)).pending_inputs,1,'accepted but unconsumed input prevents close completion')
    assert.deepEqual(await call(inputPath,input),record,'historical input receipt remains readable while closing')
    await assert.rejects(call(inputPath,{...input,request_id:'new-after-close'}),/closing/)
    await assert.rejects(call(closePath,{...closeCommand,request_id:'different'}),/identity conflict/)
    // A reported creation turn with missing usage cannot release its reserved funds.
    await call('official-calls',{call_id:'unknown-creation',operation_id:op.id,attempt:1,epoch:1,worker_session:'builder',provider:'fixture',model:'model'})
    await call('official-calls/unknown-creation/events',{sequence:1,kind:'finished',usage:null,reason:'missing_usage'})
    await call('selection-evidence',{record_id:'creation-selection',operation_id:op.id,worker_session:'builder',attempt:1,epoch:1,profile_revision:request.operation.selection_policy.profile_revision,thread_id:'thread',turn_id:'turn',input_ids:['input'],scope:'executor_configuration',observed_at:Date.now(),rejected:false,model:{requested:'model',observed:'model',status:'reported',source:'fixture'},effort:{requested:null,observed:null,status:'unverifiable',source:null}})
    const before=await call(`operations/${op.id}`)
    const reported=(await call(`operations/${op.id}`,{attempt:1,epoch:1,expected_revision:before.revision,action:{kind:'report',report_id:'returned',content:'Creation turn returned'}})).operation
    assert.equal(reported.state,'reported')
    const settlement={request_id:'creation-final',attempt:1,epoch:1,expected_revision:reported.revision,price_id:'price',settlement:'internal_price'}
    await assert.rejects(worker.call(`/api/v1/messaging/operations/${op.id}/builder-accounting`,settlement),/403/)
    await assert.rejects(call(`operations/${op.id}/builder-accounting`,settlement),/usage remains unresolved/)
    assert.equal((await call('budgets/creation')).budget.reserved,10)
    assert.equal((await call(`operations/${op.id}/budget?attempt=1`)).reservation.finalized,false)
    await hub.stop('SIGKILL');await hub.start()
    await assert.rejects(call(`operations/${op.id}/builder-accounting`,settlement),/usage remains unresolved/)
    assert.equal((await call('budgets/creation')).budget.reserved,10)
    assert.deepEqual(await call(closePath,closeCommand),closeIntent)
    assert.equal((await call(closePath)).pending_inputs,1)

    assert.deepEqual(await call(inputPath,input),record)
    assert.equal((await call(`messages/${record.receipt.message_id}`)).target.session_id,'builder')
    assert.equal((await call('superagents/drafts/draft')).revision,1,'free text is not a confirmed answer or authorization')

  }finally{await hub.close()}
})
