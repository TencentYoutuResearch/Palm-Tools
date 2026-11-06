/** Owner-only command registration. References are public metadata; definitions never execute here. */
export function registerVerificationDefinition(ctx){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/verification/definitions',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admitted=ctx.connection.admit(req)
  if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
  if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(!['GET','POST'].includes(req.method))return send(405,{error:'GET or POST required'})
  const runtime=ctx.get?.('kodeAgents')?.officialExecution,runners=runtime?.verificationRunners
  if(!runners||runtime.closed)return send(503,{error:'Verification registry unavailable'})
  try{
   await runtime.ready
   if(req.method==='GET'){
    const q=new URL(req.url,'http://localhost').searchParams,keys=['runner_id','command_id','revision']
    if([...q.keys()].length!==3||keys.some(k=>!q.get(k))||[...q.keys()].some(k=>!keys.includes(k)))return send(400,{error:'Exact command identity required'})
    return send(200,{host:runtime.host,reference:runners.reference(...keys.map(k=>q.get(k))),execution_performed:false})
   }
   if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
   let bytes=0;const chunks=[]
   for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>2*1048576)return send(413,{error:'Definition too large'});chunks.push(chunk)}
   let input
   try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
   if(!input||Object.keys(input).length!==1||!input.definition)return send(400,{error:'Explicit verification definition required'})
   const reference=await runners.registerPersistent(input.definition)
   return send(200,{host:runtime.host,reference,execution_performed:false})
  }catch{return send(409,{error:'Definition not confirmed; retry the exact immutable command identity'})}
 }})
}
