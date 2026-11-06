/** Persist the exact owner-reviewed command before registration transport. */
import { canonical } from './builder-accept-command.js'
const equal=(a,b)=>canonical(a)===canonical(b)
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
export const verificationReviewKey=(host,runner,command,revision)=>JSON.stringify(['verification-review',host,runner,command,revision])
function validate(review){
 if(!id(review?.host)||!['runner_id','command_id','revision'].every(k=>id(review.definition?.[k]))||!review.reference||review.reference.runner_id!==review.definition.runner_id||review.reference.id!==review.definition.command_id||review.reference.revision!==review.definition.revision||review.execution_performed!==false||!/^[a-f0-9]{64}$/.test(review.scope_hash??'')||Object.keys(review.definition.env??{invalid:true}).length)throw Error('Invalid reviewed local command')
}
function verify(record,result){
 if(!result||Object.keys(result).sort().join(',')!=='execution_performed,host,reference'||result.host!==record.review.host||result.execution_performed!==false||!equal(result.reference,record.review.reference))throw Error('Wrong command registration receipt')
 return result
}
export async function confirmReviewedVerification({host,runner,command,revision,review,storage,recover=false,request=requestVerificationReview,signal}){
 if(![host,runner,command,revision].every(id))throw Error('Exact command identity required')
 const key=verificationReviewKey(host,runner,command,revision)
 let record=await storage.read(key)
 if(!recover){
  validate(review)
  if(review.host!==host||review.definition.runner_id!==runner||review.definition.command_id!==command||review.definition.revision!==revision)throw Error('Review identity changed')
  if(record&&!equal(record.review,review))throw Error('Recover the original immutable command before another review')
  const candidate={request_id:review.scope_hash,state:'prepared',review:structuredClone(review)}
  record=record??await storage.reserve(key,candidate)
  if(!equal(record.review,candidate.review))throw Error('A different command review was reserved')
 }
 if(!record||!['prepared','accepted'].includes(record.state))throw Error('No original command review')
 validate(record.review)
 if(verificationReviewKey(record.review.host,record.review.definition.runner_id,record.review.definition.command_id,record.review.definition.revision)!==key||record.request_id!==record.review.scope_hash)throw Error('Wrong command recovery scope')
 if(record.state==='accepted')return verify(record,record.receipt)
 signal?.throwIfAborted()
 const receipt=verify(record,await request({action:'confirm',review:record.review},{signal}))
 await storage.save(key,{...record,state:'accepted',receipt})
 return receipt
}
export async function requestVerificationReview(body,{signal,fetcher=globalThis.fetch}={}){
 const response=await fetcher('/api/kode/verification/review',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})
 if(!response.ok)throw Error('Command registration unconfirmed; recover original review')
 return response.json()
}
