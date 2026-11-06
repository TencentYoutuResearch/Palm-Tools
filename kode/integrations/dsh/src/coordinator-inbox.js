/** Discover persisted human requests for already-owned Coordinator runtimes, without replay. */
import { isDeepStrictEqual } from 'node:util'
export class CoordinatorInbox {
 constructor(host,{intervalMs=2000}={}){
  if(!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000)throw Error('Invalid Coordinator inbox interval')
  this.host=host;this.intervalMs=intervalMs;this.stop=new AbortController();this.cursors=new Map();this.after=''
 }
 scan(){
  if(this.pending)return this.pending
  if(this.stop.signal.aborted||this.host.stop.signal.aborted)return Promise.reject(Error('Coordinator inbox closed'))
  const task=this.discover();this.pending=task
  task.finally(()=>{if(this.pending===task)this.pending=undefined}).catch(()=>{});return task
 }
 async discover(){
  const runtime=this.host.execution,signal=AbortSignal.any([this.stop.signal,this.host.stop.signal])
  const call=(p,b)=>runtime.client.call(`/api/v1/messaging/${p}`,b,signal)
  const owned=[...this.host.handles.keys()].sort()
  for(const id of this.cursors.keys())if(!this.host.handles.has(id))this.cursors.delete(id)
  let batch=owned.filter(id=>id>this.after).slice(0,32);if(!batch.length)batch=owned.slice(0,32)
  const results=[]
  for(const session of batch){
   signal.throwIfAborted();this.after=session
   const handle=this.host.handles.get(session),binding=runtime.profiles.binding(session),scope=binding?.managedCoordinator,op=binding?.managedOperation
   if(!scope||!op||binding.operationClosed||binding.managedBuilder||binding.managedAssignment||handle?.run.signal.aborted)continue
   try{
    const after=this.cursors.get(session)??0,path=`conversations/${encodeURIComponent(scope.conversation_id)}`
    const page=await call(`${path}/pending-inputs?after=${after}&limit=20`)
    const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
    if(page.conversation_id!==scope.conversation_id||page.team_id!==scope.team_id||page.home_hub!==runtime.host||!Array.isArray(page.items)||page.items.length>20
     ||page.items.some(r=>!id(r.message_id)||!Number.isSafeInteger(r.sequence)||r.sequence<=after)
     ||page.next_cursor!=null&&(!Number.isSafeInteger(page.next_cursor)||page.next_cursor<=after))throw Error('Invalid Coordinator pending input page')
    for(const row of page.items){
     signal.throwIfAborted()
     const current=runtime.profiles.binding(session)
     if(this.host.handles.get(session)!==handle||current?.operationClosed||!isDeepStrictEqual(current?.managedCoordinator,scope)||!isDeepStrictEqual(current?.managedOperation,op))throw Error('Coordinator inbox binding changed')
     try{
      const receipt=await call(`${path}/messages/${encodeURIComponent(row.message_id)}/coordinator-input`,{operation_id:op.id,attempt:op.attempt,epoch:op.epoch,control_revision:scope.control_revision})
      results.push({session,message_id:row.message_id,state:'queued',receipt})
     }catch(error){if(signal.aborted)throw error;results.push({session,message_id:row.message_id,state:'pending',error})}
    }
    this.cursors.set(session,page.next_cursor??0)
   }catch(error){if(signal.aborted)throw error;results.push({session,state:'pending',error})}
  }
  this.results=results;return results
 }
 start(){if(this.timer||this.stop.signal.aborted)return;const tick=()=>{void this.scan().catch(error=>{this.error=error})};this.timer=setInterval(tick,this.intervalMs);this.timer.unref?.();tick()}
 async close(){clearInterval(this.timer);this.stop.abort(Error('Coordinator inbox closed'));await this.pending?.catch(()=>{})}
}
