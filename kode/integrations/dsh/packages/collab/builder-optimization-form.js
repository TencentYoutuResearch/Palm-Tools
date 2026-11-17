import React from 'react'
import {Button,Input,Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import {optimizationDraftKey,createOptimizationDraft,requestOptimizationDraft} from './builder-optimization.js'
const h=React.createElement
export function BuilderOptimizationForm({team,storage,onCreated}) {
 const [open,setOpen]=React.useState(false),[review,setReview]=React.useState(null),[pending,setPending]=React.useState(null),[purpose,setPurpose]=React.useState(''),[busy,setBusy]=React.useState(false),[ready,setReady]=React.useState(false),[error,setError]=React.useState('')
 const active=React.useRef(null),running=React.useRef(false)
 React.useEffect(()=>{const controller=new AbortController();active.current=controller;setReady(false);void storage.read(optimizationDraftKey(team.home_hub,team.id)).then(row=>{if(controller.signal.aborted)return;if(row&&(row.home_hub!==team.home_hub||row.command?.team_id!==team.id))throw Error('Wrong scope');setPending(row?.state==='prepared'?row:null);setReady(true)}).catch(()=>{if(!controller.signal.aborted)setError('无法读取原创建记录，请检查本地存储。')});return()=>controller.abort()},[team.home_hub,team.id,storage])
 const show=()=>{setReview({id:team.id,revision:team.revision,name:team.spec?.name||team.id});setError('');setOpen(true)}
 const purposeValid=!!purpose.trim()&&new TextEncoder().encode(purpose.trim()).length<=8192&&!purpose.includes('\0')
 const original=pending?.command,revision=original?.team_revision??review?.revision,changed=revision!==team.revision
 const confirm=async()=>{if(running.current||!ready||(!pending&&(changed||!purposeValid)))return;running.current=true;setBusy(true);setError('');try{const command=original??{team_id:team.id,team_revision:review.revision,draft_id:crypto.randomUUID(),request_id:crypto.randomUUID(),purpose:purpose.trim()};const draft=await createOptimizationDraft({storage,home:team.home_hub,command,request:requestOptimizationDraft,signal:active.current.signal});if(!active.current.signal.aborted){setPending(null);setOpen(false);onCreated(draft)}}catch(reason){if(!active.current.signal.aborted){setError(reason.message);try{const row=await storage.read(optimizationDraftKey(team.home_hub,team.id));setPending(row?.state==='prepared'?row:null)}catch{}}}finally{running.current=false;if(!active.current.signal.aborted)setBusy(false)}}
 return h(React.Fragment,null,h(Button,{variant:'outline',disabled:!ready||!Number.isSafeInteger(team.revision)||team.revision<1,onClick:show},pending?'恢复优化草案请求':'新建优化设计草案'),
 h(Modal,{open,title:'确认优化设计目标',closeLabel:'关闭',onClose:()=>{if(!busy)setOpen(false)},footer:h(React.Fragment,null,h(Button,{disabled:busy,onClick:()=>setOpen(false)},'取消'),h(Button,{variant:'primary',disabled:busy||!ready||(!pending&&(changed||!purposeValid)),onClick:confirm},pending?'重试原创建请求':'确认并新建设计草案'))},
 h('p',null,'为「',review?.name,'」创建独立优化设计草案？'),h('p',null,'目标：',team.id,' · 版本 ',revision),
 h('p',null,'将复制此版本的配置，不复制私信或模型历史；不会启动模型、修改团队或激活执行。后续接受方案和激活需要分别确认。'),
 h('div',{className:'kode-discussion-form'},h('label',null,'优化目标',h(Input,{'aria-label':'优化目标',value:original?.purpose??purpose,maxLength:8192,disabled:busy||!!pending,onChange:event=>setPurpose(event.target.value)}))),
 !pending&&purpose&&!purposeValid&&h('p',{role:'status'},'优化目标最多 8192 字节，不支持空文字或控制空字符。'),
 changed&&h('p',{role:'status'},'团队版本已变化，原目标版本保持不变。未提交的确认请取消后重新核对；已有请求仅可恢复原结果，不会自动改绑。'),
 h('p',null,'此草案仍需独立确认 Agent 与模型；需要查看项目时再选择工作区。自动执行前会另行核对权限与安全上限。'),error&&h('p',{role:'alert'},error)))
}
