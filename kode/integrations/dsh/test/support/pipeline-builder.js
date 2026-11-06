/** Preconfigured creation-assistant authority; actual start/input/tool execution use production paths. */
import assert from 'node:assert/strict'
import { OFFICIAL_BUILDER_TOOLS } from '../../src/official-builder-tools.js'
import { deliveryInputId } from '../../src/delivery-tracker.js'
export async function pipelineBuilder({hub,profiles,ownerHttp,host,workspace,at}){
 const call=(p,b)=>hub.client.call(`/api/v1/messaging/${p}`,b)
 await profiles.bind('builder-probe','builder-profile')
 const revision=profiles.binding('builder-probe').revision
 await call('budgets',{id:'creation-budget',scope:'team',scope_id:'builder',unit:'credits',limit:100,starts_at:at-1000,ends_at:at+60000,expected_revision:0})
 await call('price-versions',{id:'creation-price',model:'model',unit:'credits',model_policy:'requested_model',input_per_million:1000000,cached_per_million:1000000,output_per_million:1000000})
 const scope={team_id:'builder',revision:1,target:{host:workspace.host_id,workspace:workspace.workspace_id,root:workspace.root_ref},capabilities:['read','builder_draft_write'],tools:[...OFFICIAL_BUILDER_TOOLS],network:false,budget_ids:['creation-budget']}
 await call('team-grants',{expected_revision:0,policy:{id:'creation-grant',team_id:'builder',enabled:true,expires_at:at+60000,targets:[scope.target],capabilities:scope.capabilities,tools:scope.tools,network:false,budget_ids:scope.budget_ids}})
 await call('resource-accounts',{id:'creation-account',expected_epoch:0,enabled:true})
 await call('resource-bindings',{host:hub.node,profile:'builder-profile',account_id:'creation-account',account_epoch:1,expected_revision:0})
 const start={draft_id:'owner-draft',draft_revision:1,price_id:'creation-price',operation:{owner_session:'owner',request_key:'create-builder',worker:{node_id:hub.node,session_id:'builder'},selection_policy:{profile_revision:revision,model:'model',effort:null,scope:'executor_configuration'},funding:{budget_ids:['creation-budget'],amount:20,unit:'credits'},resource:{host:hub.node,profile:'builder-profile',account_id:'creation-account',account_epoch:1,binding_revision:1,limit_ids:['daily'],unknown_quota:'team_budget'},grant_id:'creation-grant',grant_scope:scope}}
 const creation=await ownerHttp.post('builder/start',{command_id:'create-builder',team_id:'team',provider:'fixture',start})
 const operation=await call(`operations/${creation.request.operation.id}`),owned=host.handles.get('builder')
 assert.ok(owned)
 return {owned,operation,async input(request_id,content){
  const message=await ownerHttp.post('builder/input',{operation_id:operation.id,draft_id:'owner-draft',request_id,attempt:operation.attempt,epoch:operation.epoch,content})
  const until=Date.now()+10000
  while(!owned.agent.session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===deliveryInputId(message.receipt.message_id))){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,10))}
  await owned.agent.whenIdle()
  return call('superagents/drafts/owner-draft')
 }}
}
