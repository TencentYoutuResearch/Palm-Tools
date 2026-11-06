/** Owner explicitly confirms internal pricing after Builder execution has reported. */
import { readBuilderCloseStatus } from './builder-close-status.js'
export function registerBuilderAccounting(ctx,config){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/accounting',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admitted=ctx.connection.admit(req)
  if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
  if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(req.method!=='POST')return send(405,{error:'POST required'})
  if(!config?.backendClient)return send(503,{error:'Builder backend unavailable'})
  if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
  const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
  let input
  try{
   const chunks=[];let bytes=0
   for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>8192)return send(413,{error:'Builder accounting command too large'});chunks.push(chunk)}
   try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
   const c=input?.command
   if(!input||!valid(input.operation_id)||Object.keys(input).some(k=>!['operation_id','command'].includes(k))||!c
    ||Object.keys(c).some(k=>!['request_id','attempt','epoch','expected_revision','price_id','settlement'].includes(k))
    ||!valid(c.request_id)||!valid(c.price_id)||!['attempt','epoch','expected_revision'].every(k=>Number.isSafeInteger(c[k])&&c[k]>0)
    ||c.settlement!=='internal_price')return send(400,{error:'Explicit internal-price confirmation required'})
   return send(200,await config.backendClient.call(`/api/v1/messaging/operations/${encodeURIComponent(input.operation_id)}/builder-accounting`,c))
  }catch(error){
   if(error?.status===400&&error.message==='kode backend (400): official usage remains unresolved'){
    try{
     const home=ctx.get?.('kodeAgents')?.officialLoops?.execution?.host
     const status=await readBuilderCloseStatus(config.backendClient,input.operation_id,home)
     if(status.operation?.attempt===input.command.attempt&&status.operation?.epoch===input.command.epoch
        &&status.accounting?.state==='waiting_accounting'&&status.accounting.reason==='needs_reconciliation'){
      const held=status.accounting.budget?.frozen===true
      return send(409,{state:'waiting_accounting',reason:'needs_reconciliation',retryable:false,
       message:held?'A metered call has no verifiable usage; this reservation remains held until reconciliation.':'A metered call has no verifiable usage; no settlement was performed.',accounting:status.accounting})
     }
    }catch{}
   }
   return send(409,{error:'Builder accounting was not confirmed; retry the exact command',retry:'same_request'})
  }
 }})
}
