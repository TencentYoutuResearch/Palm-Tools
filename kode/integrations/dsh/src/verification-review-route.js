import { previewVerification,confirmVerification } from './verification-review.js'
/** Explicit owner API. Agent principals never reach filesystem preview or persistence. */
export function registerVerificationReview(ctx){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/verification/review',handler:async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
  const admission=ctx.connection.admit(req)
  if('rejection' in admission)return send(admission.rejection,{error:'Authentication required'})
  if(admission.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(req.method!=='POST')return send(405,{error:'POST required'})
  if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
  if(new URL(req.url,'http://localhost').search)return send(400,{error:'Query not supported'})
  const runtime=ctx.get?.('kodeAgents')?.officialExecution
  if(!runtime?.verificationRunners||runtime.closed)return send(503,{error:'Verification registry unavailable'})
  try{
   let bytes=0;const chunks=[]
   for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>131072)return send(413,{error:'Command review too large'});chunks.push(chunk)}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
   if(!input||typeof input!=='object'||Array.isArray(input))return send(400,{error:'Explicit review action required'})
   const field=input.action==='preview'?'definition':input.action==='confirm'?'review':null
   if(!field||Object.keys(input).sort().join(',')!==['action',field].sort().join(','))return send(400,{error:'Exact review action required'})
   await runtime.ready
   if(runtime.closed)return send(503,{error:'Verification registry unavailable'})
   return send(200,await (field==='definition'?previewVerification:confirmVerification)(runtime.verificationRunners,runtime.host,input[field]))
  }catch{return send(409,{error:'Command review not confirmed; recover the original immutable registration before changing the reviewed command',retry:'same_review'})}
 }})
}
