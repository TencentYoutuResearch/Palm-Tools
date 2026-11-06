import React from 'react'
import { readBuilderClose,confirmBuilderClose,requestBuilderClose } from './builder-close-command.js'
const h=React.createElement
export function BuilderCloseForm({draft,startup,storage,onState}){
 const [slot,setSlot]=React.useState(null),[ready,setReady]=React.useState(false),[review,setReview]=React.useState(false),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState('')
 const active=React.useRef(null),running=React.useRef(false)
 React.useEffect(()=>{
  const stop=new AbortController();active.current=stop
  void readBuilderClose(storage,draft,startup).then(value=>{if(!stop.signal.aborted){setSlot(value);setReady(true);onState(value?.state??'open')}}).catch(()=>{if(!stop.signal.aborted)setNotice('无法核对结束记录，请重新打开草案。')})
  return()=>stop.abort()
 },[draft.id,draft.home_hub,startup.receipt.request.operation.id])
 const confirm=async()=>{
  if(running.current||!ready||(!slot&&!review))return
  running.current=true;setBusy(true);setNotice('')
  try{
   const result=await confirmBuilderClose({storage,draft,startup,request:requestBuilderClose,signal:active.current.signal,onPrepared:prepared=>{setSlot(prepared);setReview(false);onState(prepared.state)}})
   if(!active.current.signal.aborted){setSlot(await readBuilderClose(storage,draft,startup));onState(result.state);if(result.state==='closing')setNotice('正在等待已接收的消息处理完毕，请稍后继续本次结束。')}
  }catch{if(!active.current.signal.aborted){setNotice('结束与对账结果尚未确认。请恢复本次请求。');try{const saved=await readBuilderClose(storage,draft,startup);if(saved){setSlot(saved);onState(saved.state)}}catch{}}}
  finally{running.current=false;if(!active.current.signal.aborted)setBusy(false)}
 }
 const accounting=slot?.receipt?.accounting,budget=slot?.last_observation?.accounting?.budget,unit=startup.command.start.operation.funding.unit
 return h('section',{className:'kode-collab-builder-close'},h('h4',null,'结束本次搭建'),
  slot?.state==='closed'?h('p',{role:'status'},'本次搭建已结束。创建预算已对账，剩余预留已释放。内部扣减：',accounting.reservation.charged,' ',unit,'；预留：0。供应商费用尚未确认。'):
   slot?.state==='waiting_accounting'?h('p',{role:'status'},'本次搭建用量待核对。内部扣减：',budget.charged,' ',unit,'；',budget.frozen?'本次创建预留仍持有：':'本次创建预留余额：',budget.held,' ',unit,'。尚未完成对账。'):
   slot?h('button',{type:'button',className:'kode-collab-button',disabled:busy,onClick:()=>void confirm()},busy?'正在结束…':'恢复本次结束'):
    review?h('div',null,h('p',null,'确认结束后，助手将处理完已接收的消息，按已确认的内部单价对账并释放创建预算剩余预留。对话记录继续保留，已创建的团队不受此操作影响。'),h('button',{type:'button',className:'kode-collab-button',disabled:busy,onClick:()=>void confirm()},'确认结束并释放创建预留'),h('button',{type:'button',className:'kode-collab-button',disabled:busy,onClick:()=>setReview(false)},'继续搭建')):
     h('button',{type:'button',className:'kode-collab-button',disabled:!ready||busy,onClick:()=>setReview(true)},'核对结束本次搭建'),
  notice&&h('p',{role:'status'},notice))
}
