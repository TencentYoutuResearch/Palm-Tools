import {taskCreation,dispatchRequest} from '../../packages/collab/task-execution-model.js'
/** Controlled fixture only: real Hub/Host lifecycle, no provider or business workspace. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const sha=text=>createHash('sha256').update(text).digest('hex')
export async function createCollaborationExecutionFixture(hub,workspace,summary){
 const root='/api/v1/messaging',base=root+'/collaboration',scope={home_hub:hub.node,...workspace}
 await hub.client.call(root+'/workbench/documents/workspaces',{expected_revision:0,value:{version:2,tables:{workspaces:{[workspace.workspace_id]:{path:workspace.root_ref,title:'Isolated fixture',sessionIds:[]}}},global:{initialized:true,workspaceIds:[workspace.workspace_id]}}})
 for(const kind of ['dm','channel'])await hub.client.call(`${base}/surfaces/${kind}`,{request_id:'create',expected_revision:0,scope,kind,title:kind,team_ids:['team'],enabled:true})
 const origin=await hub.client.call(`${base}/surfaces/dm/messages`,{request_id:'private',expected_revision:1,content:'SECRET_DM_NOT_PUBLISHED '+summary,mentions:[]})
 const team=await hub.client.call(root+'/teams/team')
 const dm=await hub.client.call(`${base}/surfaces?`+new URLSearchParams(scope))
 const create=await taskCreation({surface:dm.items.find(x=>x.id==='dm'),message:origin,archive:dm.items.find(x=>x.id==='channel'),team,summary,requestId:'create'})
 const task=await hub.client.call(`${base}/tasks`,create)
 const path=`${base}/tasks/${task.id}`,preview=await hub.client.call(path+'/execution')
 const activation=await hub.client.call(root+'/teams/team/activation')
 const input=dispatchRequest(task,preview,team,activation,'local','dispatch')
 const receipt=await hub.client.call(path+'/execution',input)
 assert.equal(receipt.completion_authorized,false)
 assert.deepEqual(await hub.client.call(path+'/execution',input),receipt)
 let asked=false,renewedOperation
 return{runId:receipt.work_run_id,
  async ownerCancelRequest(){const row=await hub.client.call(path);return{path:path+'/commands',body:{request_id:'cancel-busy',expected_revision:row.revision,source_surface_id:'channel',action:'cancel',content:null,worker_id:null}}},
  async duringActiveInference(assignment,messages){
   if(asked)return;asked=true
   assert.ok(!JSON.stringify(messages).includes('SECRET_DM_NOT_PUBLISHED'))
   const operationPath=`${root}/operations/${assignment.bundle.operation.id}`
   const before=await hub.client.call(operationPath)
   assert.equal(before.state,'active')
   const row=await hub.client.call(path)
   const question=await hub.client.call(path+'/commands',{request_id:'progress-question',expected_revision:row.revision,source_surface_id:'channel',action:'question',content:'How is it going? Please keep the original scope.',worker_id:null})
   assert.equal(question.command.delivery_state,'stored_only')
   assert.equal(question.command.payload.execution_delivery.state,'not_delivered')
   for(const action of ['supplement','pause'])await assert.rejects(hub.client.call(path+'/commands',{request_id:'unsupported-'+action,expected_revision:question.task.revision,source_surface_id:'channel',action,content:action==='supplement'?'Change the approved task scope.':null,worker_id:null}),/not supported/)
   const after=await hub.client.call(path+'/execution')
   assert.equal(after.context_sha256,preview.context_sha256);assert.equal(after.work_run.task_context_current,true)
   // Wait for the real operation lease timer, rather than manufacturing an owner renewal.
   const deadline=Date.now()+20000
   while(true){
    // Observe the committed state before its audit: a timer renewal between
    // an earlier audit read and a later state read is not missing evidence.
    const current=await hub.client.call(operationPath)
    const events=[]
    let cursor=0
    while(true){
     const page=(await hub.client.call(operationPath+'/events?after='+cursor)).events
     if(!page.length)break
     events.push(...page)
     const next=page.at(-1).seq
     assert.ok(next>cursor,'operation audit cursor must advance')
     cursor=next
    }
    const renewal=events.find(event=>event.data?.command?.action?.kind==='renew_resource'&&event.data?.operation?.revision>before.revision&&event.data?.operation?.lease_until>before.lease_until)
    if(current.revision>before.revision&&current.lease_until>before.lease_until){assert.ok(renewal,'renew_resource must be present in the authoritative operation audit');assert.equal(current.state,'active');renewedOperation=assignment.bundle.operation.id;break}
    assert.ok(Date.now()<deadline,'question must allow the active operation lease to renew')
    await new Promise(resolve=>setTimeout(resolve,100))
   }
  },
  async verifyCompleted(run,assignments){
   assert.ok(asked&&renewedOperation,'active question and lease renewal must be exercised')
   assert.equal(run.state,'completed');assert.equal(run.completion_authorized,true)
   assert.ok(assignments.every(row=>row.state==='completed'))
   const operation=await hub.client.call(`${root}/operations/${renewedOperation}`)
   assert.equal(operation.state,'reported','the Worker report must pass after the question')
   const previewAfter=await hub.client.call(path+'/execution')
   assert.equal(previewAfter.work_run.task_context_current,true)
   assert.equal(previewAfter.context_sha256,preview.context_sha256)
   assert.ok(!JSON.stringify(run).includes('SECRET_DM_NOT_PUBLISHED'))
   return{question:'stored_only/not_delivered',lease_renewed:true,worker_report:operation.state,completed_stages:run.stages.filter(s=>s.state==='passed').length,delivery:run.state,external_provider_calls:0,adapter:'controlled_fixture'}
  }
 }
}
