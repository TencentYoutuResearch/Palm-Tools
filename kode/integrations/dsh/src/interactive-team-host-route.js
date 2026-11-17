/** Owner-side entry points for explicitly selected interactive-native Teams.
 * These routes do not activate controlled operations or create credentials.
 * The runtime must resolve every reference through the authoritative backend.
 */
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value)
const positive = value => Number.isSafeInteger(value) && value > 0
const exact = (value, fields) => value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
const openFields = ['request_id','team_id','team_revision','surface_id','thread_id','audience_revision','participant_id','target_id','workspace_id','context_epoch']
function validOpen(value) {
  return (exact(value, openFields) || (exact(value, [...openFields,'first_source_message_id']) && token(value.first_source_message_id))) && openFields.every(key => ['team_revision','audience_revision','context_epoch'].includes(key) ? positive(value[key]) : token(value[key]))
}
function validDelivery(value) {
  return exact(value, ['binding_id','source_message_id','request_id']) && Object.values(value).every(token)
}
export function registerInteractiveTeamRoutes(ctx, runtime) {
  if (!runtime || ['open','inspect','deliver'].some(key => typeof runtime[key] !== 'function')) throw Error('Interactive Team runtime required')
  const routes = [
    { path:'/api/kode/interactive-teams/open', method:'POST', validate:validOpen, run:input=>runtime.open(input) },
    { path:'/api/kode/interactive-teams/reconcile-interrupted', method:'POST', validate:validDelivery, run:input=>runtime.reconcileInterrupted(input) },
    { path:'/api/kode/interactive-teams/recover', method:'POST', validate:validDelivery, run:input=>runtime.recover(input) },
    { path:'/api/kode/interactive-teams/deliver', method:'POST', validate:validDelivery, run:input=>runtime.deliver(input) },
    { path:'/api/kode/interactive-teams/source-status', method:'GET', validate:input=>exact(input,['source_message_id'])&&token(input.source_message_id), run:input=>runtime.inspectSource(input.source_message_id) },
    { path:'/api/kode/interactive-teams/status', method:'GET', validate:input=>exact(input,['binding_id'])&&token(input.binding_id), run:input=>runtime.inspect(input.binding_id) },
  ]
  const disposers = routes.map(route => ctx.webServer.register({kind:'exact',path:route.path,handler:async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
    const admission=ctx.connection.admit(req)
    if ('rejection' in admission) return send(admission.rejection,{code:'AUTHENTICATION_REQUIRED'})
    if (admission.peer.principal.kind !== 'owner') return send(403,{code:'HOST_OWNER_REQUIRED'})
    if (req.method !== route.method) return send(405,{code:'METHOD_NOT_ALLOWED'})
    let input
    if (req.method === 'GET') {
      const query=new URL(req.url,'http://localhost').searchParams
      const key=route.path.endsWith('/source-status')?'source_message_id':'binding_id'
      if ([...query.keys()].length!==1 || !query.has(key)) return send(400,{code:'INVALID_INTERACTIVE_REFERENCE'})
      input={[key]:query.get(key)}
    } else {
      if (!(req.headers['content-type']??'').startsWith('application/json')) return send(415,{code:'JSON_REQUIRED'})
      let bytes=0;const chunks=[]
      try {
        for await (const part of req) {const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>16384)return send(413,{code:'INTERACTIVE_REFERENCE_TOO_LARGE'});chunks.push(chunk)}
        input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {return send(400,{code:'INVALID_INTERACTIVE_REFERENCE'})}
    }
    if (!route.validate(input)) return send(400,{code:'INVALID_INTERACTIVE_REFERENCE'})
    try {return send(200,await route.run(structuredClone(input)))}
    catch(error) {const phase=['source_lookup','recovery_lookup','binding_validation','native_storage_probe','recovery_proof','catalog','native_create','native_verify'].includes(error?.interactive_phase)?error.interactive_phase:'unknown';return send(409,{diagnostic:{phase,code:'INTERACTIVE_PHASE_UNCONFIRMED'},code:'INTERACTIVE_OUTCOME_UNCONFIRMED',execution_mode:'interactive_native',state:'requires_inspection',automatic_replay_allowed:false,usage:{state:'unknown'}})}
  }}))
  return ()=>{for(const dispose of disposers.reverse())dispose?.()}
}
