/** Discover durable terminal and blocked runs after downtime. Queue once; inbox tracker owns consumption. */
export class CoordinatorUpdates {
 constructor(runtime,{intervalMs=2000}={}){if(!Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000)throw Error('Invalid Coordinator update interval');this.runtime=runtime;this.intervalMs=intervalMs;this.stop=new AbortController();this.after=undefined}
 scan(){
  if(this.pending)return this.pending
  if(this.stop.signal.aborted)return Promise.reject(Error('Coordinator updates closed'))
  const task=this.discover();this.pending=task
  task.finally(()=>{if(this.pending===task)this.pending=undefined}).catch(()=>{})
  return task
 }
 async discover(){
  const call=(path,body)=>this.runtime.client.call(`/api/v1/messaging/${path}`,body,this.stop.signal)
  const page=await call(`coordinator-updates/pending${this.after?`?after=${encodeURIComponent(this.after)}`:''}`)
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v)
  if(!Array.isArray(page.items)||page.items.length>32||page.items.some(r=>!id(r.run_id)||!Number.isSafeInteger(r.revision)||r.revision<1)
   ||page.next_cursor&&(!id(page.next_cursor)||page.next_cursor===this.after))throw Error('Invalid Coordinator update page')
  const results=[]
  for(const row of page.items){
   this.stop.signal.throwIfAborted()
   try{const receipt=await call(`work-runs/${encodeURIComponent(row.run_id)}/coordinator-updates`,{expected_revision:row.revision});results.push({run_id:row.run_id,state:'queued',receipt})}
   catch(error){if(this.stop.signal.aborted)throw error;results.push({run_id:row.run_id,state:'pending',error})}
  }
  this.after=page.next_cursor??undefined;this.results=results;return results
 }
 start(){if(this.timer||this.stop.signal.aborted)return;const tick=()=>{void this.scan().catch(error=>{this.error=error})};this.timer=setInterval(tick,this.intervalMs);this.timer.unref?.();tick()}
 async close(){clearInterval(this.timer);this.stop.abort(Error('Coordinator updates closed'));await this.pending?.catch(()=>{})}
}
