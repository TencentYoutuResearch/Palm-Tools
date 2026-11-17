/** Local transport boundary only. Authority and durability remain the caller's job.
 * An abandoned iterator deliberately retains its lease: callers must drain,
 * return(), or abort it. An uncooperative provider cannot be forcibly stopped.
 */
import {isDeepStrictEqual} from 'node:util'
const fail=message=>Object.assign(Error(message),{code:'SCOPED_TRANSPORT_REJECTED'})
const freeze=value=>{
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value)}
  return value
}
export function snapshotProviderRequest(candidate){
  if(!candidate||Object.getPrototypeOf(candidate)!==Object.prototype
    ||Reflect.ownKeys(candidate).some(k=>!['sessionId','provider','model','reasoningEffort','messages','toolHistory','tools','signal'].includes(k)))throw fail('Unexpected provider request fields')
  for(const key of Reflect.ownKeys(candidate))if(!Object.hasOwn(Object.getOwnPropertyDescriptor(candidate,key),'value'))throw fail('Provider request accessors forbidden')
  const {signal,...content}=candidate
  if(signal!==undefined&&!(signal instanceof AbortSignal))throw fail('Native AbortSignal required')
  return {content:structuredClone(content),signal}
}
export function verifyProviderRequest(snapshot,expected){
  const content=snapshot.content
  // AgentLoop omits tools only when there are no tools. Nonempty schemas must match.
  if(!Object.hasOwn(content,'tools')&&Array.isArray(expected.tools)&&expected.tools.length===0)content.tools=[]
  if(!isDeepStrictEqual(content,expected))throw fail('Provider request differs from owned Session projections')
  return Object.freeze({...freeze(structuredClone(expected)),...(snapshot.signal===undefined?{}:{signal:snapshot.signal})})
}

/** Takes ownership of release immediately, including synchronous provider failure.
 * Serialize iterator operations; abort waits for outstanding next then closes.
 * Cleanup failure fences the session via failed(), never silently reuses it.
 */
export async function scopedProviderLifetime({invoke,signal,release,failed=()=>{},validate=()=>{}}){
  let iterator,ended=false,aborted=false,tail=Promise.resolve()
  const abortError=()=>signal?.reason??new DOMException('Aborted','AbortError')
  const finish=()=>{if(!ended){ended=true;signal?.removeEventListener('abort',onAbort);release()}}
  const enqueue=operation=>{const result=tail.then(operation);tail=result.catch(()=>{});return result}
  const close=async()=>{
    if(ended)return
    try{
      if(!iterator?.return)throw fail('Provider iterator has no cancellation method')
      const result=await iterator.return()
      if(!result?.done)throw fail('Provider iterator did not finish cancellation')
    }catch(error){failed();throw error}finally{finish()}
  }
  const onAbort=()=>{aborted=true;if(iterator)void enqueue(close).catch(()=>{})}
  signal?.addEventListener('abort',onAbort,{once:true})
  try{
    if(signal?.aborted){aborted=true;throw abortError()}
    const result=await invoke()
    if(result?.[Symbol.asyncIterator])iterator=result[Symbol.asyncIterator]()
    if(!iterator){if(aborted)throw abortError();finish();return result}
    if(aborted){await close();throw abortError()}
    return {
      [Symbol.asyncIterator](){return this},
      next(value){return enqueue(async()=>{
        if(aborted)throw abortError()
        if(ended)return {done:true,value:undefined}
        try{
          validate()
          const result=await iterator.next(value)
          if(aborted){await close();throw abortError()}
          validate()
          if(result.done)finish()
          return result
        }catch(error){await close();throw error}
      })},
      return(value){return enqueue(async()=>{if(!ended)await close();return {done:true,value}})},
      throw(error){return enqueue(async()=>{if(!ended)await close();throw error})},
    }
  }catch(error){finish();throw error}
}
