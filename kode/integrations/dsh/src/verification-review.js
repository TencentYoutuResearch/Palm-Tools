/** Owner review of a local executable. Registration does not execute or grant authority. */
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { verificationExecutableHash } from './verification-runners.js'
const fields=['runner_id','command_id','revision','executable','args','timeout_ms','max_output_bytes','scenario_ids','capabilities','network','tool_id']
const withResources=(v,keys)=>Object.hasOwn(v??{},'exclusive_resources')?[...keys,'exclusive_resources']:keys
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',')
const scope=(host,definition)=>createHash('sha256').update(JSON.stringify(['kode.verification.owner-review.v1',host,definition])).digest('hex')
export async function previewVerification(runners,host,input){
 if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(host)||!exact(input,withResources(input,fields)))throw Error('Exact local command review required')
 // Validate bounded command metadata before touching a file; environment is deliberately empty.
 const checked=runners.normalizeDefinition({...input,env:{},executable_hash:'0'.repeat(64)}).definition
 const executable=await realpath(checked.executable)
 if(!(await stat(executable)).isFile())throw Error('Executable regular file required')
 await access(executable,constants.X_OK)
 const row=runners.normalizeDefinition({...checked,executable,executable_hash:await verificationExecutableHash(executable)})
 return {host,definition:row.definition,reference:row.reference,scope_hash:scope(host,row.definition),execution_performed:false}
}
export async function confirmVerification(runners,host,review){
 if(!exact(review,['host','definition','reference','scope_hash','execution_performed'])||review.host!==host||review.execution_performed!==false||!exact(review.definition,withResources(review.definition,[...fields,'env','executable_hash']))||!exact(review.definition.env,[]))throw Error('Exact local owner review required')
 const row=runners.normalizeDefinition(review.definition)
 if(!isDeepStrictEqual(row.definition,review.definition)||!isDeepStrictEqual(row.reference,review.reference)||review.scope_hash!==scope(host,row.definition))throw Error('Reviewed scope mismatch')
 await runners.open()
 let prior
 try{prior=runners.reference(row.definition.runner_id,row.definition.command_id,row.definition.revision)}catch{}
 if(prior){if(!isDeepStrictEqual(prior,row.reference))throw Error('Immutable command identity conflict');return {host,reference:prior,execution_performed:false}}
 // No committed result: recheck the exact reviewed executable before first persistence.
 if(await realpath(row.definition.executable)!==row.definition.executable)throw Error('Reviewed executable identity changed')
 await access(row.definition.executable,constants.X_OK)
 if(await verificationExecutableHash(row.definition.executable)!==row.definition.executable_hash)throw Error('Reviewed executable content changed')
 return {host,reference:await runners.registerPersistent(row.definition),execution_performed:false}
}
