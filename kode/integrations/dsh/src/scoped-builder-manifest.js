/** Public procedure is pinned separately from mutable draft/source records.
 * This parser cannot approve shared information or register runtime authority.
 */
import {validatePublicManifest,publicTextHash,bindPublicManifest,mountPublicManifest,canonicalManifestHash} from './scoped-coordinator-prompt.js'
import {BUILDER_PROMPT} from './builder-prompt.js'
import {OFFICIAL_BUILDER_TOOLS} from './official-builder-tools.js'
const fail=message=>Object.assign(Error(message),{code:'BUILDER_MANIFEST_REJECTED'})
export {bindPublicManifest,mountPublicManifest,publicTextHash,canonicalManifestHash}
export function validateBuilderManifest(value,key){
  const checked=validatePublicManifest(value,key)
  if(checked.manifest.procedure.text!==BUILDER_PROMPT)throw fail('Builder procedure differs from reviewed implementation')
  return checked
}
export function builderPublicManifest(key,shared=[]){
  return {version:1,context_key:key,procedure:{text:BUILDER_PROMPT,sha256:publicTextHash(BUILDER_PROMPT)},shared:structuredClone(shared),tools:[]}
}
export function validateBuilderToolManifest(value){
  const rows=structuredClone(value)
  if(!Array.isArray(rows)||rows.length>OFFICIAL_BUILDER_TOOLS.length||new Set(rows.map(row=>row?.name)).size!==rows.length)throw fail('Exact Builder tool manifest required')
  for(const row of rows){
    if(!row||Object.keys(row).sort().join(',')!=='description,name,parameters'||!OFFICIAL_BUILDER_TOOLS.includes(row.name)
      ||typeof row.description!=='string'||!row.description||!row.parameters||row.parameters.type!=='object'
      ||row.parameters.additionalProperties!==false||!Array.isArray(row.parameters.required))throw fail('Only reviewed planning tools are allowed')
  }
  return rows.sort((a,b)=>a.name.localeCompare(b.name))
}
