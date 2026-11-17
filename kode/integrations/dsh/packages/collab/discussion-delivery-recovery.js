import React from 'react'
import { discussionDeliveryLabel } from './discussion-model.js'
import { IconButton } from './icons.js'
import { sameDiscussionScope } from './discussion-model.js'
const h=React.createElement
const equal=(a,b)=>JSON.stringify(sort(a))===JSON.stringify(sort(b))
const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x
export async function recoveryRequest(path,body,{signal}={}){
 const response=await fetch('/api/kode/interactive-teams/'+path,{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})})
 if(!response.ok)throw Error('Recovery unconfirmed')
 return response.json()
}
export function createDeliveryRecovery(message,{request=recoveryRequest}={}){
 const original=structuredClone(message);let snapshot=null,busy=false,attempted=false
 const validate=value=>{
  const b=value?.binding,s=original.interactive_selection
  if(value?.source_message_id!==original.id||!b?.binding_id||!b.native_session_id||b.first_source_message_id!==original.id||b.surface_id!==original.surface_id||b.thread_id!==original.thread_id||b.home_hub!==original.scope?.home_hub||!sameDiscussionScope({home_hub:b.home_hub,...b.workspace},original.scope)||s&&Object.entries(s).some(([k,v])=>(k==='workspace_id'?b.workspace?.workspace_id:b[k])!==v))throw Error('Recovery scope differs')
  if(snapshot&&!equal(snapshot,b))throw Error('Recovery binding changed')
  if(!['bound','published','interrupted'].includes(value.state)||value.state==='published'&&!value.reply_message_id)throw Error('Recovery status invalid')
  if(value.state==='interrupted'&&(value.cause!=='approval_rejected'||value.recovery?.recovery_allowed!==false))throw Error('Interruption evidence invalid')
  snapshot=structuredClone(b);return value
 }
 const read=async signal=>validate(await request('source-status?source_message_id='+encodeURIComponent(original.id),undefined,{signal}))
 const allowed=v=>v.state==='bound'&&v.recovery?.recovery_allowed===true&&v.recovery.state==='recoverable'&&v.recovery.native_absent===true&&v.recovery.never_claimed===true&&v.recovery.automatic_replay_allowed===false
 return { async openSession(open,signal){if(busy||!snapshot)throw Error('Check original request first');busy=true;try{const value=await read(signal);signal?.throwIfAborted();if(value.recovery?.native_absent!==false)throw Error('Original session unavailable');return await open(value.binding.native_session_id)}finally{busy=false}}, async check(signal){if(busy)throw Error('Busy');busy=true;try{return await read(signal)}finally{busy=false}},
 async recover(signal){if(busy||attempted||!snapshot)throw Error('Check original request first');busy=true
  try{const current=await read(signal);if(!allowed(current))return current;signal?.throwIfAborted();attempted=true
   try{const result=await request('recover',{binding_id:snapshot.binding_id,source_message_id:original.id,request_id:'composer-source:'+original.id},{signal});if(result?.state!=='published'||!equal(result.binding,snapshot)||typeof result.message_id!=='string'||!result.message_id)throw Error('Recovery receipt differs');return {...current,state:'published',reply_message_id:result.message_id}}
   catch{signal?.throwIfAborted();return await read(signal)}
  }finally{busy=false}}, canRecover:value=>!attempted&&allowed(value) }
}
export function DiscussionDeliveryRecovery({message,onUpdated,request,onOpenSession}){
 const model=React.useMemo(()=>createDeliveryRecovery(message,{request}),[message.id,message.surface_id,message.thread_id,request])
 const life=React.useRef(null),[status,setStatus]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
 const run=async recover=>{if(busy)return;const signal=life.current.signal;setBusy(true);setError('');try{const value=await (recover?model.recover(signal):model.check(signal));if(signal.aborted)return;setStatus(value);if(value.state==='published')onUpdated?.()}catch{if(!signal.aborted)setError('结果尚未确认，请核对原请求；不会自动重发。')}finally{if(!signal.aborted)setBusy(false)}}
 React.useEffect(()=>{const c=new AbortController();life.current=c;setStatus(null);setError('');void run(false);return()=>c.abort()},[model])
 const ready=status&&model.canRecover(status),interrupted=status?.state==='interrupted'
 const open=async()=>{if(busy)return;const signal=life.current.signal;setBusy(true);setError('');try{await model.openSession(onOpenSession,signal)}catch{if(!signal.aborted)setError('无法确认原会话归属，请重新核对。')}finally{if(!signal.aborted)setBusy(false)}}
 if(!error&&!ready&&!interrupted)return null
 return h('span',{className:'kode-discussion-recovery'},h('span',{role:'status'},error||(ready?'原会话尚未启动，可继续原请求':'本轮因权限请求被拒绝而结束，原消息不会重发')),(error||ready)&&h(IconButton,{icon:'refresh',label:busy?'正在核对原请求':error?'重试核对原请求':'继续原请求',disabled:busy,onClick:()=>void run(ready&&!error)}),interrupted&&status?.recovery?.native_absent===false&&onOpenSession&&h(IconButton,{icon:'chat',label:'查看原会话',disabled:busy,onClick:()=>void open()}))
}

/** The actual persisted-message delivery row, shared by channel and DM rendering. */
export function DiscussionDelivery({message,onUpdated,request,onOpenSession}) {
 const recoverable=message.actor?.kind==='human'&&!!message.interactive_selection&&message.interactive_delivery?.state!=='published'
 if(recoverable)return h(DiscussionDeliveryRecovery,{message,onUpdated,request,onOpenSession})
 const failed=message.interactive_delivery?.state==='uncertain'||['thread_context_compaction_required','isolated_context_required'].includes(message.delivery_reason)
 if(!failed)return null
 return h('small',{className:'kode-discussion-delivery',role:'status'},discussionDeliveryLabel(message))
}
