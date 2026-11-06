/** Inspect the frozen binding against registered metadata without launching a command. */
import { isDeepStrictEqual } from 'node:util'
export function verificationReadiness(runtime,project,stage,rule){
 const command=project?.commands?.[rule.command_binding],environment=project?.environments?.[rule.environment_binding]
 if(!command||!environment||command.environment_binding!==rule.environment_binding||command.repository_binding!==stage.execution?.repository_binding)return 'verification_binding_incomplete'
 if(environment.host_id!==runtime?.host)return 'remote_verification_not_checked'
 if(environment.adapter_id!=='local_process_v1')return 'verification_adapter_unavailable'
 let reference
 try{reference=runtime.verificationRunners.reference(command.runner_id,command.id,command.revision)}catch{return 'verification_command_unregistered'}
 if(reference.definition_hash!==command.definition_hash||reference.environment_hash!==environment.configuration_hash
   ||!isDeepStrictEqual(reference.exclusive_resources??[],command.exclusive_resources??[])
   ||(reference.exclusive_resources?.length&&!runtime.exclusiveResources)
   ||!isDeepStrictEqual(reference.scenario_ids,[...(command.scenario_ids??[])].sort())
   ||rule.required_scenarios.some(id=>!reference.scenario_ids.includes(id)))return 'verification_definition_mismatch'
 if(!stage.execution.tools.includes(reference.tool_id)||reference.capabilities.some(c=>!stage.execution.capabilities.includes(c))||(reference.network&&!stage.execution.network))return 'verification_scope_insufficient'
 return 'registered'
}
