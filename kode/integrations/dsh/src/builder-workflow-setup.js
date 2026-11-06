/** Owner-confirmed immutable configuration setup. Partial progress never activates anything. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BackendDocument } from './backend-state.js'
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
const keys=(v,allowed)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>allowed.includes(k))
const ref=row=>({id:row.id,version:row.version,hash:row.hash})
export async function setupBuilderWorkflow(client,input){
 if(!keys(input,['draft_id','expected_revision','request_id','workflow','project','delivery'])||!id(input.draft_id)||!id(input.request_id)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1
   ||!keys(input.workflow,['id','version','inputs','stages','completion_stages','evidence_rules'])||!id(input.workflow.id)||!id(input.workflow.version)
   ||!keys(input.project,['id','version','spec'])||!id(input.project.id)||!id(input.project.version)||input.project.spec?.kind!=='project_bindings'
   ||!keys(input.delivery,['id','version','targets','required_outputs','human_acceptance'])||!id(input.delivery.id)||!id(input.delivery.version)
   ||('human_acceptance' in input.delivery && typeof input.delivery.human_acceptance !== 'boolean')
   ||Buffer.byteLength(JSON.stringify(input))>131072)throw Error('Invalid Builder workflow setup')
 input=structuredClone(input)
 const call=(p,b)=>client.call(`/api/v1/messaging/${p}`,b)
 const key=`builder-workflow-${createHash('sha256').update(JSON.stringify([input.draft_id,input.request_id])).digest('hex')}`
 const document=new BackendDocument(client,key)
 let intent=await document.read()
 if(intent){
  if(!isDeepStrictEqual(intent.request,input))throw Error('Builder workflow setup identity conflict')
  if(intent.result)return intent.result
 }
 const validateDraft=(draft,recovery)=>{
  if(draft.status!=='draft'||(recovery?draft.revision<input.expected_revision:draft.revision!==input.expected_revision))throw Error('Builder draft unavailable or revision conflict')
  const workspaces=draft.interview.workspace_refs,project=input.project.spec
  if(!keys(project,['kind','repositories','environments','commands','connections'])||!project.repositories||Array.isArray(project.repositories)
    ||!Object.values(project.repositories).length||Object.values(project.repositories).some(r=>!workspaces.some(w=>isDeepStrictEqual(w,r.workspace)))
    ||Object.values(project.environments??{}).some(e=>!workspaces.some(w=>w.host_id===e.host_id)))throw Error('Builder workflow project outside selected workspaces')
 }
 const draft=await call(`superagents/drafts/${encodeURIComponent(input.draft_id)}`)
 // A durable owner intent freezes the reviewed package. Later interview edits do
 // not cancel that intent, but removal of its selected scope still blocks recovery.
 validateDraft(draft,Boolean(intent))
 // Persist the exact reviewed input before any immutable registrations. Do not retry a write
 // on uncertainty here: a caller retries the same request, reading its durable intent first.
 if(!intent){intent={request:input,draft_revision:draft.revision,state:'registering',activation_performed:false};await document.write(intent)}
 const workflow=await call('workflows',input.workflow)
 const configuredProject=await call('project-configs',input.project)
 const delivery=await call('project-configs',{id:input.delivery.id,version:input.delivery.version,spec:{kind:'delivery_policy',workflow:ref(workflow),project:ref(configuredProject),targets:input.delivery.targets,required_outputs:input.delivery.required_outputs,...(input.delivery.human_acceptance === true ? {human_acceptance:true} : {})}})
 const current=await call(`superagents/drafts/${encodeURIComponent(input.draft_id)}`)
 validateDraft(current,true)
 const result={draft_id:input.draft_id,draft_revision:input.expected_revision,request_id:input.request_id,
  workflow:ref(workflow),project:ref(configuredProject),delivery_policy:ref(delivery),state:'registered',activation_performed:false,eligible_for_execution:false}
 // Another identical caller may finish first. Immutable Hub saves are idempotent;
 // receipt publication uses document CAS and never overwrites a different request.
 const latest=await document.read()
 if(!isDeepStrictEqual(latest?.request,input))throw Error('Builder workflow setup identity conflict')
 if(latest.result)return latest.result
 await document.write({...latest,state:'registered',result})
 return result
}
export async function setupSavedBuilderWorkflow(client,input){
 if(!keys(input,['draft_id','expected_revision','request_id'])||!id(input.draft_id)||!id(input.request_id)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1)throw Error('Invalid saved workflow confirmation')
 const key=`builder-workflow-${createHash('sha256').update(JSON.stringify([input.draft_id,input.request_id])).digest('hex')}`
 const prior=await new BackendDocument(client,key).read()
 if(prior){
  if(['draft_id','expected_revision','request_id'].some(k=>prior.request?.[k]!==input[k]))throw Error('Builder workflow setup identity conflict')
  return setupBuilderWorkflow(client,prior.request)
 }
 const draft=await client.call(`/api/v1/messaging/superagents/drafts/${encodeURIComponent(input.draft_id)}`)
 if(draft.status!=='draft'||draft.revision!==input.expected_revision||!draft.interview.proposed_workflow)throw Error('Saved Builder workflow proposal unavailable')
 return setupBuilderWorkflow(client,{...input,...draft.interview.proposed_workflow})
}
export function registerBuilderWorkflowSetup(ctx,config){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/configure-workflow',handler:async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
  const admitted=ctx.connection.admit(req)
  if('rejection'in admitted)return send(admitted.rejection,{error:'authentication required'})
  if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(req.method!=='POST')return send(405,{error:'POST required'})
  if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
  if(!config?.backendClient)return send(503,{error:'Builder backend unavailable'})
  try{
   let bytes=0;const chunks=[]
   for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>131072)return send(413,{error:'Configuration too large'});chunks.push(chunk)}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
   return send(200,await (input&&Object.keys(input).every(k=>['draft_id','expected_revision','request_id'].includes(k))?setupSavedBuilderWorkflow:setupBuilderWorkflow)(config.backendClient,input))
  }catch{return send(409,{error:'Configuration registration was not confirmed; immutable versions may already exist. Retry the exact request.',retry:'same_request'})}
 }})
}
