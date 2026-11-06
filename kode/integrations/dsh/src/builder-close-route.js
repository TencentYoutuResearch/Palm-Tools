import { readBuilderCloseStatus } from './builder-close-status.js'
/** Owner lifecycle entry; model tools never obtain close or settlement authority. */
export function registerBuilderClose(ctx){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/close',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admitted=ctx.connection.admit(req)
  if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
  if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  const host=ctx.get('kodeAgents')?.officialLoops
  if(!host)return send(503,{error:'Builder runtime unavailable'})
  if(req.method==='GET'){
   try{
    const query=new URL(req.url,'http://localhost').searchParams
    if([...query.keys()].some(key=>key!=='operation_id'))return send(400,{error:'Invalid Builder close query'})
    const operationId=query.get('operation_id')
    if(!operationId)return send(400,{error:'Builder operation required'})
    const status=await readBuilderCloseStatus(host.execution.client,operationId,host.execution.host)
    return send(200,status)
   }catch{return send(404,{error:'Builder close status unavailable in this Home scope'})}
  }
  if(req.method!=='POST')return send(405,{error:'GET or POST required'})
  if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
  try{
   let bytes=0;const chunks=[]
   for await(const part of req){const b=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=b.length;if(bytes>8192)return send(413,{error:'Builder close command too large'});chunks.push(b)}
   const result=await host.closeBuilder(JSON.parse(Buffer.concat(chunks).toString('utf8')))
   return send(result.state==='closed'?200:202,result)
  }catch{return send(409,{error:'Builder close was not confirmed; retry the exact command to recover progress',retry:'same_request'})}
 }})
}
