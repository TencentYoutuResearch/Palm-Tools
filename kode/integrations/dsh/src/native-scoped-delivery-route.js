/** Existing Host-owner transport for exact already-stored source references. */
export function registerNativeScopedDelivery(ctx,runtime){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/context-v2/deliver',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admission=ctx.connection.admit(req)
  if('rejection' in admission)return send(admission.rejection,{error:'Authentication required'})
  if(admission.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(req.method!=='POST')return send(405,{error:'POST required'})
  if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
  let bytes=0;const chunks=[]
  for await(const value of req){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);bytes+=chunk.length;if(bytes>4096)return send(413,{error:'Source reference too large'});chunks.push(chunk)}
  let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
  if(!input||Object.keys(input).sort().join(',')!=='entry_id,request_id,session_id'||!['entry_id','request_id','session_id'].every(k=>typeof input[k]==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(input[k])))return send(400,{error:'Exact stored source reference required'})
  try{return send(200,await runtime.deliver(input))}catch(error){
   const blocked=['native_scope_capability_unsupported','scope_session_not_registered'].includes(error.code)
   return send(409,{code:blocked?error.code:'NATIVE_SCOPE_OUTCOME_UNCONFIRMED',state:blocked?'not_ready':'requires_reconciliation',automatic_replay_allowed:false,execution_confirmed:false})
  }
 }})
}
