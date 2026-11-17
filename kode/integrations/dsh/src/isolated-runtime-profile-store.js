/** Single-scope durable accounting facade, never a view of parent profiles.
 * Contains no provider credentials. Caller owns the operation lease lifecycle.
 * A stale lock is an explicit reconciliation blocker, never permission to steal it.
 */
import {open,readFile,rename,unlink,mkdir} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
const fail=message=>Object.assign(Error(message),{code:'SCOPED_PROFILES_REJECTED'})
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
const revision=v=>Number.isSafeInteger(v)&&v>0||typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const clone=value=>structuredClone(value)
export async function openIsolatedRuntimeProfiles({path,authority,binding,mode,domain,validateAuthority}){
  authority=clone(authority);binding=clone(binding)
  if(typeof validateAuthority!=='function'||!token(domain))throw fail('Trusted domain validator required')
  const identity=clone(validateAuthority(clone(authority)))
  if(!identity||!['session_id','operation_id','journal_id','home_hub'].every(k=>token(identity[k]))
    ||Object.keys(identity).length!==4||!['fresh','restore'].includes(mode)||typeof path!=='string'||!path
    ||binding?.managedOperation?.id!==identity.operation_id||!revision(binding?.revision)
    ||!['attempt','epoch'].every(k=>Number.isSafeInteger(binding.managedOperation[k])&&binding.managedOperation[k]>0)
    ||Object.keys(binding).some(k=>!['revision','managedOperation'].includes(k))
    ||binding.managedOperation.home_node!==undefined&&binding.managedOperation.home_node!==identity.home_hub
    ||Object.keys(binding.managedOperation).some(k=>!['id','attempt','epoch','home_node'].includes(k)))throw fail('Exact scoped accounting binding required')
  const file=resolve(path),lock=`${file}.lock`,owner=randomUUID(),session=identity.session_id
  await mkdir(dirname(file),{recursive:true})
  const handle=await open(lock,'wx',0o600)
  try{await handle.writeFile(owner);await handle.sync()}finally{await handle.close()}
  let state,chain=Promise.resolve(),closed=false,failed=false,closing
  const validate=value=>{
    if(!value||Object.keys(value).some(k=>!['version','domain','authority','bindings'].includes(k))||value.version!==1||value.domain!==domain||!isDeepStrictEqual(value.authority,authority)
      ||!value.bindings||Object.keys(value.bindings).length!==1||!Object.hasOwn(value.bindings,session))throw fail('Scoped profile origin or session changed')
    const row=value.bindings[session]
    if(!row||row.revision!==binding.revision||!isDeepStrictEqual(row.managedOperation,binding.managedOperation)
      ||Object.keys(row).some(k=>!['revision','managedOperation','officialCalls','selectionOutbox'].includes(k)))throw fail('Scoped profile fixed binding changed')
    // Outboxes own only these accounting collections. No parent/private profile
    // configuration, secret, other session or arbitrary new fields can be saved.
    for(const key of ['officialCalls','selectionOutbox'])if(row[key]!==undefined&&(!row[key]||typeof row[key]!=='object'||Array.isArray(row[key])))throw fail('Invalid scoped accounting collection')
    for(const call of Object.values(row.officialCalls??{})){
      const request=call?.request
      if(request?.worker_session!==session||request.operation_id!==binding.managedOperation.id
        ||request.attempt!==binding.managedOperation.attempt||request.epoch!==binding.managedOperation.epoch
        ||(call.home_node??null)!==(binding.managedOperation.home_node??null))throw fail('Foreign official call binding')
    }
    for(const evidence of Object.values(row.selectionOutbox??{})){
      if(!isDeepStrictEqual(evidence?.operation,binding.managedOperation)||evidence.evidence?.worker_session!==session
        ||evidence.evidence.operation_id!==binding.managedOperation.id||evidence.evidence.attempt!==binding.managedOperation.attempt
        ||evidence.evidence.epoch!==binding.managedOperation.epoch)throw fail('Foreign selection evidence binding')
    }
  }
  const release=async()=>{
    if(await readFile(lock,'utf8')!==owner)throw fail('Scoped profile lock ownership changed')
    await unlink(lock)
  }
  const persist=async(value,initial=false)=>{
    validate(value)
    if(await readFile(lock,'utf8')!==owner)throw fail('Scoped profile lock ownership changed')
    const text=JSON.stringify(value)
    if(Buffer.byteLength(text)>16*1024*1024)throw fail('Scoped accounting backlog exceeds limit')
    const temp=initial?file:`${file}.tmp-${owner}`
    const writer=await open(temp,'wx',0o600)
    try{await writer.writeFile(text);await writer.sync()}finally{await writer.close()}
    if(!initial)await rename(temp,file)
    const directory=await open(dirname(file),'r')
    try{await directory.sync()}finally{await directory.close()}
  }
  try{
    if(mode==='fresh'){
      state={version:1,domain,authority,bindings:{[session]:binding}}
      await persist(state,true)
    }else{state=JSON.parse(await readFile(file,'utf8'));validate(state)}
  }catch(error){await release().catch(()=>{});throw error}
  return Object.freeze({
    binding(id){return id===session?clone(state.bindings[session]):undefined},
    get bindings(){return clone(state.bindings)},
    update(change){
      if(closed||failed||typeof change!=='function')return Promise.reject(fail('Scoped profile writer unavailable'))
      const work=chain.then(async()=>{
        if(failed)throw fail('Scoped profile durability uncertain')
        const next=clone(state),result=await change(next),proposed=clone(next)
        validate(proposed)
        // Once filesystem persistence begins, a failure may follow a committed
        // rename. Fence rather than overwriting or retrying unknown state.
        try{await persist(proposed)}catch(error){failed=true;throw error}
        state=proposed
        return clone(result)
      })
      chain=work.catch(()=>{})
      return work
    },
    close(){return closing??=(async()=>{closed=true;await chain;await release()})()},
  })
}
