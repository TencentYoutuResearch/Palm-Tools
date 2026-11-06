/** Read-only text projection. Event and text cursors preserve long replies without exposing tool/reasoning blocks. */
export function projectBuilderConversation(events,{seq=0,offset=0}={}){
  if(!Number.isSafeInteger(seq)||seq<0||!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid Builder conversation cursor')
  if(offset>0&&!events.some(event=>event.seq===seq))throw new Error('Builder conversation text cursor is unavailable')
  const messages=[];let cursor={seq,offset}
  for(const event of events){
    if(event.seq<seq)continue
    // The official loop stores runtime-context/tool-registry snapshots as user
    // events too. Only explicit human input belongs in the product conversation.
    const human=event.type==='user/message'&&['user','human'].includes(event.data?.source?.kind)
    const role=human?'user':event.type==='assistant/message'?'assistant':null
    const message=role==='user'?event.data:event.data?.message
    const parts=role?(message?.content??[]).filter(p=>p.type==='text'&&typeof p.text==='string'):[]
    const points=Array.from(parts.map(p=>p.text).join('\n'))
    const start=event.seq===seq?offset:0
    if(start>points.length || (start>0&&!role))throw new Error('Builder conversation cursor does not match text')
    if(role&&points.length){
      const end=Math.min(points.length,start+4096)
      messages.push({seq:event.seq,offset:start,role,text:points.slice(start,end).join(''),continued:end<points.length})
      if(end<points.length)return {messages,cursor:{seq:event.seq,offset:end},has_more:true}
    }
    cursor={seq:event.seq+1,offset:0}
    if(messages.length===8)return {messages,cursor,has_more:true}
  }
  return {messages,cursor,has_more:events.length===64}
}
export async function readBuilderConversation(ctx,client,operationId,cursor={seq:0,offset:0}){
  if(typeof operationId!=='string'||!/^[A-Za-z0-9_.:-]{1,160}$/.test(operationId))throw new Error('Invalid Builder operation identity')
  if(!Number.isSafeInteger(cursor.seq)||cursor.seq<0||!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw new Error('Invalid Builder conversation cursor')
  const path=`/api/v1/messaging/operations/${encodeURIComponent(operationId)}`
  const op=await client.call(path),{scope}=await client.call(`${path}/builder-scope`)
  if(!scope||scope.operation_id!==op.id||scope.request.attempt!==op.attempt||scope.request.epoch!==op.epoch
      ||scope.worker.session_id!==op.worker.session_id||scope.worker.node_id!==op.worker.node_id||scope.home_hub!==op.worker.node_id)throw new Error('Builder conversation scope unavailable')
  const service=ctx.get('kodeAgents'),binding=service?.profiles.binding(op.worker.session_id)
  if(!binding?.managedBuilder||binding.managedBuilder.draft_id!==scope.request.draft_id||binding.managedOperation?.id!==op.id
      ||binding.managedOperation.attempt!==op.attempt||binding.managedOperation.epoch!==op.epoch)throw new Error('Builder conversation binding unavailable')
  const checkHeader=header=>{
    if(header.id!==op.worker.session_id||!scope.workspaces.some(w=>w.host_id===op.worker.node_id&&w.root_ref===header.cwd))throw new Error('Builder stored conversation identity mismatch')
  }
  const agent=ctx.get('agents')?.get(op.worker.session_id)
  let events,source
  if(agent){
    checkHeader(agent.session.header)
    events=agent.session.snapshotEvents(cursor.seq).slice(0,64);source='live'
  }else{
    const persistence=ctx.get('sessionPersistence')
    if(!persistence)throw new Error('Builder conversation storage unavailable')
    const handle=await persistence.open(op.worker.session_id,'read')
    try{checkHeader(handle.header);events=(await handle.read(cursor.seq,64)).events;source='stored'}finally{await handle.close()}
  }
  return {operation_id:op.id,draft_id:scope.request.draft_id,source,...projectBuilderConversation(events,cursor)}
}
export function registerBuilderConversation(ctx,config){
  return ctx.webServer.register({kind:'exact',path:'/api/kode/builder/conversation',handler:async(req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
    const admitted=ctx.connection.admit(req)
    if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
    if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
    if(req.method!=='GET')return send(405,{error:'GET required'})
    try{
      const q=new URL(req.url,'http://localhost').searchParams
      if([...q.keys()].some(k=>!['operation_id','seq','offset'].includes(k)))throw new Error('Invalid query')
      const seq=q.get('seq')??'0',offset=q.get('offset')??'0'
      if(!/^\d+$/.test(seq)||!/^\d+$/.test(offset))throw new Error('Invalid cursor')
      return send(200,await readBuilderConversation(ctx,config.backendClient,q.get('operation_id'),{seq:Number(seq),offset:Number(offset)}))
    }catch{return send(409,{error:'Builder conversation unavailable or cursor invalid; no runtime was resumed'})}
  }})
}
