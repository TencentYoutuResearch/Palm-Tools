/** Owner input and receipt bridge; does not create/resume sessions or infer authorization. */
export function registerBuilderInput(ctx,config){
  return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/input',handler:async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
    const admitted=ctx.connection.admit(req)
    if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
    if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
    if(!['GET','POST'].includes(req.method))return send(405,{error:'GET or POST required'})
    if(!config?.backendClient)return send(503,{error:'Builder backend unavailable'})
    const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
    try{
      if(req.method==='GET'){
        const query=new URL(req.url,'http://localhost').searchParams
        const operation=query.get('operation_id'),request=query.get('request_id')
        if(!valid(operation)||!valid(request)||[...query.keys()].some(k=>!['operation_id','request_id'].includes(k)))return send(400,{error:'Builder input identity required'})
        const record=await config.backendClient.call(`/api/v1/messaging/operations/${encodeURIComponent(operation)}/builder-inputs/${encodeURIComponent(request)}`)
        const delivery=record.input?await config.backendClient.call(`/api/v1/messaging/messages/${encodeURIComponent(record.input.receipt.message_id)}/delivery`):null
        return send(200,{...record,delivery:delivery?.delivery??null})
      }
      if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
      let bytes=0;const chunks=[]
      for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>131072)return send(413,{error:'Builder input too large'});chunks.push(chunk)}
      let input
      try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
      if(!input||Object.keys(input).some(k=>!['operation_id','request_id','draft_id','attempt','epoch','content'].includes(k))
          ||!['operation_id','request_id','draft_id'].every(k=>valid(input[k]))
          ||!['attempt','epoch'].every(k=>Number.isSafeInteger(input[k])&&input[k]>0)
          ||typeof input.content!=='string'||!input.content.trim()||Buffer.byteLength(input.content)>16384||input.content.includes('\0'))return send(400,{error:'Invalid Builder input'})
      const {operation_id,...command}=input
      return send(200,await config.backendClient.call(`/api/v1/messaging/operations/${encodeURIComponent(operation_id)}/builder-inputs`,command))
    }catch{return send(409,{error:'Builder input was not confirmed; read its receipt or retry the exact request',retry:'same_request'})}
  }})
}
