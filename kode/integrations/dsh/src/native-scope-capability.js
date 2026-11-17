/** Source-owned capability floor. Caller/profile flags cannot create evidence. */
export function nativeScopeCapability({profile,selection,grant}={}) {
  const protocol=profile?.type==='codex'||profile?.protocol==='codex'?'codex':['cursor','claude','codebuddy','custom'].includes(profile?.type)?'acp':null
  const reasons=[]
  if(!protocol)reasons.push('native_protocol_unsupported')
  if(!selection?.model||selection.model==='default')reasons.push('concrete_selection_required')
  if(!grant||typeof grant!=='object')reasons.push('frozen_grant_required')
  if(protocol==='codex')reasons.push('effective_selection_readback_unverified')
  if(protocol==='acp')reasons.push('native_usage_attribution_unresolved')
  reasons.push('sandbox_read_scope_unverified')
  return Object.freeze({supported:false,protocol,selection_verification:protocol==='acp'?'per_turn_config_response_required':'unverified',
    usage_collector:protocol==='codex'?'original_codex_usage_outbox':'unresolved',tool_scope_verified:false,reasons:Object.freeze(reasons)})
}
