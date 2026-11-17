import {dispatchNewInteractiveMessage,validInteractiveSelection} from './interactive-team-dispatch.js'
/** Authenticated owner facade. The browser never receives the Hub owner credential. */
export function registerCollaboration(ctx,config){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/collaboration',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admitted=ctx.connection.admit(req)
  if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
  if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(!['GET','POST'].includes(req.method))return send(405,{error:'GET or POST required'})
  if(!config?.backendClient)return send(503,{error:'Collaboration backend unavailable'})
  const url=new URL(req.url,'http://localhost'),path=url.searchParams.get('path')
  const id='[A-Za-z0-9_.:-]{1,160}'
  const read=new RegExp(`^(surfaces|surfaces/${id}/(messages|threads|tasks)|tasks/${id}(/(events|context|execution))?)$`)
  const write=new RegExp(`^(surfaces/${id}(/messages)?|tasks|tasks/${id}/(commands|execution|execution/cancel|clarification-answers))$`)
  if(!(req.method==='GET'?read:write).test(path??''))return send(400,{error:'Unsupported collaboration operation'})
  const keys=path==='surfaces'?['home_hub','host_id','workspace_id','root_ref']:['after','limit','thread_id']
  const query=new URLSearchParams()
  for(const [key,value]of url.searchParams){if(key==='path')continue;if(!keys.includes(key)||req.method!=='GET'||query.has(key)||value.length>4096)return send(400,{error:'Invalid collaboration query'});query.set(key,value)}
  try{
   let input
   if(req.method==='POST'){
    if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
    let size=0;const chunks=[]
    for await(const part of req){const b=Buffer.from(part);size+=b.length;if(size>131072)return send(413,{error:'Body too large'});chunks.push(b)}
    try{input=JSON.parse(Buffer.concat(chunks).toString())}catch{return send(400,{error:'Invalid JSON'})}
    if(!input||typeof input!=='object'||Array.isArray(input))return send(400,{error:'Object required'})
   }
   if(input?.interactive_selection!==undefined&&(!/^surfaces\/[^/]+\/messages$/.test(path)||!validInteractiveSelection(input.interactive_selection)))return send(400,{error:'Invalid interactive selection'})
   const result=await config.backendClient.call('/api/v1/messaging/collaboration/'+path+(query.size?'?'+query:''),input)
   let interactiveRuntime
   try{interactiveRuntime=config.interactiveRuntime}catch{/* Stored source remains successful if its runtime scope was disposed. */}
   const output=req.method==='POST'&&/^surfaces\/[^/]+\/messages$/.test(path)?await dispatchNewInteractiveMessage({runtime:interactiveRuntime,input,message:result,surface_id:path.split('/')[1]}):result
   return send(200,output)
  }catch(error){if(error?.code==='task_mutation_requires_reauthorization')return send(409,{error:'这项任务已安排执行，暂不支持追加范围或暂停。可以先取消，再新建任务。',code:error.code,retry:'unsupported'});const status=[400,401,403,404,409,422,503].includes(error?.status)?error.status:409;return send(status,{error:status===404?'Collaboration backend requires update':'Operation not confirmed; retry the exact request after checking access',retry:'same_request'})}
 }})
}
