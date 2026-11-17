/** Stable owner-facing conversation intake, independent of session/model identity. */
export function registerConversation(ctx,config){
 return ctx.webServer.register({kind:'exact',path:'/api/kode/conversation/messages',handler:async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
  const admitted=ctx.connection.admit(req)
  if('rejection' in admitted)return send(admitted.rejection,{error:'authentication required'})
  if(admitted.peer.principal.kind!=='owner')return send(403,{error:'Host owner required'})
  if(!['POST','GET'].includes(req.method))return send(405,{error:'GET or POST required'})
  if(!config?.backendClient)return send(503,{error:'Conversation backend unavailable'})
  const valid=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(v)
  let sendingClarification=false
  try{
   if(req.method==='GET'){
    const query=new URL(req.url,'http://localhost').searchParams,id=query.get('conversation_id'),request=query.get('request_id')
    if(query.get('view')==='task-notices'){
     const after=query.get('after')
     if(!valid(id)||(after!==null&&!valid(after))||[...query.keys()].some(k=>!['conversation_id','view','after'].includes(k)||query.getAll(k).length!==1))return send(400,{error:'Invalid task notice query'})
     return send(200,await config.backendClient.call(`/api/v1/messaging/conversations/${encodeURIComponent(id)}/task-notices${after?'?'+new URLSearchParams({after}):''}`))
    }
    if(query.get('view')==='clarifications'){
     if(!valid(id)||[...query.keys()].some(k=>!['conversation_id','view'].includes(k)||query.getAll(k).length!==1))return send(400,{error:'Invalid clarification query'})
     return send(200,await config.backendClient.call(`/api/v1/messaging/conversations/${encodeURIComponent(id)}/clarifications`))
    }
    if(!valid(id)||[...query.keys()].some(k=>!['conversation_id','request_id','after','limit'].includes(k)))return send(400,{error:'Invalid conversation query'})
    if(request!==null){
     if(!valid(request)||query.has('after')||query.has('limit'))return send(400,{error:'Invalid receipt query'})
     return send(200,await config.backendClient.call(`/api/v1/messaging/conversations/${encodeURIComponent(id)}/requests/${encodeURIComponent(request)}`))
    }
    const after=query.get('after')??'0',limit=query.get('limit')??'20'
    if(!/^\d+$/.test(after)||!/^\d+$/.test(limit)||!Number.isSafeInteger(Number(after))||Number(limit)<1||Number(limit)>50)return send(400,{error:'Invalid conversation cursor'})
    return send(200,await config.backendClient.call(`/api/v1/messaging/conversations/${encodeURIComponent(id)}/messages?after=${after}&limit=${limit}`))
   }
   if(!(req.headers['content-type']??'').startsWith('application/json'))return send(415,{error:'JSON required'})
   let bytes=0;const chunks=[]
   for await(const part of req){const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);bytes+=chunk.length;if(bytes>131072)return send(413,{error:'Message too large'});chunks.push(chunk)}
   let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return send(400,{error:'Invalid JSON'})}
   if(!input||Object.keys(input).some(k=>!['conversation_id','request_id','content','prior_run_id','clarification_target'].includes(k))||!valid(input.conversation_id)||!valid(input.request_id)
    ||('clarification_target' in input && (!input.clarification_target || Array.isArray(input.clarification_target) || Object.keys(input.clarification_target).length!==3 || !['run_id','assignment_id','question_request_id'].every(k=>valid(input.clarification_target[k])) || 'prior_run_id' in input))
    ||('prior_run_id' in input && !valid(input.prior_run_id))
    ||typeof input.content!=='string'||!input.content.trim()||input.content.includes('\0')||Buffer.byteLength(input.content)>65536)return send(400,{error:'Invalid conversation message'})
   sendingClarification=!!input.clarification_target
   const {conversation_id,...message}=input
   return send(200,await config.backendClient.call(`/api/v1/messaging/conversations/${encodeURIComponent(conversation_id)}/messages`,message))
  }catch(error){
   if(sendingClarification&&[400,403,409,422].includes(error?.status))return send(error.status,{code:'clarification_rejected',error:'Hub 拒绝了这条澄清回答：问题已失效、任务已停止或目标不匹配。请刷新问题列表核对；原回答与请求编号已保留。',retry:'same_request'})
   return send(409,{error:'Conversation operation was not confirmed; for a send, read its receipt or retry the exact request',retry:'same_request'})}
 }})
}
