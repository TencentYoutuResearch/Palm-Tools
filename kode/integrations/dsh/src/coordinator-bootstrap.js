/** Wake configured dormant teams only for durable human requests; never resume unknown runtimes. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
export function coordinatorBootstrapInput(home,active) {
 const team=active.snapshot.team,config=team.spec.coordinator_startup
 const key=createHash('sha256').update(JSON.stringify([home,team.id,active.revision])).digest('hex')
 return {team_id:team.id,command_id:`create-${key}`,request_id:`bootstrap-${key}`,owner_session:`owner-${key}`,
  session_id:`coordinator-${key}`,workspace_id:config.workspace_id,task_tag:config.task_tag,expected_control_revision:0}
}
export function coordinatorRecoveryInput(home,active,control){
 const input=coordinatorBootstrapInput(home,active)
 const key=createHash('sha256').update(JSON.stringify([home,input.team_id,active.revision,control.revision])).digest('hex')
 return {...input,request_id:`recover-${key}`,command_id:`resume-${key}`,session_id:control.worker.session_id,
  target_id:control.request.target_id,expected_control_revision:control.revision}
}
export class CoordinatorBootstrap {
 constructor(host,{intervalMs=2000}={}) {
  if(!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000)throw Error('Invalid Coordinator bootstrap interval')
  this.host=host;this.intervalMs=intervalMs;this.stop=new AbortController();this.after=''
 }
 get running(){return Boolean(this.timer)&&!this.stop.signal.aborted&&!this.host.stop.signal.aborted}
 scan(){
  if(this.pending)return this.pending
  if(this.stop.signal.aborted||this.host.stop.signal.aborted)return Promise.reject(Error('Coordinator bootstrap closed'))
  const task=this.discover();this.pending=task
  task.finally(()=>{if(this.pending===task)this.pending=undefined}).catch(()=>{});return task
 }
 async discover(){
  const runtime=this.host.execution,signal=AbortSignal.any([this.stop.signal,this.host.stop.signal])
  const call=p=>runtime.client.call(`/api/v1/messaging/${p}`,undefined,signal)
  const page=await call(`teams?after=${encodeURIComponent(this.after)}&limit=20`)
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
  if(page.home_hub!==runtime.host||!Array.isArray(page.items)||page.items.length>20
   ||page.items.some(t=>!id(t.id)||t.id<=this.after)
   ||page.next_cursor!=null&&(!id(page.next_cursor)||page.next_cursor<=this.after))throw Error('Invalid Coordinator bootstrap team page')
  const results=[]
  for(const team of page.items){
   signal.throwIfAborted()
   try{
    let active
    try { active=await call(`teams/${team.id}/activation`) }
    catch(error) { if(error.status===404)continue; throw error }
    const saved=active?.snapshot?.team,config=saved?.spec?.coordinator_startup
    if(!active?.active||active.authority_valid!==true||saved?.home_hub!==runtime.host||saved.id!==team.id||!config)continue
    let input=coordinatorBootstrapInput(runtime.host,active)
    const {control}=await call(`teams/${team.id}/coordinator-control`)
    if(control){
     const owned=this.host.handles.get(control.worker?.session_id)
     if(owned&&!owned.run.signal.aborted)continue
     const recovery=(await call(`teams/${team.id}/coordinator-recovery`)).recovery
     const binding=runtime.profiles.binding?.(control.worker?.session_id)
     const priorMatches=binding?.managedCoordinator?.team_id===team.id&&binding.managedCoordinator.conversation_id===saved.conversation_id
      &&binding.managedCoordinator.control_revision===control.revision
      &&isDeepStrictEqual(binding.managedOperation,{id:control.request.operation_id,attempt:control.request.attempt,epoch:control.request.epoch})
     if(recovery?.replacement_prerequisites_satisfied===true&&priorMatches&&control.request.activation_revision===active.revision
      &&control.request.team_revision===active.team_revision&&control.worker.node_id===runtime.host){
      if(!(recovery.pending_work_count>0)){
       const pending=await call(`conversations/${encodeURIComponent(saved.conversation_id)}/pending-inputs?after=0&limit=1`)
       if(pending.team_id!==team.id||pending.home_hub!==runtime.host||pending.conversation_id!==saved.conversation_id||!Array.isArray(pending.items)||pending.items.length>1)throw Error('Invalid Coordinator recovery input page')
       if(!pending.items.length)continue
      }
      input=coordinatorRecoveryInput(runtime.host,active,control)
     }else{
      // Recover a persisted initial/replacement intent after a lost commit reply,
      // but never invent a new operation for unknown or unreconciled execution.
      const key=JSON.stringify([runtime.host,team.id,control.request?.request_id])
      const plan=runtime.profiles.coordinatorStartPlans[key]
      if(!plan?.input||plan.input.team_id!==team.id||plan.input.session_id!==control.worker?.session_id){results.push({team_id:team.id,state:'recovery_required',recovery});continue}
      input=plan.input
     }
    }else{
     const pending=await call(`conversations/${encodeURIComponent(saved.conversation_id)}/pending-inputs?after=0&limit=1`)
     if(pending.team_id!==team.id||pending.home_hub!==runtime.host||pending.conversation_id!==saved.conversation_id||!Array.isArray(pending.items)||pending.items.length>1)throw Error('Invalid Coordinator bootstrap input page')
     if(!pending.items.length)continue
    }
    const receipt=await this.host.startPlannedCoordinator(input)
    const owned=this.host.handles.get(input.session_id)
    const running=owned&&!owned.run.signal.aborted
    results.push({team_id:team.id,state:running?'started':'recovery_required',receipt,...(running?{}:{recovery:(await call(`teams/${team.id}/coordinator-recovery`)).recovery})})
   }catch(error){if(signal.aborted)throw error;results.push({team_id:team.id,state:'pending',error})}
  }
  this.after=page.next_cursor??'';this.results=results;return results
 }
 start(){if(this.timer||this.stop.signal.aborted)return;const tick=()=>{void this.scan().catch(error=>{this.error=error})};this.timer=setInterval(tick,this.intervalMs);this.timer.unref?.();tick()}
 async close(){clearInterval(this.timer);this.stop.abort(Error('Coordinator bootstrap closed'));await this.pending?.catch(()=>{})}
}
