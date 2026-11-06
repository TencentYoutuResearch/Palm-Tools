/** Authenticated owner entry; not an Agent tool and never submits conversation input. */
export function registerCoordinatorStart(ctx) { return registerStart(ctx,'/api/kode/coordinator/start','startCoordinator') }
export function registerCoordinatorPlannedStart(ctx) { return registerStart(ctx,'/api/kode/coordinator/bootstrap','startPlannedCoordinator') }
function registerStart(ctx,path,method) {
  return ctx.webServer.register({kind:'exact',path,handler:async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))}
    const admitted=ctx.connection.admit(req)
    if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
    if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
    if(req.method!=='POST')return send(405,{error:'POST required'})
    if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
    const host=ctx.get('kodeAgents')?.officialLoops
    if(!host)return send(503,{error:'Coordinator runtime unavailable'})
    try{
      let bytes=0;const chunks=[]
      for await(const part of req){
        const chunk=Buffer.isBuffer(part)?part:Buffer.from(part)
        bytes+=chunk.length
        if(bytes>131072)return send(413,{error:'Coordinator start request too large'})
        chunks.push(chunk)
      }
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return send(200,await host[method](input))
    }catch{
      // An error can follow a committed preparation/creation. Never imply no effect,
      // automatically release a hold, or expose underlying provider/config errors.
      return send(409,{error:'Coordinator start was not confirmed; retry the exact request to recover its receipt',retry:'same_request'})
    }
  }})
}
