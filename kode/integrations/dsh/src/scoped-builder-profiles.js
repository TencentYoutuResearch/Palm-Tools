/** One draft-owned accounting file. Never a facade over the parent's profiles. */
import {validateBuilderAuthority} from './builder-context-scope.js'
import {openIsolatedRuntimeProfiles} from './isolated-runtime-profile-store.js'
export function openScopedBuilderProfiles(options){
  const authority=validateBuilderAuthority(options.authority)
  if(options.binding?.managedOperation?.attempt!==authority.operation.attempt||options.binding?.managedOperation?.epoch!==authority.operation.epoch)throw Error('Builder accounting operation generation mismatch')
  return openIsolatedRuntimeProfiles({...options,authority,domain:'builder-v1',validateAuthority:value=>{
    const a=validateBuilderAuthority(value)
    return {session_id:a.session_id,operation_id:a.operation.id,journal_id:a.journal_id,home_hub:a.builder_context.home_hub}
  }})
}
