/** Owner-only UI API. This is NOT a public webhook endpoint and never submits agent instructions. */
import {ExternalCacheCapacityError} from './capacity.js'
export function registerExternalResources(ctx,{service,resolveService,status=()=>service?.status?.()??{state:'disabled',reason:'service_unavailable',dispatch:'disabled'}}){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/external-resources',handler:async(req,res)=>{
  const send=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
  const admission=ctx.connection.admit(req)
  if('rejection'in admission)return send(admission.rejection,{error:'Authentication required'})
  if(admission.peer.principal.kind!=='owner')return send(403,{error:'Owner required'})
  try{
   const currentService = resolveService ? resolveService() : service
   const q=new URL(req.url,'http://localhost').searchParams
   if(req.method==='GET'){
    const op=q.get('op')
    if([...q.keys()].length!==new Set(q.keys()).size)return send(400,{error:'Duplicate query'})
    if(op==='status'&&q.size===1)return send(200,status())
    if(!currentService)return send(503,{error:'External resources disabled',...status()})
    if(op==='cards'&&[...q.keys()].every(k=>['op','binding','after','limit'].includes(k))){
     const after=q.get('after')??'0',limit=q.get('limit')??'30'
     if(!/^\d+$/.test(after)||!/^\d+$/.test(limit))return send(400,{error:'Invalid page'})
     return send(200,await currentService.cards(q.get('binding'),{after:Number(after),limit:Number(limit)}))
    }
    if(op==='connections'&&[...q.keys()].every(k=>['op','home_hub','host_id','workspace_id','root_ref','surface_id'].includes(k)))return send(200,{items:await currentService.available(Object.fromEntries([...q].filter(([k])=>!['op','surface_id'].includes(k))),q.get('surface_id'))})
    if(op==='project'&&[...q.keys()].every(k=>['op','home_hub','host_id','workspace_id','root_ref','surface_id'].includes(k)))return send(200,await currentService.project(Object.fromEntries([...q].filter(([k])=>!['op','surface_id'].includes(k))),q.get('surface_id')))
    if(op==='bindings'&&[...q.keys()].every(k=>['op','home_hub','host_id','workspace_id','root_ref'].includes(k))){return send(200,{items:await currentService.list(Object.fromEntries([...q].filter(([k])=>k!=='op')))})}
    return send(400,{error:'Invalid read operation'})
   }
   if(req.method!=='POST')return send(405,{error:'GET or POST required'})
   if(!currentService)return send(503,{error:'External resources disabled',...status()})
   if(q.size)return send(400,{error:'Unexpected query'})
   if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
   const chunks=[];let size=0
   for await(const part of req){const chunk=Buffer.from(part);size+=chunk.length;if(size>16384)return send(413,{error:'Body too large'});chunks.push(chunk)}
   let input;try{input=JSON.parse(Buffer.concat(chunks))}catch{return send(400,{error:'Invalid JSON'})}
   if(!input||typeof input!=='object'||Array.isArray(input))return send(400,{error:'Object required'})
   const {op,...body}=input
   const keys=op==='bind'?['id','scope','surface_id','audience_revision','connection_id','source','enabled','expected_revision']:op==='sync'?['binding_id','expected_revision','request_id','kind','page','parent']:[]
   if(!keys.length||Object.keys(body).some(k=>!keys.includes(k)))return send(400,{error:'Unsupported operation'})
   return send(200,await currentService[op](body))
  }catch(error){
   if(error instanceof ExternalCacheCapacityError)return send(409,{error:error.message,code:error.code,resource:error.resource})
   return send(409,{error:'External resource operation not confirmed; check binding, permissions and retry identity'})
  }
 }})
}
