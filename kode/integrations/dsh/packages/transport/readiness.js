/** The Web listener can accept connections before sessionController mounts.
 * Probe only the owner read endpoint; never replay creation or prompt calls. */
export async function waitForSessionService(fetcher,signal,{timeoutMs=15000,retryMs=100}={}){
  const deadline=Date.now()+timeoutMs
  while(!signal.aborted && Date.now()<deadline){
    try{
      const response=await fetcher('/api/kode/project-hosts',{method:'GET',credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()))])})
      if(response.ok)return true
      // Authentication and configuration errors belong to the normal carrier.
      if(response.status!==404 && response.status!==503)return false
    }catch(error){if(signal.aborted)throw signal.reason;if(!(error instanceof TypeError)&&error.name!=='TimeoutError')throw error}
    signal.throwIfAborted()
    await new Promise((resolve,reject)=>{
      const done=()=>{signal.removeEventListener('abort',abort);resolve()}
      const timer=setTimeout(done,Math.min(retryMs,Math.max(0,deadline-Date.now())))
      const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason)}
      signal.addEventListener('abort',abort,{once:true})
    })
  }
  signal.throwIfAborted();return false
}
