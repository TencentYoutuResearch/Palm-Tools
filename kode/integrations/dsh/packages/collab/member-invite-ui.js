import React from 'react'
import {Button,Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import {Icon} from './icons.js'
import {requestDiscussion} from './discussion-model.js'
import {eligibleChannelTeams,inviteStorageKey,createChannelInvite,validateChannelInvite,acceptChannelInvite} from './member-invite.js'
const h=React.createElement
export function InviteAgent({surface,teams,storage,onBuilder,onSaved}){
 const [open,setOpen]=React.useState(false),[team,setTeam]=React.useState(''),[pending,setPending]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[ready,setReady]=React.useState(false)
 const active=React.useRef(true),running=React.useRef(false),key=inviteStorageKey(surface)
 React.useEffect(()=>{active.current=true;setReady(false);setPending(null);setTeam('');setError('');try{const raw=storage.getItem(key);if(raw)setPending(validateChannelInvite(JSON.parse(raw),surface.scope,surface.id));setReady(true)}catch{setError('无法恢复邀请记录，请检查本地存储。')}return()=>{active.current=false}},[key])
 const available=eligibleChannelTeams(surface,teams)
 const save=async()=>{if(running.current||!ready||(!pending&&!team))return;running.current=true;setBusy(true);setError('');try{const command=pending??createChannelInvite({surface,team,teams,requestId:crypto.randomUUID()});storage.setItem(key,JSON.stringify(command));setPending(command);const result=acceptChannelInvite(command,await requestDiscussion('surfaces/'+surface.id,{},command.input));storage.removeItem(key);if(active.current){setPending(null);setTeam('');setOpen(false);onSaved(result)}}catch{if(active.current)setError('邀请结果尚未确认。重试使用原请求；若频道权限或版本已变化，请先重新核对。')}finally{running.current=false;if(active.current)setBusy(false)}}
 if(surface.kind!=='channel')return null
 return h(React.Fragment,null,h(Button,{type:'button','aria-label':'邀请成员',onClick:()=>setOpen(true)},h(Icon,{name:'users',size:16}),'邀请成员'),
  h(Modal,{open,title:'邀请成员到频道',closeLabel:'关闭',onClose:()=>{if(!busy)setOpen(false)}},h('div',{className:'kode-discussion-form kode-member-invite'},
   h('p',null,'邀请的单位是整个 Superagent 团队：加入后，这个团队和它的全部成员都能看到本频道的讨论。想 @ 某位成员，需要先邀请他所在的团队。@ 目前只记录要找的成员，不会自动回复，也不授予执行权限。'),
   h('h3',null,'添加已有团队'),h('label',null,'当前工作区可用团队',h('select',{'aria-label':'邀请的团队',value:team,disabled:busy||!!pending||!ready,onChange:e=>setTeam(e.target.value)},h('option',{value:''},'选择一个团队'),available.map(t=>h('option',{key:t.id,value:t.id},t.spec?.name||t.id)))),
   !available.length&&!pending&&h('p',null,'没有可添加的团队；已加入或未授权此工作区的团队不会列出。'),
   h('p',null,'确认后该团队成为频道成员，频道历史的可见范围会变化；依赖旧成员范围的任务授权需要重新核对。此操作不会激活团队或启动任务。'),
   pending&&h('p',{role:'status'},'有一条结果未确认的邀请，请重试原请求。'),error&&h('p',{role:'alert'},error),
   h(Button,{disabled:busy||!ready||(!pending&&!team),onClick:save},busy?'正在确认…':pending?'重试原邀请':'确认添加到频道'),
   h('h3',null,'需要新的团队？'),h('p',null,'Team Builder 会先保存草案，再确认工作区、能力与执行资源。配置后返回这里选择添加，不会自动扩展频道权限。'),
   h(Button,{disabled:busy||!!pending||!onBuilder,onClick:()=>{setOpen(false);onBuilder?.()}},h(Icon,{name:'agent',size:16}),'打开 Team Builder'))))
}
