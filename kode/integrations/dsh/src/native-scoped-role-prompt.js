/** Coordinator prompt projection from authenticated, current scope and exact
 * saved Team revision. No permission, model selection or history is imported. */
import {isDeepStrictEqual} from 'node:util'
import {snapshotTeamRolePrompt} from './team-role-prompts.js'
const fail=message=>Object.assign(Error(message),{code:'SCOPED_ROLE_PROMPT_REJECTED'})
export function createScopedRolePromptResolver({sourceAuthority,ownsAgent}){
 if(![sourceAuthority,ownsAgent].every(fn=>typeof fn==='function'))throw fail('Trusted Host readers required')
 return async (agent,{authority,mode})=>{
  if(!['fresh','restore','check'].includes(mode)||ownsAgent(agent,authority)!==true)throw fail('Foreign native role prompt caller')
  authority=structuredClone(authority)
  const check=row=>{
   const frozen=row?.host_binding?.frozen,scope=authority.context_scope
   if(row?.source_read_allowed!==true||row.dispatch_allowed!==false||!isDeepStrictEqual(row.authority,authority)
    ||agent.id!==authority.session_id||!['discussion_thread','team_private'].includes(scope?.kind)
    ||!Number.isSafeInteger(authority.team_revision)||authority.team_revision<1
    ||frozen?.context?.team_revision!==authority.team_revision
    ||!isDeepStrictEqual(frozen.context.context_scope,scope)||frozen.context.key!==authority.context_key
    ||row.host_binding.state!=='bound_not_admitted'||row.host_binding.revision!==1)throw fail('Role prompt scope authority changed')
   return structuredClone(row.host_binding.frozen)
  }
  const first=await sourceAuthority(authority.context_key)
  const frozen=check(first)
  const team=structuredClone(first.team_snapshot)
  if(team?.id!==authority.context_scope.team_id||team.home_hub!==authority.context_scope.home_hub||team.revision!==authority.team_revision)throw fail('Role prompt Team revision mismatch')
  const result=snapshotTeamRolePrompt({home_hub:team.home_hub,team_id:team.id,team_revision:team.revision,spec:team.spec})
  if(!isDeepStrictEqual(check(await sourceAuthority(authority.context_key)),frozen))throw fail('Role prompt frozen Host changed')
  return result
 }
}
