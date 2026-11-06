/** Owner-confirmed policy and grant bundle. The Hub commits the exact reviewed scope atomically. */
export function registerTeamAuthority(ctx,config){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/teams/authority',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admitted=ctx.connection.admit(req)
  if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
  if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(!['GET','POST'].includes(req.method))return send(405,{error:'GET or POST required'})
  if(!config?.backendClient)return send(503,{error:'Team backend unavailable'})
  const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
  try{
   if(req.method==='GET'){
    const q=new URL(req.url,'http://localhost').searchParams,team=q.get('team_id'),request=q.get('request_id')
    if(!valid(team)||!valid(request)||[...q.keys()].some(k=>!['team_id','request_id'].includes(k))||[...q.keys()].length!==2)return send(400,{error:'Exact team authority receipt identity required'})
    return send(200,await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(team)}/authority-requests/${encodeURIComponent(request)}`))
   }
   if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
   const chunks=[];let bytes=0
   for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>131072)return send(413,{error:'Team authority command too large'});chunks.push(chunk)}
   let input
   try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
   const command=input?.command
   if(!input||!valid(input.team_id)||Object.keys(input).some(k=>!['team_id','command'].includes(k))||!command||Object.keys(command).some(k=>!['request_id','team_revision','budget_policy','scheduling_policy','grant'].includes(k))
    ||!valid(command.request_id)||!Number.isSafeInteger(command.team_revision)||command.team_revision<1||command.budget_policy?.team_id!==input.team_id||command.scheduling_policy?.team_id!==input.team_id||command.grant?.policy?.team_id!==input.team_id)return send(400,{error:'Explicit team authority confirmation required'})
   return send(200,await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(input.team_id)}/authority`,command))
  }catch{return send(409,{error:'Team authority change was not confirmed; read its receipt or retry the exact command',retry:'same_request'})}
 }})
}
