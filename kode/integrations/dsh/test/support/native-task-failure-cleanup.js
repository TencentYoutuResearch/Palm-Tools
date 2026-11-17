/** Cancellation only. Never dispatch/recreate execution to manufacture stop evidence. */
import assert from 'node:assert/strict'
import {AssignmentDispatchHost} from '../../src/assignment-dispatch-host.js'
import {WorkRunController} from '../../src/work-run-controller.js'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
const details=error=>({name:error?.name??'Error',message:String(error?.message??error),code:error?.code??null})
export async function cancelNativeTaskFailure({host,runService,call,team}){
 const result={state:'unconfirmed',runs:[],issues:[]}
 // Stop scheduling before cancellation; the owned execution handles remain available.
 try{await runService.close()}catch(error){result.issues.push({phase:'stop_scheduler',...details(error)})}
 const controller=new WorkRunController(new AssignmentDispatchHost(host),{prepare:async()=>{throw Error('Failure cleanup must not start inference')}})
 try{
  const page=await call(`teams/${team.id}/work-runs?limit=20`)
  assert.ok(!page.has_more&&page.items.length<=1,'Cleanup is limited to this isolated single-task scene')
  for(const item of page.items){
   let run=await call(`work-runs/${item.id}`);assert.equal(run.team_id,team.id)
   const row={run_id:run.id,state:run.state,steps:[]};result.runs.push(row)
   if(!['completed','cancelled','failed'].includes(run.state)&&!['cancelling','cancel_unconfirmed'].includes(run.state)){
    run=await call(`work-runs/${run.id}`,{action:'request_cancel',request_id:'native-failure-cancel-'+run.id,expected_revision:run.revision,reason:'Isolated native acceptance failed; stop owned execution and settle known usage.'})
   }
   // Each advance is the production cancellation path; no synthetic stop receipts.
   for(let step=0;!['completed','cancelled','failed'].includes(run.state)&&step<12;step++){
    const status=await controller.advance(run.id);row.steps.push({state:status.state,reason:status.reason??null})
    run=await call(`work-runs/${run.id}`)
    if(['cancel_unconfirmed','waiting_remote_cancellation','waiting_cancellation_disposition'].includes(status.state)||status.reason==='usage_reconciliation_required')break
   }
   row.state=run.state;row.stop_confirmed=run.cancellation?.stop_confirmed===true;row.resources_released=run.cancellation?.resources_released===true
   row.assignments=[]
   for(const stage of run.stages.filter(s=>s.assignment_id)){
    const assignment=await call(`work-assignments/${stage.assignment_id}`)
    row.assignments.push({id:assignment.id,stop:assignment.stop?.receipt??null,resources:assignment.resources?.state??null,accounting:assignment.accounting?.receipt??null})
   }
   if(run.state==='cancelled'){assert.equal(row.stop_confirmed,true);assert.equal(row.resources_released,true)}
  }
  result.budget=(await call('budgets/budget')).budget
  const settled=result.runs.every(r=>['cancelled','completed'].includes(r.state)&&r.assignments.every(a=>a.stop?.state==='execution_drained'&&a.resources==='released'&&a.accounting?.reservation?.finalized===true))
  if(settled&&result.budget.reserved===0)result.state='confirmed'
 }catch(error){result.issues.push({phase:'official_cancellation',...details(error)})}
 finally{await controller.close().catch(error=>result.issues.push({phase:'cleanup_controller_close',...details(error)}))}
 return result
}
export async function withNativeTaskCleanup(context,work){
 try{return await work()}catch(error){
  let cleanup
  try{cleanup=await cancelNativeTaskFailure(context)}catch(failure){cleanup={state:'unconfirmed',issues:[details(failure)]}}
  const evidence={original_error:details(error),cleanup}
  try{await writeFile(join(process.env.KODE_TEST_LIVE_EVIDENCE_DIR,'failure-cleanup.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600})}catch(failure){evidence.evidence_error=details(failure)}
  context.t.diagnostic(JSON.stringify({native_task_failure:evidence}))
  throw error // Preserve original identity/stack; cleanup must never replace the cause.
 }
}
