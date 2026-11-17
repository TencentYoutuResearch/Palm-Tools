import { SessionDiagnostics } from './session-diagnostics.js'
import {IconButton} from './icons.js'
import { requestCollabRead } from './data.js'
import React from 'react'
import {Button,Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import {requestDiscussion,discussionScope,sameDiscussionScope,validateMessagePage} from './discussion-model.js'
import {createTaskJournal,taskDraftKey,taskActionKey,tasksForThread,prepareTaskReview,validateCreatedTask,validateTask,validateExecution,executionBindings,prepareExecution,validateExecutionReceipt,taskError} from './discussion-task-model.js'
const h=React.createElement,{useState,useEffect,useRef}=React
const activationFor=async task=>{
 const response=await fetch('/api/kode/teams/activation?team_id='+encodeURIComponent(task.team_id),{credentials:'same-origin',redirect:'error'})
 if(!response.ok)throw Object.assign(Error('无法读取团队授权，请刷新团队配置。'),{status:response.status})
 return response.json()
}
const statuses={waiting_resource:'等待执行资源',waiting_user:'等待你的决定',running:'正在执行',completed:'执行流程已结束',failed:'执行失败',blocked:'执行受阻',cancelling:'正在请求停止',cancel_unconfirmed:'停止尚未确认',cancelled:'已停止',paused:'已暂停',recorded:'任务已记录',cancel_requested:'取消已请求，尚未确认停止'}
const actions=(...children)=>h('div',{className:'kode-task-actions'},...children)
function useAlive(){const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);return alive}

