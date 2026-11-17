/** Team roles select existing CLI/model targets. No fallback, fan-out or new identity. */
export function interactiveTargets(team,workerId,scope){
 if(team?.spec?.execution_mode!=='interactive_native')return []
 const allowed=workerId?team.spec.workers?.find(w=>w.id===workerId)?.allowed_target_ids:team.spec.coordinator_targets
 return (team.spec.execution_targets??[]).filter(t=>allowed?.includes(t.id)&&t.host_id===scope.host_id)
}
export function interactiveSelection(team,workerId,targetId,scope,surface){
 if(!surface.enabled||!surface.team_ids?.includes(team?.id)||team.home_hub!==scope.home_hub||!team.spec.workspace_refs?.some(w=>w.host_id===scope.host_id&&w.workspace_id===scope.workspace_id&&w.root_ref===scope.root_ref)||!interactiveTargets(team,workerId,scope).some(t=>t.id===targetId))throw Error('请选择当前职责可用的 CLI / 模型组合。')
 if(!Number.isSafeInteger(team.revision)||team.revision<1||!Number.isSafeInteger(surface.audience_revision)||surface.audience_revision<1)throw Error('团队或受众版本已变化。')
 return {team_id:team.id,team_revision:team.revision,participant_id:workerId?'worker:'+workerId:'coordinator',target_id:targetId,workspace_id:scope.workspace_id,audience_revision:surface.audience_revision}
}
export const interactiveTargetLabel=t=>[t.executor_profile_id,t.model_id??t.model,t.effort??t.reasoning_effort,t.id].filter(Boolean).join(' · ')
export function interactiveTargetTier(target,configuration){
 const assignments=configuration?.teamRoleTargets?.assignments??configuration?.teamRolePreferences?.assignments??{}
 const candidates=configuration?.teamRoleTargets?assignments.superagent??[]:[assignments.superagent,assignments.superagent_lite].filter(Boolean)
 const matches=candidate=>candidate?.profileId===target?.executor_profile_id&&candidate?.model===(target?.model_id??target?.model)
 return matches(candidates[0])?'Reasonable':matches(candidates[1])?'Lite':''
}
