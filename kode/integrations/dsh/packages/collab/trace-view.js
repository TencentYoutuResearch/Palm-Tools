import React from 'react'
import { TRACE_VIEWS,readTraceManifest,readTraceSlice,exportTracePart } from './trace-data.js'
const h=React.createElement
const labels={work_events:'任务事件',assignments:'角色与分配尝试',operations:'执行操作',operation_events:'工具、权限与证据事件',model_calls:'模型调用与计量',model_events:'调用用量事件',messages:'内部通信原文',communication_events:'投递、消费与取消收据',conversation:'关联的人类请求与回复',archives:'产物归档引用',verification_archives:'验证日志归档引用',team_history:'共享团队历史'}
const scopes={work_run:'本任务',worker_assignment:'本任务 Worker',shared_coordinator_operation:'共享 Coordinator 操作',shared_human_request:'同一人类请求',home_archive_reference:'Hub 归档引用',shared_team_history:'共享团队历史'}
function Record({row}){
 const [open,setOpen]=React.useState(false)
 const kind=row.data?.kind??row.data?.id??row.data?.request?.model??'记录'
 return h('li',{className:'kode-collab-trace-record','data-trace-view':row.view,'data-trace-cursor':row.cursor},
  h('details',{open,onToggle:event=>setOpen(event.currentTarget.open)},
   h('summary',null,labels[row.view],' · ',String(kind),' · #',row.cursor),
   open&&h(React.Fragment,null,h('p',null,scopes[row.links.scope],row.redacted_paths.length?` · 已隐藏 ${row.redacted_paths.length} 处敏感字段`:''),
    h('pre',null,JSON.stringify({links:row.links,data:row.data,raw_sha256:row.raw_sha256,raw_bytes:row.raw_bytes,redacted_paths:row.redacted_paths},null,2)))))
}
function TraceReader({run,request}){
 const [anchor,setAnchor]=React.useState(run),[manifest,setManifest]=React.useState(null),[view,setView]=React.useState('all'),[draft,setDraft]=React.useState(''),[query,setQuery]=React.useState(''),[refresh,setRefresh]=React.useState(0)
 const [rows,setRows]=React.useState([]),[cursor,setCursor]=React.useState(null),[stamp,setStamp]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
 const [exporting,setExporting]=React.useState(false),[continuation,setContinuation]=React.useState(null),[exportMessage,setExportMessage]=React.useState('')
 const active=React.useRef(null),exportActive=React.useRef(null),manifestRef=React.useRef(null),exportRunning=React.useRef(false)
 const stale=run.revision!==anchor.revision
 const load=async(more=false)=>{
  active.current?.abort();const stop=new AbortController();active.current=stop;setBusy(true);setError('')
  try{
   let current=manifestRef.current
   if(!current)current=await readTraceManifest({run:anchor,request,signal:stop.signal})
   const result=await readTraceSlice({run:anchor,manifest:current,view,q:query,cursor:more?cursor:undefined,request,signal:stop.signal})
   if(stop.signal.aborted)return
   manifestRef.current=current;setManifest(current);setRows(previous=>more?[...previous,...result.items]:result.items);setCursor(result.next_cursor);setStamp({view,query,revision:anchor.revision})
  }catch{if(!stop.signal.aborted)setError('暂时无法读取新的追溯记录，已保留上次内容。任务有变化时，请先刷新任务详情和追溯。')}
  finally{if(!stop.signal.aborted)setBusy(false)}
 }
 React.useEffect(()=>{void load(false);return()=>active.current?.abort()},[anchor.id,anchor.home_hub,anchor.revision,view,query,refresh])
 React.useEffect(()=>()=>{active.current?.abort();exportActive.current?.abort()},[])
 const reload=()=>{
  active.current?.abort();exportActive.current?.abort();exportRunning.current=false;setExporting(false)
  manifestRef.current=null;setManifest(null);setAnchor(run);setContinuation(null);setExportMessage('');setRefresh(value=>value+1)
 }
 const save=async()=>{
  if(exportRunning.current||stale)return
  exportRunning.current=true;setExporting(true);setExportMessage('')
  const stop=new AbortController();exportActive.current=stop
  try{
   const result=await exportTracePart({run:anchor,request,continuation,signal:stop.signal})
   if(stop.signal.aborted)return
   const url=URL.createObjectURL(new Blob([JSON.stringify(result.document)],{type:'application/json'})),link=document.createElement('a')
   link.href=url;link.download=`kode-trace-${anchor.id.replace(/[^A-Za-z0-9_.-]/g,'_')}-part${result.document.part}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)
   setContinuation(result.continuation);setExportMessage(result.continuation?`已导出第 ${result.document.part} 部分，后续记录尚未导出。`:`已导出第 ${result.document.part} 部分，本次读取范围的记录已齐全。`)
  }catch{if(!stop.signal.aborted)setExportMessage('导出未完成。已导出的部分仍可保留，请重试；任务版本改变时需要重新读取并导出。')}
  finally{if(exportActive.current===stop){exportRunning.current=false;if(!stop.signal.aborted)setExporting(false)}}
 }
 return h('section',{className:'kode-collab-trace-reader','aria-label':'协作追溯'},
  h('div',{className:'kode-collab-toolbar'},h('h4',null,'协作追溯'),h('button',{type:'button',className:'kode-collab-button',onClick:reload,disabled:busy||exporting},'刷新追溯')),
  h('p',{className:'kode-collab-note'},'记录按类型与游标分组。共享会话记录按原操作范围展示用量。'),
  stale&&h('p',{role:'status'},`任务已有新进展，当前展示第 ${anchor.revision} 版追溯。刷新后可读取新版本。`),
  manifest?.prompt_attestation.missing>0&&h('p',{role:'status'},'有 ',manifest.prompt_attestation.missing,' 条调用缺少已记录的提示词生效凭据。'),
  manifest?.retention&&h('p',{className:'kode-collab-note'},'Hub 工作档案不会自动清理。工具输入和返回值以哈希关联；原文需在执行会话中查阅。'),
  h('form',{className:'kode-collab-trace-filters',onSubmit:event=>{event.preventDefault();if(new TextEncoder().encode(draft).length>160||draft.includes('\0')){setError('关键词过长或包含不可用字符，请缩短后重试。');return}setQuery(draft);setRefresh(value=>value+1)}},
   h('label',null,'记录类型',h('select',{'aria-label':'追溯记录类型',value:view,onChange:event=>setView(event.target.value)},h('option',{value:'all'},'全部记录'),...TRACE_VIEWS.map(name=>h('option',{key:name,value:name},labels[name])))),
   h('label',null,'关键词',h('input',{'aria-label':'追溯关键词',value:draft,maxLength:160,placeholder:'角色、工具、模型或记录编号',onChange:event=>setDraft(event.target.value)})),
   h('button',{type:'submit',className:'kode-collab-button',disabled:busy||stale},'搜索记录')),
  busy&&h('p',{role:'status'},'正在读取追溯记录…'),error&&h('p',{role:'status'},error),
  stamp&&h('p',{className:'kode-collab-note'},'已展示 ',rows.length,' 条 · ',labels[stamp.view]??'全部记录',stamp.query?` · 关键词：${stamp.query}`:''),
  stamp&&!rows.length&&!busy&&h('p',null,cursor?'本页未匹配，后面仍有记录可继续搜索。':'本次读取范围内没有匹配记录。'),
  h('ul',{className:'kode-collab-trace-records'},...rows.map(row=>h(Record,{key:row.view+':'+row.cursor,row}))),
  cursor&&h('button',{type:'button',className:'kode-collab-button',disabled:busy||stale,onClick:()=>void load(true)},query?'继续搜索':'更多追溯记录'),
  manifest&&h('details',null,h('summary',null,'冻结配置与原请求'),h('pre',null,JSON.stringify(manifest.context,null,2))),
  h('div',{className:'kode-collab-trace-export'},
   h('p',{className:'kode-collab-note'},'导出包含全部类型的追溯记录和归档引用。凭证字段、命令环境与参数已隐藏，归档原始文件保存在 Hub。'),
   h('button',{type:'button',className:'kode-collab-button',disabled:exporting||stale,onClick:()=>void save()},exporting?'正在导出…':continuation?'继续导出下一部分':'导出追溯记录'),
   exportMessage&&h('p',{role:'status'},exportMessage)))
}
export function TraceView({run,request}){
 const [open,setOpen]=React.useState(false)
 return h('div',{className:'kode-collab-trace'},h('button',{type:'button',className:'kode-collab-button','aria-expanded':open,onClick:()=>setOpen(value=>!value)},open?'收起完整追溯':'查看完整追溯'),open&&h(TraceReader,{key:JSON.stringify([run.home_hub,run.team_id,run.id]),run,request}))
}
