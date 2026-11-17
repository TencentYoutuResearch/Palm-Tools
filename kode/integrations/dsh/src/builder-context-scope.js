/** Draft identity is independent of a proposed TeamSpec and its funding policy.
 * Epoch comes from the trusted server registry, never a browser or model label.
 */
import {createHash} from 'node:crypto'
const fail=message=>Object.assign(Error(message),{code:'BUILDER_CONTEXT_REJECTED'})
export const builderToken=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&Object.keys(value).every(k=>keys.includes(k))
export function validateBuilderContext(value){
  if(!exact(value,['version','kind','home_hub','draft_id','context_epoch'])||value.version!==1||value.kind!=='builder_draft'
    ||!builderToken(value.home_hub)||!builderToken(value.draft_id)||!Number.isSafeInteger(value.context_epoch)||value.context_epoch<1)throw fail('Exact server-issued Builder draft identity required')
  return Object.freeze({...value})
}
export function builderContextKey(value){
  const s=validateBuilderContext(value)
  return createHash('sha256').update(JSON.stringify([s.version,s.kind,s.home_hub,s.draft_id,s.context_epoch])).digest('hex')
}
export function validateBuilderJournal(value){
  const a=structuredClone(value)
  if(!exact(a,['builder_context','session_id','journal_id'])||!builderToken(a.journal_id))throw fail('Exact trusted Builder journal required')
  a.builder_context=validateBuilderContext(a.builder_context)
  if(a.session_id!==`builder-context-${builderContextKey(a.builder_context)}`)throw fail('Builder session identity mismatch')
  return Object.freeze(a)
}
export function validateBuilderAuthority(value){
  const a=structuredClone(value)
  if(!exact(a,['builder_context','context_key','session_id','journal_id','operation']))throw fail('Exact Builder execution authority required')
  validateBuilderJournal({builder_context:a.builder_context,session_id:a.session_id,journal_id:a.journal_id})
  if(a.context_key!==builderContextKey(a.builder_context)||!exact(a.operation,['id','attempt','epoch'])||!builderToken(a.operation.id)
    ||!['attempt','epoch'].every(k=>Number.isSafeInteger(a.operation[k])&&a.operation[k]>0))throw fail('Builder operation identity mismatch')
  Object.freeze(a.builder_context);Object.freeze(a.operation)
  return Object.freeze(a)
}
