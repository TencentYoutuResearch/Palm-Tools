/** Compile a read-only native history window into released dsh Session events.
 * Source timestamps and tool lifecycles are retained; nothing is executed. */
import { createHash } from 'node:crypto'
import { constants,zstdCompressSync } from 'node:zlib'

export function encodeHistoryArtifact(header,events) {
  const options={params:{[constants.ZSTD_c_checksumFlag]:1}}
  const frames=[zstdCompressSync(Buffer.from(JSON.stringify({delegationDepth:0,...header})+'\n'),options)]
  for(let index=0;index<events.length;index+=256)frames.push(zstdCompressSync(Buffer.from(events.slice(index,index+256).map(row=>JSON.stringify(row)).join('\n')+'\n'),options))
  return Buffer.concat(frames)
}

export function buildHistorySeed(transcript, selection) {
  const rows=transcript.timeline ?? transcript.messages ?? [], events=[]
  const stamp=row=>Number.isSafeInteger(row?.time)&&row.time>=0?row.time:undefined
  let time=rows.map(stamp).find(value=>value!==undefined) ?? 0, turn=0, step=0, open=false, stepOpen=false, output=false
  let content=[],contentAt,calls=[],pending=new Map(),waiting=[]
  const marked=rows.some(row=>row.kind==='turn_start')
  const push=(type,data,at=time,surface=false)=>{events.push({type,seq:events.length,time:at,data,...(surface?{surfaceOp:'append'}:{})})}
  const id=label=>`history-${createHash('sha256').update(`${turn}:${step}:${events.length}:${label}`).digest('hex').slice(0,24)}`
  const startStep=()=>{if(!stepOpen){step++;push('step/start',{turn,step});stepOpen=true}}
  const start=()=>{if(open)return;turn++;step=0;open=true;output=false;push('turn/start',{turn});push('request/header',{header:{config:selection},reason:turn===1?'initial':'resume'});startStep()}
  const flush=()=>{
    if(!content.length && !calls.length)return
    start();startStep()
    const advertised=calls.map(row=>({type:'tool-call',id:row.id,name:row.name,arguments:JSON.stringify(row.arguments??{})}))
    push('assistant/message',{turn,step,message:{id:id('assistant'),role:'assistant',source:{kind:'model',...selection},content:[...content,...advertised]},stream:[]},contentAt??stamp(calls[0])??time,true)
    for(const row of calls){push('tool/call',{turn,step,callId:row.id,name:row.name,arguments:JSON.stringify(row.arguments??{})},stamp(row)??time);pending.set(row.nativeId,row)}
    content=[];contentAt=undefined;calls=[]
  }
  const result=(call,text,isError=false)=>push('tool/result',{turn,step,message:{id:id('result'),role:'tool',source:{kind:'tool',callId:call.id},toolCallId:call.id,content:[{type:'text',text}],isError}},time,true)
  const closeStep=()=>{if(stepOpen){push('step/end',{turn,step});stepOpen=false}}
  const close=(reason='completed')=>{
    if(!open)return
    flush()
    for(const call of pending.values())result(call,'历史片段未记录该调用的最终结果。')
    pending.clear();closeStep();push('turn/end',{turn,reason:{kind:reason,...(reason==='aborted'?{reason:{kind:'user'}}:{})}});open=false
  }
  const user=row=>{start();startStep();push('user/message',{id:id('user'),role:'user',source:{kind:'user'},content:[{type:'text',text:row.text}]},stamp(row)??time,true)}
  for(const row of rows){
    const previousTime=time
    const at=stamp(row);if(at!==undefined)time=at
    if(row.kind==='turn_start'){
      close();start();for(const message of waiting)user(message);waiting=[];continue
    }
    if(row.kind==='turn_end'){close(row.reason==='aborted'?'aborted':'completed');continue}
    if(row.kind==='text' && row.text){
      if(row.role==='user'){
        if(!marked && open && output){const nextTime=time;time=previousTime;close();time=nextTime}
        if(!open && marked){waiting.push(row);continue}
        user(row)
      }else{
        start();for(const message of waiting)user(message);waiting=[];startStep();content.push({type:'text',text:row.text});contentAt=time;output=true
      }
      continue
    }
    if(row.kind==='tool_call' && row.call_id && row.name){
      start();for(const message of waiting)user(message);waiting=[];startStep();output=true
      calls.push({...row,nativeId:row.call_id,id:`history:${turn}:${row.call_id}`});continue
    }
    if(row.kind==='tool_result'){
      flush();const call=pending.get(row.call_id)
      if(!call)continue
      result(call,row.text??'',Boolean(row.is_error));pending.delete(row.call_id)
      if(!pending.size){closeStep();}
    }
  }
  if(waiting.length){start();for(const row of waiting)user(row)}
  close()
  return events
}

/** Keep event identities and references while repairing older reused turn IDs. */
export function renumberNativeTurns(events) {
  let turn=0
  return events.map(event=>{
    if(event.type==='turn/start')turn++
    if(event.data && typeof event.data.turn==='number')return{...event,data:{...event.data,turn}}
    return event
  })
}
