import { isDeepStrictEqual } from 'node:util'
import { inspectTeamRuntimeReadiness } from './team-runtime-readiness.js'
/** Owner review and explicit activation share existing Hub authority; never called by Builder tools. */
export function registerTeamActivation(ctx,config){
  const register=(path,review)=>ctx.webServer.register({kind:'exact',path,handler:async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
    const admitted=ctx.connection.admit(req)
    if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
    if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
    if(req.method!=='POST'&&(review||req.method!=='GET'))return send(405,{error:review?'POST required':'GET or POST required'})
    if(!config?.backendClient)return send(503,{error:'Team backend unavailable'})
    const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
    try{
      if(req.method==='GET'){
        const query=new URL(req.url,'http://localhost').searchParams,id=query.get('team_id')
        if(!valid(id)||[...query.keys()].some(k=>k!=='team_id'))return send(400,{error:'Team identity required'})
        return send(200,await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(id)}/activation`))
      }
      if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
      let bytes=0;const chunks=[]
      for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>8192)return send(413,{error:'Team command too large'});chunks.push(chunk)}
      let input
      try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
      if(!input||!valid(input.team_id)||Object.keys(input).some(k=>!(review?['team_id','team_revision','request_id']:['team_id','command']).includes(k)))return send(400,{error:'Invalid team command'})
      const {team_id,...body}=input
      if(review){if(!valid(body.request_id)||!Number.isSafeInteger(body.team_revision)||body.team_revision<1)return send(400,{error:'Invalid review identity'})}
      else if(!body.command||!['activate','deactivate'].includes(body.command.action)||!valid(body.command.request_id)||!Number.isSafeInteger(body.command.expected_revision)||body.command.expected_revision<0)return send(400,{error:'Explicit activation command required'})
      if(!review&&Object.keys(body.command).some(k=>!(body.command.action==='activate'?['action','request_id','expected_revision','team_revision','grant_revision','budget_policy','scheduling_policy']:['action','request_id','expected_revision']).includes(k)))return send(400,{error:'Unexpected activation fields'})
      if(!review&&body.command.action==='activate'){
        // Historical receipts precede live checks: an exact retry is not a new activation.
        const replay=async()=>{
          const {receipt}=await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(team_id)}/activation-receipts/${encodeURIComponent(body.command.request_id)}`)
          if(!receipt)return false
          if(!isDeepStrictEqual(receipt.request,body.command))send(409,{error:'Activation request identity conflict'})
          else send(200,receipt.result)
          return true
        }
        if(await replay())return
        let checked
        try{
          checked=await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(team_id)}/activation-review`,{team_revision:body.command.team_revision,request_id:body.command.request_id})
        }catch(error){
          // A concurrent identical command may have committed during review.
          if(await replay())return
          throw error
        }
        if(!isDeepStrictEqual(checked.prepared_command,body.command)){
          if(await replay())return
          return send(409,{error:'Reviewed activation versions changed; review the new configuration'})
        }
        const readiness=await inspectTeamRuntimeReadiness(ctx.get?.('kodeAgents')?.officialExecution,checked)
        if(!readiness.default_adapter_checks_complete)return send(409,{error:'Required Host execution adapters are not ready',runtime_readiness:readiness})
      }
      const result=await config.backendClient.call(`/api/v1/messaging/teams/${encodeURIComponent(team_id)}/${review?'activation-review':'activation'}`,review?body:body.command)
      if(review)result.runtime_readiness=await inspectTeamRuntimeReadiness(ctx.get?.('kodeAgents')?.officialExecution,result)
      return send(200,result)
    }catch{return send(409,{error:review?'Team review unavailable; refresh its configuration':'Team action was not confirmed; retry the exact command without refreshing its reviewed versions',...(review?{}:{retry:'same_request'})})}
  }})
  const disposers=[]
  try{disposers.push(register('/api/kode/teams/activation-review',true));disposers.push(register('/api/kode/teams/activation',false))}
  catch(error){for(const dispose of disposers.reverse())dispose?.();throw error}
  return()=>{for(const dispose of disposers.reverse())dispose?.()}
}
