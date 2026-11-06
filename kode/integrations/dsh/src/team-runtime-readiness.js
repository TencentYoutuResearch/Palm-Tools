/** Default Host adapter inspection. Does not authorize activation or attest remote runtime state. */
import { assignmentToolNames } from './assignment-tools.js'
import { verificationReadiness } from './verification-readiness.js'
import { inspectArtifactRepository } from './artifact-snapshot.js'
export function teamRuntimeReadiness(runtime,review){
 const bindings=review.configuration?.bindings
 if(!runtime||runtime.closed)return {status:'runtime_unavailable',default_adapter_checks_complete:false,eligible_for_execution:false}
 if(!Array.isArray(bindings))return {status:'configuration_unavailable',default_adapter_checks_complete:false,eligible_for_execution:false}
 const stages=[]
 for(const binding of bindings){
  const project=binding.project?.config?.spec,pack=binding.workflow?.pack
  for(const stage of pack?.stages??[]){
   const issues=[]
   if(!stage.execution)issues.push('stage_execution_scope_missing')
   else if(!stage.execution.tools.every(tool=>assignmentToolNames.includes(tool)))issues.push('default_stage_tool_unavailable')
   const verification=[]
   for(const output of stage.produces){
    const rule=pack.evidence_rules?.[output]
    if(rule?.kind!=='verification')continue
    const status=verificationReadiness(runtime,project,stage,rule)
    verification.push({output,status})
    if(status!=='registered')issues.push(status)
   }
   stages.push({binding_id:binding.id,stage_id:stage.id,issues:[...new Set(issues)],verification})
  }
 }
 return {status:'inspected',home_hub:runtime.host,stages,default_adapter_checks_complete:stages.length>0&&stages.every(s=>!s.issues.length),
  eligible_for_execution:false,checked_at:Date.now(),pending_checks:['remote_execution_adapters','executor_profile_and_model_support','executable_identity_at_launch','live_grant_budget_and_resource_admission','artifact_and_delivery_evidence']}
}

/** Product preflight also checks read-only local artifact prerequisites within
 * the exact owner-selected scope. No repository content, command or commit is created.
 */
export async function inspectTeamRuntimeReadiness(runtime,review,{workspaces=review.team?.spec?.workspace_refs??[],signal}={}){
 const result=teamRuntimeReadiness(runtime,review)
 if(result.status!=='inspected')return result
 const inspected=new Map()
 for(const entry of result.stages){
  const binding=review.configuration.bindings.find(b=>b.id===entry.binding_id)
  const stage=binding.workflow.pack.stages.find(s=>s.id===entry.stage_id)
  if(!stage.execution?.tools.includes('kode_capture_output'))continue
  const repository=binding.project?.config?.spec?.repositories?.[stage.execution.repository_binding],workspace=repository?.workspace
  let status
  if(!workspace||!workspaces.some(w=>w.host_id===workspace.host_id&&w.workspace_id===workspace.workspace_id&&w.root_ref===workspace.root_ref))status='artifact_repository_outside_selected_scope'
  else if(workspace.host_id!==runtime.host)status='artifact_repository_remote_unchecked'
  else{
   const root=workspace.root_ref
   if(!inspected.has(root)){
    try{await inspectArtifactRepository({workspaceRoot:root,signal});inspected.set(root,'ready')}
    catch(error){if(signal?.aborted)throw error;inspected.set(root,'artifact_repository_baseline_unavailable')}
   }
   status=inspected.get(root)
  }
  entry.artifact_repository={status,repository_id:repository?.repository_id??null}
  if(status!=='ready')entry.issues.push(status)
 }
 result.default_adapter_checks_complete=result.stages.length>0&&result.stages.every(s=>!s.issues.length)
 return result
}
