/** Fixed activated scope; home owns local and remote facts. No provider calls or reservations. */
export async function readCoordinatorResources(call, activation, team, after = '') {
  const spec = activation.snapshot?.team?.spec, policies = activation.snapshot?.policies
  if (!Array.isArray(spec?.execution_targets) || policies?.budget?.policy?.kind !== 'budget' || policies?.scheduling?.policy?.kind !== 'scheduling') {
    return { status: 'configuration_unavailable', eligible_for_execution: false }
  }
  const configured = [...spec.execution_targets].sort((a,b)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (after && !configured.some(t=>t.id===after)) throw Error('Unknown Coordinator resource cursor')
  const selected = configured.filter(t=>t.id>after).slice(0,8), budgetPolicy=policies.budget.policy
  const bounded = value => Buffer.byteLength(JSON.stringify(value)) <= 2048
  const read = async path => { try { return await call(path) } catch { return null } }
  const team_budgets = await Promise.all(budgetPolicy.budget_ids.map(async id => {
    const snapshot=await read(`budgets/${encodeURIComponent(id)}`), b=snapshot?.budget
    if (!b || b.id!==id || b.unit!==budgetPolicy.unit || !(b.scope==='shared'||b.scope==='team'&&b.scope_id===team) || !bounded(snapshot)) {
      return { id, label:'团队预算', status:'unavailable_or_mismatched', available:null }
    }
    const at=Date.now(), valid=b.starts_at<=at&&b.ends_at>at
    return {id,label:'团队预算',status:valid?'observed':'period_inactive',snapshot,
      covers_max_assignment_charge:valid&&snapshot.available>=budgetPolicy.max_assignment_charge,reserved_by_read:false}
  }))
  const targets=await Promise.all(selected.map(async target=>{
    const row={target_id:target.id,host:target.host_id,profile:target.executor_profile_id,model:target.model_id,
      eligible_for_execution:false,provider_windows:{status:'unavailable'},provider_monetary:{status:'not_connected',sources:[]}}
    const policy=policies.scheduling.policy.targets[target.id]?.resource
    if (!policy || policy.host!==target.host_id || policy.profile!==target.executor_profile_id || policy.account_id!==target.account_binding_id) {
      return {...row,status:'target_policy_identity_mismatch'}
    }
    const query=`host=${encodeURIComponent(target.host_id)}&profile=${encodeURIComponent(target.executor_profile_id)}`
    const [binding,quota,money]=await Promise.all([read(`resource-binding?${query}`),read(`quota-snapshots?${query}`),read(`monetary-quota?${query}`)])
    const matches=b=>b?.binding_current===true&&b.host===policy.host&&b.profile===policy.profile&&b.account_id===policy.account_id&&b.account_epoch===policy.account_epoch&&b.revision===policy.binding_revision
    // Recheck the binding after facts: an account switch cannot expose prior account facts.
    if (!matches(binding)||!matches(await read(`resource-binding?${query}`)))return {...row,status:'binding_unavailable'}
    row.status='observed';row.unknown_quota_policy=policy.unknown_quota
    row.account={id:policy.account_id,epoch:policy.account_epoch,binding_revision:policy.binding_revision}
    if (quota) {
      const same=quota.binding_revision===undefined||(quota.binding_revision===policy.binding_revision&&quota.account_id===policy.account_id&&quota.account_epoch===policy.account_epoch)
      row.provider_windows=!same?{status:'binding_mismatch'}:bounded(quota)?quota:{status:'detail_limit_exceeded',details_included:false}
    }
    if (!money) row.provider_monetary={status:'authority_unavailable',sources:[]}
    else if(money.host!==policy.host||money.profile!==policy.profile)row.provider_monetary={status:'identity_mismatch',sources:[]}
    else if(!bounded(money))row.provider_monetary={status:'detail_limit_exceeded',sources:[],details_included:false}
    else row.provider_monetary={...money,status:money.sources?.length?'observed':'not_connected'}
    return row
  }))
  return {status:'observed',scope:'activated_team_resources',observed_at:Date.now(),configured_target_count:configured.length,
    targets,team_budgets,next_cursor:configured.some(t=>t.id>(selected.at(-1)?.id??after))?selected.at(-1)?.id:null,
    eligible_for_execution:false,reserved_by_read:false,limitations:['home_observations_not_live_provider_queries','unknown_or_stale_facts_are_not_available_balance','atomic_admission_still_required']}
}
