/** Redacted owner catalogue over the original native profiles/model discovery.
 * A catalogue is configuration evidence, not execution authority or a grant.
 */
import {profileRevision,profileRoute} from './agent-profiles.js'
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
export function createInteractiveTeamCatalog({service,home}){
 if(!service?.profiles||!service.adapter||!id(home))throw Error('Original native catalogue services required')
 const available=()=> (service.profiles.listAgents?.()??service.profiles.list()).filter(p=>p.type!=='dsh'&&service.hasRuntime(p.type))
 const view=p=>({id:p.id,type:p.type,profile_revision:profileRevision(p),provider_id:profileRoute(p.id)})
 return async function read(profileId,{cachedOnly=false}={}){
  if(profileId!==undefined&&!id(profileId))throw Error('Invalid native profile reference')
  await service.profiles.reload?.()
  const profiles=available(),selected=profileId===undefined?undefined:profiles.find(p=>p.id===profileId)
  if(profileId!==undefined&&!selected)throw Error('Original native profile unavailable')
  const result={home_hub:home,execution_mode:'interactive_native',eligible_for_execution:false,profiles:profiles.map(view)}
  if(!selected)return result
  const revision=profileRevision(selected)
  const rows=cachedOnly ? await service.adapter.peekModels?.(profileRoute(selected.id),selected) : await service.adapter.listModels(profileRoute(selected.id),selected)
  if(!Array.isArray(rows))throw Error('Original native model catalogue unavailable')
  await service.profiles.reload?.()
  const current=available().find(p=>p.id===selected.id)
  if(!current||profileRevision(current)!==revision)throw Error('Native profile changed during discovery')
  result.selected_profile=view(current)
  if(rows.some(m=>typeof m?.id!=='string'||!m.id))throw Error('Original native model catalogue is malformed')
  result.models=rows.map(m=>({id:m.id,...(typeof m.name==='string'?{name:m.name}:{}),...(Array.isArray(m.reasoningEfforts)?{reasoningEfforts:structuredClone(m.reasoningEfforts)}:{})}))
  return result
 }
}
export function registerInteractiveTeamCatalog(ctx,read){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/interactive-teams/catalog',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admission=ctx.connection.admit(req)
  if('rejection'in admission)return send(admission.rejection,{code:'AUTHENTICATION_REQUIRED'})
  if(admission.peer.principal.kind!=='owner')return send(403,{code:'HOST_OWNER_REQUIRED'})
  if(req.method!=='GET')return send(405,{code:'METHOD_NOT_ALLOWED'})
  const query=new URL(req.url,'http://localhost').searchParams
  if([...query.keys()].some(k=>k!=='profile_id')||query.getAll('profile_id').length>1||query.has('profile_id')&&!id(query.get('profile_id')))return send(400,{code:'INVALID_NATIVE_PROFILE'})
  try{return send(200,await read(query.has('profile_id')?query.get('profile_id'):undefined))}
  catch{return send(409,{code:'NATIVE_CATALOGUE_UNAVAILABLE',eligible_for_execution:false})}
 }})
}
