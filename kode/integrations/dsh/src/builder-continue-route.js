/** Explicit owner confirmation; Hub atomically saves answers and enqueues continuation. */
export function registerBuilderContinue(ctx, config) {
  return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/continue',handler:async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
    const admitted=ctx.connection.admit(req)
    if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
    if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
    if(req.method!=='POST')return send(405,{error:'POST required'})
    if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
    if(!config?.backendClient)return send(503,{error:'Builder backend unavailable'})
    try {
      let bytes=0;const chunks=[]
      for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>131072)return send(413,{error:'Builder confirmation too large'});chunks.push(chunk)}
      let input
      try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
      const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
      if(!input||Object.keys(input).some(k=>!['operation_id','draft_id','attempt','epoch','answer'].includes(k))
          ||!valid(input.operation_id)||!valid(input.draft_id)
          ||!['attempt','epoch'].every(k=>Number.isSafeInteger(input[k])&&input[k]>0)
          ||!input.answer||typeof input.answer!=='object'||Array.isArray(input.answer)
          ||Object.keys(input.answer).some(k=>!['request_id','expected_revision','answers','clear_answers'].includes(k)))return send(400,{error:'Invalid Builder confirmation'})
      const {operation_id,...command}=input
      return send(200,await config.backendClient.call(`/api/v1/messaging/operations/${encodeURIComponent(operation_id)}/builder-continue`,command))
    }catch{return send(409,{error:'Builder confirmation was not confirmed; retry the exact request',retry:'same_request'})}
  }})
}
