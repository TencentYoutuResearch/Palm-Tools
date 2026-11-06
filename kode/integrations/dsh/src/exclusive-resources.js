/** Host-local named resource exclusion in one explicitly shared trusted namespace. */
import { createHash } from 'node:crypto'
import { mkdir,lstat,realpath } from 'node:fs/promises'
import { join,isAbsolute } from 'node:path'
import { WorkspaceLocks } from './workspace-locks.js'
export function resourceNames(values){
 if(!Array.isArray(values)||values.length>16||values.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(value))||new Set(values).size!==values.length)throw Error('Invalid exclusive resource identities')
 return [...values].sort()
}
// Retain unclosed leases even when a stopped runtime drops its local reference.
// Uncertain device processes must not become available through garbage collection.
const retained=new Set()
export class ExclusiveResources {
 #active=new WeakMap()
 constructor(directory){
  if(!isAbsolute(directory))throw Error('Absolute shared resource namespace required')
  this.directory=directory
  this.locks=new WorkspaceLocks(join(directory,'locks'))
 }
 async acquire(values,owner,{signal}={}){
  const resources=resourceNames(values),held=[]
  signal?.throwIfAborted()
  if(typeof owner!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(owner))throw Error('Explicit resource owner required')
  await mkdir(this.directory,{recursive:true,mode:0o700})
  const directory=await realpath(this.directory)
  try{
   for(const resource of resources){
    signal?.throwIfAborted()
    const key=createHash('sha256').update('kode.exclusive.resource.v1\n'+resource).digest('hex'),slot=join(directory,key)
    await mkdir(slot,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
    if(!(await lstat(slot)).isDirectory()||await realpath(slot)!==slot)throw Error('Exclusive resource identity changed')
    held.push(await this.locks.acquire(slot,owner,{signal}))
   }
   signal?.throwIfAborted()
   let releasing
   const lease=Object.freeze({owner,resources:Object.freeze(resources),release:()=>{
    this.#active.delete(lease)
    return releasing??=(async()=>{const results=await Promise.allSettled([...held].reverse().map(row=>row.release()));const failure=results.find(row=>row.status==='rejected');if(failure)throw failure.reason;retained.delete(lease)})()
   }})
   this.#active.set(lease,{signal});retained.add(lease);return lease
  }catch(error){
   await Promise.allSettled(held.reverse().map(row=>row.release()))
   if(error.code==='WORKSPACE_BUSY')throw Object.assign(Error('Exclusive resource is already owned'),{code:'EXCLUSIVE_RESOURCE_BUSY'})
   throw error
  }
 }
 assertHeld(lease,values,owner){
  const expected=resourceNames(values)
  if(!lease||!this.#active.has(lease)||lease.owner!==owner||JSON.stringify(lease.resources)!==JSON.stringify(expected))throw Error('Exclusive resource lease unavailable')
  this.#active.get(lease).signal?.throwIfAborted()
 }
}
