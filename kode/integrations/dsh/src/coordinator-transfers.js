/** Discover predecessor work only for a live owned Coordinator. Hub commits custody atomically. */
import { isDeepStrictEqual } from 'node:util'
export class CoordinatorTransfers {
 constructor(host,{intervalMs=2000}={}){
  if(!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000)throw Error('Invalid Coordinator transfer interval')
  this.host=host;this.intervalMs=intervalMs;this.stop=new AbortController();this.after='';this.cursors=new Map()
 }
 scan(){
  if(this.pending)return this.pending
  if(this.stop.signal.aborted||this.host.stop.signal.aborted)return Promise.reject(Error('Coordinator transfers closed'))
  const task=this.discover();this.pending=task
  task.finally(()=>{if(this.pending===task)this.pending=undefined}).catch(()=>{});return task
 }
 async discover(){
  const runtime=this.host.execution,signal=AbortSignal.any([this.stop.signal,this.host.stop.signal])
  const call=(p,b)=>runtime.client.call(`/api/v1/messaging/${p}`,b,signal)
  const ids=[...this.host.handles.keys()].sort(),results=[]
  for(const id of this.cursors.keys())if(!this.host.handles.has(id))this.cursors.delete(id)
  let batch=ids.filter(id=>id>this.after).slice(0,32);if(!batch.length)batch=ids.slice(0,32)
  for(const session of batch){
   signal.throwIfAborted();this.after=session
   const owned=this.host.handles.get(session),binding=runtime.profiles.binding(session),scope=binding?.managedCoordinator,operation=binding?.managedOperation
   if(!scope||!operation||scope.control_revision<2||binding.operationClosed||binding.managedBuilder||binding.managedAssignment||owned.run.signal.aborted)continue
   try{
    const after=this.cursors.get(session)??'',path=`teams/${encodeURIComponent(scope.team_id)}/coordinator-transfers/pending`
    const page=await call(`${path}${after?`?after=${encodeURIComponent(after)}`:''}`)
    const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
    if(page.home_hub!==runtime.host||page.team_id!==scope.team_id||page.control_revision!==scope.control_revision
     ||!Array.isArray(page.items)||page.items.length>32||page.items.some(r=>!id(r.run_id)||r.run_id<=after||!Number.isSafeInteger(r.revision)||r.revision<1)
     ||page.next_cursor!=null&&(!id(page.next_cursor)||page.next_cursor<=after))throw Error('Invalid Coordinator transfer page')
    for(const row of page.items){
     signal.throwIfAborted()
     const current=runtime.profiles.binding(session)
     if(this.host.handles.get(session)!==owned||owned.run.signal.aborted||current?.operationClosed
      ||!isDeepStrictEqual(current?.managedCoordinator,scope)||!isDeepStrictEqual(current?.managedOperation,operation))throw Error('Coordinator transfer owner changed')
     try{
      const receipt=await call(`work-runs/${encodeURIComponent(row.run_id)}/coordinator-transfer`,{request_id:`handover-${scope.control_revision}-${row.revision}`,expected_revision:row.revision,control_revision:scope.control_revision})
      results.push({run_id:row.run_id,state:'transferred',receipt})
     }catch(error){if(signal.aborted)throw error;results.push({run_id:row.run_id,state:'pending',error})}
    }
    this.cursors.set(session,page.next_cursor??'')
   }catch(error){if(signal.aborted)throw error;results.push({session,state:'pending',error})}
  }
  this.results=results;return results
 }
 start(){if(this.timer||this.stop.signal.aborted)return;const tick=()=>{void this.scan().catch(error=>{this.error=error})};this.timer=setInterval(tick,this.intervalMs);this.timer.unref?.();tick()}
 async close(){clearInterval(this.timer);this.stop.abort(Error('Coordinator transfers closed'));await this.pending?.catch(()=>{})}
}
