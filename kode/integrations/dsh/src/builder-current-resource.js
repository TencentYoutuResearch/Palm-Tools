import { profileRevision } from './agent-profiles.js'
import { controlledBinding, managedCodexEnabled, managedCodexRoute } from './managed-codex-profile.js'
/** The current Builder's own public execution identity; never a Host-wide inventory. */
export async function readBuilderCurrentResource(runtime,agent,draft){
 const binding=runtime.profiles.binding(agent.id),operation=binding?.managedOperation
 if(runtime.closed||draft?.home_hub!==runtime.host||draft.status!=='draft'||binding?.operationClosed||!controlledBinding(binding)||!operation
   ||!draft.interview.workspace_refs.some(w=>w.host_id===runtime.host))throw Error('Current Builder resource unavailable')
 const op=await runtime.client.call(`/api/v1/messaging/operations/${encodeURIComponent(operation.id)}`)
 if(op.id!==operation.id||op.attempt!==operation.attempt||op.epoch!==operation.epoch||op.worker?.node_id!==runtime.host||op.worker?.session_id!==agent.id
   ||!op.selection_policy||op.selection_policy.model!==agent.options.model||!agent.options.provider||agent.options.provider.startsWith('kode-agent-')
   ||(managedCodexEnabled(binding.profile)&&(!binding.managedBuilder||agent.options.provider!==managedCodexRoute(binding.profile.id))))throw Error('Current Builder execution identity changed')
 const account=await runtime.client.call(`/api/v1/messaging/resource-binding?host=${encodeURIComponent(runtime.host)}&profile=${encodeURIComponent(binding.profile.id)}`)
 if(account.host!==runtime.host||account.profile!==binding.profile.id)throw Error('Current Builder account identity mismatch')
 return {host_id:runtime.host,executor_profile_id:binding.profile.id,executor_profile_revision:profileRevision(binding.profile),provider_id:agent.options.provider,
  model_id:agent.options.model,effort:op.selection_policy.effort??null,
  account:account.account_id?{id:account.account_id,epoch:account.account_epoch,binding_revision:account.revision,current:account.binding_current===true}:null,
  role_fit_status:'not_assessed',quota_status:'not_checked',eligible_for_execution:false,
  capability_configuration:{proposed_initial_revision:'1',configuration_created:false,requires_owner_assessment:true},
  limitations:['current_builder_resource_only','reuse_requires_owner_review_and_separate_team_configuration','no_role_fit_or_quota_inference']}
}
