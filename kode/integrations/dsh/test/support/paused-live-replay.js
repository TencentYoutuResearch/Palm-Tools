/** Manual hold for disposable live tests. No automatic retry, inference admission, timer or network listener. */
export function pausedLiveReplay({ pauseAutomatic, capture, readRun, settleCancellation, closeOwned }) {
 for(const fn of [pauseAutomatic,capture,readRun,settleCancellation,closeOwned])if(typeof fn!=='function')throw Error('Explicit live replay lifecycle callbacks required')
 let pauseTask,closeTask,phase='running',originalFailure
 const checkpoint=async name=>{try{await capture(name,{error:originalFailure})}catch{/* Evidence must never replace the original stage failure. */}}
 return {
  get phase(){return phase},
  get originalFailure(){return originalFailure},
  pause(error){
   if(closeTask)return Promise.reject(Error('Replay already closing'))
   if(pauseTask)return pauseTask
   originalFailure=error
   pauseTask=(async()=>{phase='pausing';await checkpoint('before_manual_hold');try{await pauseAutomatic()}catch(cause){phase='pause_unconfirmed';await checkpoint('pause_unconfirmed');throw cause}phase='held';await checkpoint('manual_hold_ready');return{state:phase}})()
   return pauseTask
  },
  async status(){if(phase!=='held')throw Error('Replay is not safely held');return readRun()},
  async reconcileCancellation(){
   if(phase!=='held')throw Error('Replay is not safely held')
   const run=await readRun()
   if(run.state==='cancelled')return{state:'cancelled',receipt:run.cancellation??null}
   if(!['cancelling','cancel_unconfirmed'].includes(run.state))throw Error('Owner cancellation must already be recorded by the authoritative Hub')
   await checkpoint('before_manual_cancellation_settle')
   try{return await settleCancellation(run)}finally{await checkpoint('after_manual_cancellation_settle')}
  },
  close(){return closeTask??=(async()=>{await pauseTask?.catch(()=>{});phase='closing';await checkpoint('before_manual_close');try{await closeOwned()}finally{phase='closed';await checkpoint('after_manual_close')}})()},
 }
}
