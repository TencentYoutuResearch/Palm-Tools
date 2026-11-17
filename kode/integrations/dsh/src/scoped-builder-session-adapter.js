/** Draft-specific admission policy for the existing SessionStore/factory writer.
 * The resolver is supplied by the trusted Host, never by model/session options.
 * Native factories must carry the backend's restore eventState into prepare().
 */
import {validateBuilderJournal} from './builder-context-scope.js'
import {createIsolatedRuntimeSessionAdapter} from './isolated-runtime-session-adapter.js'
export const BUILDER_JOURNAL_RECORD='plugin:kode/scoped-builder-journal'
export function createScopedBuilderSessionAdapter(store,resolveAdmission){
  return createIsolatedRuntimeSessionAdapter(store,resolveAdmission,{
    recordName:BUILDER_JOURNAL_RECORD,
    normalizeAuthority:(authority,id)=>{
      const a=validateBuilderJournal(authority)
      if(a.session_id!==id)throw Error('Builder session differs from trusted journal')
      return a
    },
    isReservedId:id=>typeof id==='string'&&/^builder-context-[a-f0-9]{64}$/.test(id),
  })
}