export function DiscussionTaskPanel({scope,surface,thread,teams,storage,onOpenTask,onOpenProcess,onOpenSession,onChanged}){
 const [data,setData]=useState(null),[error,setError]=useState(''),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[draft,setDraft]=useState(null),[review,setReview]=useState(null)
 const journal=useRef(createTaskJournal(storage,taskDraftKey(scope,surface.id,thread))),inFlight=useRef(false),alive=useAlive(),generation=useRef(0)
 const refresh=async()=>{
  const sequence=++generation.current
  try{
   const [messages,directory,surfaces]=await Promise.all([requestDiscussion('surfaces/'+surface.id+'/messages',{thread_id:thread,limit:'25'}),requestDiscussion('surfaces/'+surface.id+'/tasks'),requestDiscussion('surfaces',discussionScope(scope))])
   validateMessagePage(messages,scope,surface.id,thread)
   if(!sameDiscussionScope(surfaces.scope,scope)||!Array.isArray(surfaces.items)||surfaces.items.some(s=>!sameDiscussionScope(s.scope,scope)))throw Error('频道目录归属不一致。')
   const root=messages.items.find(m=>m.id===thread),saved=journal.current.read(),tasks=tasksForThread(directory,scope,surface.id,thread)
   // An audience revocation may hide a row in the directory. Never mistake it for a new task.
   const known=root?.task_id||saved.receipt?.id
   if(known&&!tasks.some(t=>t.id===known))tasks.push(validateTask(await requestDiscussion('tasks/'+known),scope))
   if(alive.current&&sequence===generation.current){setData({root,tasks,surfaces:surfaces.items,surface:messages.surface});setDraft(saved);setError('')}
  }catch(e){if(alive.current&&sequence===generation.current){setData(null);setReview(null);setError(taskError(e))}}
 }
 useEffect(()=>{refresh();return()=>{generation.current++}},[])
 const edit=patch=>{setReview(null);try{setDraft(journal.current.edit(patch));setError('')}catch(e){setError(taskError(e))}}
 const perform=async work=>{if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');try{await work()}catch(e){if(alive.current)setError(taskError(e))}finally{inFlight.current=false;if(alive.current)setBusy(false)}}
 const inspect=()=>perform(async()=>{
  const team=teams.find(t=>t.id===draft.team&&t.home_hub===scope.home_hub),archive=data.surfaces.find(s=>s.id===draft.archive)
  const value=await prepareTaskReview({scope,surface:data.surface,root:data.root,archive,team,summary:draft.summary})
  if(alive.current)setReview(value)
 })
 const publish=()=>perform(async()=>{
  const frozen=journal.current.read().pending??review
  if(!frozen||!sameDiscussionScope(frozen.scope,scope)||frozen.source!==surface.id||frozen.thread!==thread)throw Error('摘要批准已失效，请重新核对。')
  const pending=journal.current.prepare(frozen);if(alive.current)setDraft(journal.current.read())
  const task=validateCreatedTask(await requestDiscussion('tasks',{},pending.input),pending)
  journal.current.accept(pending,task)
  if(alive.current){setDraft(journal.current.read());setOpen(false);setReview(null);await refresh();onChanged()}
 })
 const available=teams.filter(t=>t.home_hub===scope.home_hub&&data?.surface.team_ids.includes(t.id)&&!data.tasks.some(task=>task.team_id===t.id))
 const channels=(data?.surfaces??[]).filter(s=>s.enabled&&s.kind==='channel'&&s.team_ids.includes(draft?.team))
 const canCreate=data?.root?.kind==='discussion'&&data.root.actor?.kind==='human'&&data.root.actor.id==='local_owner'&&available.length>0&&!draft?.receipt
 const close=()=>{setOpen(false);setReview(null)}
 return h('section',{className:'kode-discussion-task-panel','aria-label':'本讨论串任务'},
  data?.tasks.map(task=>h(TaskStatus,{key:task.id,scope,task,storage,source:surface.id,onOpenProcess,onOpenSession,onOpenTask:()=>onOpenTask(data.surfaces.find(s=>s.id===task.archive_surface_id),task.thread_id),onChanged})),
  !data&&!error&&h('small',null,'正在核对本串任务…'),error&&h('p',{role:'alert'},error),
  actions((canCreate||draft?.pending)&&h(Button,{disabled:busy,onClick:()=>setOpen(true)},draft?.pending?'恢复原任务创建请求':'整理为任务'),error&&h(IconButton,{icon:'refresh',label:'刷新任务',disabled:busy,onClick:refresh})),
  h(Modal,{open,onClose:close,title:'整理任务摘要',closeLabel:'关闭任务摘要'},h('div',{className:'kode-task-form'},
   h('p',null,'只发布你核对过的摘要。原讨论与私信历史不会复制到任务，也不会因此启动执行。'),
   h('label',null,'负责团队',h('select',{'aria-label':'任务负责团队',value:draft?.team??'',disabled:busy||!!draft?.pending,onChange:e=>edit({team:e.target.value,archive:''})},h('option',{value:''},'选择团队'),available.map(t=>h('option',{key:t.id,value:t.id},t.spec?.name||t.id)))),
   h('label',null,'任务归档频道',h('select',{'aria-label':'任务归档频道',value:draft?.archive??'',disabled:busy||!!draft?.pending,onChange:e=>edit({archive:e.target.value})},h('option',{value:''},'选择当前工作区的频道'),channels.map(s=>h('option',{key:s.id,value:s.id},s.title)))),
   draft?.team&&!channels.length&&h('p',{role:'status'},'此团队尚无可用归档频道。请先创建频道或邀请该团队。'),
   h('label',null,'批准范围与验收要求',h('textarea',{'aria-label':'任务摘要',value:draft?.summary??'',disabled:busy||!!draft?.pending,rows:6,placeholder:'描述要解决的问题、允许的改动范围和验收标准…',onChange:e=>edit({summary:e.target.value})})),
   (review||draft?.pending)&&h(SummaryReview,{review:draft?.pending??review}),
   error&&h('p',{role:'alert'},error),
   actions(h(Button,{onClick:close},'关闭'),draft?.pending?h(Button,{disabled:busy,onClick:publish},busy?'恢复中…':'恢复原创建请求'):review?h(Button,{disabled:busy,onClick:publish},busy?'创建中…':'批准摘要并创建任务'):h(Button,{disabled:busy||!draft?.summary.trim()||!draft?.team||!draft?.archive,onClick:inspect},busy?'核对中…':'核对发布摘要')))))
}
function SummaryReview({review}){return h('section',{className:'kode-task-review','aria-label':'待批准的任务摘要'},h('h3',null,'确认发布到「'+review.archiveTitle+'」'),h('p',null,'负责团队：'+review.teamName+' · 仅创建任务，执行需另行批准。'),h('p',{className:'kode-task-summary'},review.input.summary),h('small',null,'修改摘要、团队或频道后，需要重新核对。'))}

function TaskStatus({scope,task:initial,storage,source,onOpenTask,onOpenProcess,onOpenSession,onChanged}){
 const [task,setTask]=useState(initial),[preview,setPreview]=useState(null),[error,setError]=useState(''),[open,setOpen]=useState(false),[review,setReview]=useState(null),[binding,setBinding]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState(null),[cancelOpen,setCancelOpen]=useState(false),[cancelPending,setCancelPending]=useState(null)
 const alive=useAlive(),inFlight=useRef(false),readFlight=useRef(false),execute=useRef(createTaskJournal(storage,taskActionKey(scope,initial.id,'execute'))),cancel=useRef(createTaskJournal(storage,taskActionKey(scope,initial.id,'cancel')))
 const read=async()=>{const current=validateTask(await requestDiscussion('tasks/'+initial.id),scope);return {task:current,preview:validateExecution(await requestDiscussion('tasks/'+initial.id+'/execution'),current,scope)}}
 const refresh=async()=>{if(readFlight.current)return;readFlight.current=true;try{const value=await read();if(alive.current){setTask(value.task);setPreview(value.preview);setError('')}}catch(e){if(alive.current){setPreview(null);setReview(null);setError(taskError(e))}}finally{readFlight.current=false}}
 useEffect(()=>{try{setPending(execute.current.read().pending);setCancelPending(cancel.current.read().pending)}catch{setError('无法读取原操作记录，暂不能执行。');return}refresh();const timer=setInterval(()=>{if(document.visibilityState!=='hidden'&&!inFlight.current)refresh()},5000);return()=>clearInterval(timer)},[])
 const perform=async work=>{if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');try{await work()}catch(e){if(alive.current)setError(taskError(e))}finally{inFlight.current=false;if(alive.current)setBusy(false)}}
 const inspect=()=>perform(async()=>{
  setOpen(true);setReview(null)
  const current=await read(),activation=await activationFor(current.task),bindings=executionBindings(activation,current.task)
  if(!bindings.length)throw Error('没有匹配本工作区的本地流程。请在团队配置中核对流程、权限与交付目标。')
  if(current.task.work_run_id)throw Error('此任务已有执行记录，请刷新进度。')
  if(alive.current){setTask(current.task);setPreview(current.preview);setReview({...current,activation,bindings});setBinding(bindings[0].id)}
 })
 const dispatch=()=>perform(async()=>{
  let record=execute.current.read().pending
  if(!record){if(!review)throw Error('请先预览执行范围。');record={task:review.task,input:prepareExecution(review.task,review.preview,review.activation,binding)}}
  validateTask(record.task,scope);if(record.task.id!==initial.id)throw Error('执行请求归属不匹配。')
  record=execute.current.prepare(record);if(alive.current)setPending(record)
  const receipt=validateExecutionReceipt(await requestDiscussion('tasks/'+initial.id+'/execution',{},record.input),record.task,record.input)
  execute.current.accept(record,receipt)
  if(alive.current){setPending(null);setOpen(false);setReview(null);await refresh();onChanged()}
 })
 const cancelExecution=()=>perform(async()=>{
  let record=cancel.current.read().pending
  if(!record){
   if(!preview)throw Error('请刷新进度后重试。')
   record={task_id:task.id,run_id:preview.work_run?.id??null,path:'tasks/'+task.id+(preview.work_run?'/execution/cancel':'/commands'),input:preview.work_run?{request_id:crypto.randomUUID(),expected_run_revision:preview.work_run.revision,reason:'Owner confirmed cancellation in the task discussion'}:{request_id:crypto.randomUUID(),expected_revision:task.revision,source_surface_id:source,action:'cancel',content:null,worker_id:null}}
  }
  if(record.task_id!==initial.id)throw Error('取消请求归属不匹配。')
  record=cancel.current.prepare(record);if(alive.current)setCancelPending(record)
  const result=await requestDiscussion(record.path,{},record.input)
  if(record.run_id?(result.task_id!==initial.id||result.work_run_id!==record.run_id):(validateTask(result.task,scope).id!==initial.id||result.task.state!=='cancel_requested'))throw Error('取消回执不匹配，请恢复原请求。')
  cancel.current.accept(record,result)
  if(alive.current){setCancelPending(null);setCancelOpen(false);await refresh();onChanged()}
 })
 const run=preview?.work_run,state=run?.state??task.state,stopped=['cancelled','cancel_requested','cancelling','cancel_unconfirmed','completed','failed'].includes(state),selected=review?.bindings.find(b=>b.id===binding)
 return h('div',{className:'kode-task-status','data-task-id':task.id,'data-run-id':run?.id??''},
  h('div',{className:'kode-task-title'},h('strong',null,'本串任务'),h('span',{role:'status'},error?'任务状态待核对':statuses[state]??state)),
  h('p',{className:'kode-task-summary'},task.summary),
  h('small',null,run?.completion_authorized?'Hub 已确认交付':run?'已有执行记录 · 尚未确认交付':'尚未批准执行'),
  actions(h(Button,{disabled:busy,onClick:onOpenTask},'打开任务串'),task.work_run_id&&onOpenProcess&&h(Button,{disabled:busy,onClick:()=>{try{onOpenProcess(scope,task)}catch(e){setError(taskError(e))}}},'查看工作过程'),h(Button,{disabled:busy,onClick:refresh},'刷新进度'),pending?h(Button,{disabled:busy,onClick:()=>{setOpen(true);setReview(null)}},'恢复原执行请求'):!run&&task.state==='recorded'&&h(Button,{disabled:busy||!preview,onClick:inspect},'预览执行'),(cancelPending||(!stopped&&!pending))&&h(Button,{disabled:busy||(!preview&&!cancelPending),onClick:()=>setCancelOpen(true)},cancelPending?'恢复取消请求':'取消任务')),
  run&&onOpenSession&&h(SessionDiagnostics,{key:run.id,run:{...run,home_hub:scope.home_hub,team_id:task.team_id},request:requestCollabRead,onOpenSession:(run,item)=>onOpenSession(run,item,{scope,task}),compact:true}),
  error&&h('p',{role:'alert'},error),
  h('details',null,h('summary',null,'任务标识'),h('p',null,'任务：'+task.id),h('p',null,'执行：'+(run?.id??'尚未创建'))),
  h(Modal,{open,onClose:()=>{setOpen(false);setReview(null)},title:pending?'恢复已批准的执行请求':'核对本地执行范围',closeLabel:'关闭执行预览'},h('div',{className:'kode-task-form'},
   pending?h('p',null,'原批准请求尚未确认。恢复将使用相同任务、流程、版本和摘要指纹，不会另外创建执行。'):review&&h(React.Fragment,null,
    h('p',{className:'kode-task-summary'},review.task.summary),
    h('label',null,'执行流程',h('select',{'aria-label':'任务执行流程',value:binding,disabled:busy,onChange:e=>setBinding(e.target.value)},review.bindings.map(b=>h('option',{key:b.id,value:b.id},b.id)))),
    h('div',null,h('small',null,'工作区'),h('p',null,scope.root_ref)),h('p',null,'仅在此工作区按以下阶段读取或修改文件；禁用网络，仅本地交付。此批准不含推送、合并或部署。'),
    h('ul',null,selected?.workflow.pack.stages.map(s=>h('li',{key:s.id},s.id+' · '+(s.execution.capabilities.includes('workspace_write')?'可修改工作区':'只读检查')))),
    h('small',null,'任务版本 '+review.task.revision+' · 团队授权版本 '+review.activation.revision),
    h('details',null,h('summary',null,'查看完整执行输入与指纹'),h('p',null,'SHA-256：'+review.preview.context_sha256),h('pre',null,JSON.stringify(review.preview.context,null,2)))),
   !review&&!pending&&!error&&h('p',null,'正在读取当前任务和团队授权…'),error&&h('p',{role:'alert'},error),
   actions(h(Button,{onClick:()=>{setOpen(false);setReview(null)}},'关闭'),h(Button,{disabled:busy||(!review&&!pending),onClick:dispatch},busy?'提交中…':pending?'恢复原执行请求':'批准本地执行')))),
  h(Modal,{open:cancelOpen,onClose:()=>setCancelOpen(false),title:'取消这项任务？',closeLabel:'关闭取消确认'},h('div',{className:'kode-task-form'},h('p',{className:'kode-task-summary'},task.summary),h('p',null,'只取消这项任务。提交后仍需等待 Hub 确认停止，不会影响其他讨论串。'),error&&h('p',{role:'alert'},error),actions(h(Button,{onClick:()=>setCancelOpen(false)},'继续保留'),h(Button,{disabled:busy,onClick:cancelExecution},busy?'请求中…':cancelPending?'恢复原取消请求':'确认取消这项任务')))))
}
export const discussionTaskStyles=`
.kode-discussion-task-panel{flex:none;max-height:34%;overflow:auto;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:13px}.kode-discussion-task-panel:empty{display:none}.kode-task-status+.kode-task-status{margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}.kode-task-title{display:flex;justify-content:space-between;gap:12px}.kode-task-title>span,.kode-task-status>small,.kode-task-form small{color:var(--dsw-alias-label-secondary);font-size:12px}.kode-task-summary{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin:8px 0}.kode-task-status>.kode-task-summary{max-height:4.8em;overflow:auto}.kode-task-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.kode-task-actions:empty{display:none}.kode-task-actions button{font-size:12px}.kode-task-status details{margin-top:8px;font-size:11px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}.kode-task-form{display:flex;flex-direction:column;gap:14px;max-width:640px}.kode-task-form p{margin:0;line-height:1.6;overflow-wrap:anywhere}.kode-task-form label{display:flex;flex-direction:column;gap:6px;font-size:13px}.kode-task-form textarea,.kode-task-form select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:10px;box-sizing:border-box;width:100%;caret-color:var(--dsw-alias-label-primary)}.kode-task-form textarea{resize:vertical;min-height:120px}.kode-task-form textarea:focus-visible,.kode-task-form select:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.kode-task-form pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:220px;overflow:auto}.kode-task-review{border-top:1px solid var(--dsw-alias-border-l2);padding-top:14px}.kode-task-review h3{font-size:15px;margin:0 0 8px}.kode-task-review p{margin-bottom:8px}.kode-task-form [role=alert],.kode-discussion-task-panel [role=alert]{line-height:1.5}.kode-task-form ul{margin:0;padding-left:20px;line-height:1.7}
`
