/** Coordinator authority policy; all durability and lifecycle logic lives in the pure core. */
import {validateContextScope,contextScopeKey} from './context-scope.js'
import {SCOPED_COORDINATOR_JOURNAL_RECORD} from './scoped-coordinator-journal.js'
import {createIsolatedRuntimeSessionAdapter} from './isolated-runtime-session-adapter.js'
export function createScopedCoordinatorSessionAdapter(originalSessions,resolveAdmission){
  return createIsolatedRuntimeSessionAdapter(originalSessions,resolveAdmission,{
    recordName:SCOPED_COORDINATOR_JOURNAL_RECORD,
    isReservedId:id=>typeof id==='string'&&/^context-[a-f0-9]{64}$/.test(id),
    normalizeAuthority(a,id){
      const fail=message=>Object.assign(Error(message),{code:'SCOPED_SESSION_REJECTED'})
      if(!a||Object.keys(a).length!==3||!['context_scope','session_id','journal_id'].every(k=>Object.hasOwn(a,k)))throw fail('Missing trusted scoped admission')
      a.context_scope=validateContextScope(a.context_scope)
      if(a.context_scope.kind==='builder_draft'||a.session_id!==id||id!==`context-${contextScopeKey(a.context_scope)}`)throw fail('Trusted scope/session mismatch')
      return a
    },
  })
}
