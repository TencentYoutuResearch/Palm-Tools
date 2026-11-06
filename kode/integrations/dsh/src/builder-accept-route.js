/** Owner acceptance saves a team draft; activation remains a separate explicit action. */
export function registerBuilderAccept(ctx,config){
  return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/accept-proposal',handler:async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
    const admitted=ctx.connection.admit(req)
    if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
    if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
    if(!['POST','GET'].includes(req.method))return send(405,{error:'GET or POST required'})
    if(!config?.backendClient)return send(503,{error:'Builder backend unavailable'})
    const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
    try{
      if(req.method==='GET'){
        const query=new URL(req.url,'http://localhost').searchParams,draft=query.get('draft_id'),request=query.get('request_id')
        if(!valid(draft)||!valid(request)||[...query.keys()].some(k=>!['draft_id','request_id'].includes(k)))return send(400,{error:'Acceptance identity required'})
        return send(200,await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draft)}/acceptances/${encodeURIComponent(request)}`))
      }
      if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
      let bytes=0;const chunks=[]
      for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>4096)return send(413,{error:'Acceptance request too large'});chunks.push(chunk)}
      let input
      try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
      if(!input||Object.keys(input).some(k=>!['draft_id','request_id','expected_revision','team_id','team_revision'].includes(k))
        ||!['draft_id','request_id','team_id'].every(k=>valid(input[k]))||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1
        ||!Number.isSafeInteger(input.team_revision)||input.team_revision<0)return send(400,{error:'Invalid acceptance request'})
      const {draft_id,...command}=input
      return send(200,await config.backendClient.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(draft_id)}/accept-proposal`,command))
    }catch{return send(409,{error:'Acceptance was not confirmed; read its receipt or retry the exact request',retry:'same_request'})}
  }})
}
