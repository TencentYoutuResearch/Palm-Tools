/** Internal, explicit public-knowledge contract. Parsing is NOT owner approval.
 * Only the trusted Host resolver may supply this manifest. No ambient providers.
 */
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {appendPluginRecord,pluginRecordOf} from '@deepseek-ai/dsh-session'
export const PUBLIC_MANIFEST_RECORD='plugin:kode/scoped-public-manifest'
export const publicTextHash=text=>createHash('sha256').update(text).digest('hex')
export const canonicalManifestHash=value=>publicTextHash(JSON.stringify(canonical(value)))
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) ;return value}
const fail=message=>Object.assign(Error(message),{code:'SCOPED_PUBLIC_MANIFEST_REJECTED'})
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&Object.keys(value).every(k=>keys.includes(k))
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value}
const textEntry=value=>exact(value,['text','sha256'])&&typeof value.text==='string'&&value.text.length<=65536&&!value.text.includes('\0')&&value.sha256===publicTextHash(value.text)
export function validatePublicManifest(value,contextKey){
  const m=structuredClone(value)
  if(!exact(m,['version','context_key','procedure','shared','tools'])||m.version!==1||m.context_key!==contextKey
    ||!textEntry(m.procedure)||!Array.isArray(m.shared)||m.shared.length>64||!Array.isArray(m.tools)||m.tools.length!==0)throw fail('Invalid exact public manifest; this slice permits explicit empty tools only')
  const ids=new Set()
  for(const entry of m.shared){
    if(!exact(entry,['id','revision','text','sha256'])||typeof entry.id!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(entry.id)
      ||!Number.isSafeInteger(entry.revision)||entry.revision<1||ids.has(entry.id)||!textEntry({text:entry.text,sha256:entry.sha256}))throw fail('Invalid or duplicate shared knowledge entry')
    ids.add(entry.id)
  }
  // Explicit ordered encoding, independent of incoming object property order.
  const hash=publicTextHash(JSON.stringify([m.version,m.context_key,[m.procedure.text,m.procedure.sha256],
    m.shared.map(e=>[e.id,e.revision,e.text,e.sha256]),m.tools]))
  return freeze({manifest:m,hash})
}
export function bindPublicManifest(session,accepted,mode,toolManifest=null){
  const expected={version:1,context_key:accepted.manifest.context_key,manifest_sha256:accepted.hash,tool_manifest_sha256:canonicalManifestHash(toolManifest)}
  const rows=session.snapshotEvents().filter(e=>pluginRecordOf(e)?.type===PUBLIC_MANIFEST_RECORD)
  if(mode==='fresh'){
    if(rows.length!==0)throw fail('Fresh public manifest already exists')
    appendPluginRecord(session,PUBLIC_MANIFEST_RECORD,expected)
  }else if(rows.length!==1||rows[0].seq!==1||!isDeepStrictEqual(rows[0].data,expected))throw fail('Restored public manifest identity or hash changed')
}
export function mountPublicManifest(prompt,accepted){
  const m=accepted.manifest
  prompt.section({name:'kode.scoped.public-procedure',order:0,text:m.procedure.text,interpolate:false})
  m.shared.forEach((entry,index)=>prompt.section({name:`kode.scoped.shared.${entry.id}`,order:index+1,text:entry.text,interpolate:false}))
}
