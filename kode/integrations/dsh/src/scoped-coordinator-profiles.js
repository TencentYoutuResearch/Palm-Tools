/** Coordinator identity policy over the domain-neutral durable single-writer core. */
import {contextScopeKey} from './context-scope.js'
import {openIsolatedRuntimeProfiles} from './isolated-runtime-profile-store.js'
const fail=()=>Object.assign(Error('Exact scoped accounting binding required'),{code:'SCOPED_PROFILES_REJECTED'})
export function openScopedCoordinatorProfiles(options){
  return openIsolatedRuntimeProfiles({...options,domain:'coordinator-v2',validateAuthority:a=>{
    if(!a||a.context_key!==contextScopeKey(a.context_scope)
      ||Object.keys(a).some(k=>!['context_key','context_scope','session_id','journal_id','operation_id','operation_revision','attempt','epoch','control_revision','team_revision','audience_revision','worker','origin','surface_id','thread_id','runtime_ready','dispatch_allowed','stage'].includes(k))
      ||a.session_id!==`context-${a.context_key}`)throw fail()
    return {session_id:a.session_id,operation_id:a.operation_id,journal_id:a.journal_id,home_hub:a.context_scope.home_hub}
  }})
}
