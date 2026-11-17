/** Owner-only read status. No root, credential, content, model or write arguments. */
import {readNativeScopedStatus} from './native-scoped-status.js'
export function registerNativeScopedStatus(ctx,{backendClient}){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/context-v2/status',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admission=ctx.connection.admit(req)
  if('rejection' in admission)return send(admission.rejection,{error:'Authentication required'})
  if(admission.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(req.method!=='GET')return send(405,{error:'GET required'})
  const query=new URL(req.url,'http://localhost').searchParams,input={}
  for(const [key,value] of query){if(!['surface_id','thread_id','source_message_id'].includes(key)||Object.hasOwn(input,key)||!/^[A-Za-z0-9_.:-]{1,160}$/.test(value))return send(400,{error:'Exact source identity required'});input[key]=value}
  if(Object.keys(input).length!==3)return send(400,{error:'Exact source identity required'})
  if(typeof backendClient?.call!=='function')return send(503,{error:'Status backend unavailable'})
  try{return send(200,await readNativeScopedStatus(backendClient,input))}catch(error){
   if([401,403].includes(error.status))return send(error.status,{error:'Source access denied'})
   return send(502,{state:'not_verified',code:'SCOPED_STATUS_UNVERIFIED',automatic_replay_allowed:false,execution_confirmed:false})
  }
 }})
}
