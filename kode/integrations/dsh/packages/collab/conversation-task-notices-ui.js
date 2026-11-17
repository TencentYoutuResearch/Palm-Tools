import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { requestCollabRead } from './data.js'
import { visibleRefresh } from './visible-refresh.js'
import { validateTaskNotices, noticeLabel, resolveTaskNotice } from './conversation-task-notices.js'
const h = React.createElement
const empty = { items:[], next_cursor:null, unavailable:false }
export function ConversationTaskNotices({team,scopeKey,onOpen,request=requestCollabRead,resolve=resolveTaskNotice}) {
  const [state,setState]=React.useState({...empty,loading:true,error:''}),[after,setAfter]=React.useState(''),[refresh,setRefresh]=React.useState(0)
  const [opening,setOpening]=React.useState(null),navigation=React.useRef(null)
  React.useEffect(()=>{
    let closed=false
    const clear=()=>{navigation.current?.abort();navigation.current=null;setOpening(null);setState({...empty,loading:true,error:''})}
    const hide=()=>{if(document.visibilityState==='hidden')clear()}
    document.addEventListener('visibilitychange',hide)
    const stop=visibleRefresh({delay:15000,refresh:async signal=>{
      clear()
      try {
        const query=new URLSearchParams({conversation_id:team.conversation_id,view:'task-notices',...(after?{after}:{})})
        const result=validateTaskNotices(team,await request('/api/kode/conversation/messages?'+query,{signal}),after)
        if(!closed&&!signal.aborted)setState({...result,loading:false,error:''})
      }catch{if(!closed&&!signal.aborted)setState({...empty,loading:false,error:'无法核对频道任务，旧提醒已隐藏。请刷新重试。'})}
    }})
    return()=>{closed=true;stop();navigation.current?.abort();document.removeEventListener('visibilitychange',hide)}
  },[team.home_hub,team.id,team.conversation_id,team.revision,scopeKey,after,refresh,request])
  const open=async row=>{
    navigation.current?.abort();const controller=new AbortController();navigation.current=controller;setOpening(row.task_id)
    try {const target=await resolve(team,row,{signal:controller.signal,request});if(!controller.signal.aborted&&target)onOpen(target)}
    catch{if(!controller.signal.aborted)setState({...empty,loading:false,error:'任务或访问范围已变化，未打开任何频道。请刷新核对。'})}
    finally{if(navigation.current===controller){navigation.current=null;setOpening(null)}}
  }
  const terminal=row=>['completed','failed','cancelled'].includes(row.state)
  const renderRow=row=>h('li',{key:row.task_id,'data-task-notice':row.task_id},h('span',null,
    h('span',null,row.title,row.title_truncated?'…':''),h('small',{title:`工作区：${row.scope.root_ref}（${row.scope.workspace_id}）\n任务：${row.task_id}`},`${noticeLabel(row)} · #${row.channel_title}`)),
    h(Button,{disabled:opening!==null,onClick:()=>void open(row),'aria-label':`回频道查看 ${row.title}`},opening===row.task_id?'核对访问…':'回频道查看'))
  const results=state.items.filter(terminal)
  if(!state.loading&&!state.error&&!state.items.length&&!after)return null
  return h('section',{className:'kode-conversation-task-notices','aria-label':'频道任务提醒'},
    h('style',null,`.kode-conversation-task-notices{flex:none;max-height:26dvh;overflow:auto;padding:10px 24px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:13px;overflow-wrap:anywhere}.kode-conversation-task-notices header,.kode-conversation-task-notices li{display:flex;align-items:center;justify-content:space-between;gap:12px}.kode-conversation-task-notices header{flex-wrap:wrap}.kode-conversation-task-notices ul{list-style:none;margin:6px 0;padding:0}.kode-conversation-task-notices li{padding:8px 0}.kode-conversation-task-notices li>span{min-width:0;display:grid;gap:4px}.kode-conversation-task-notices small,.kode-conversation-task-notices p{color:var(--dsw-alias-label-secondary)}.kode-conversation-task-notices p{margin:6px 0}.kode-conversation-task-notices button{flex:none}.kode-conversation-task-notices nav{display:flex;gap:8px;flex-wrap:wrap}@media(max-width:600px){.kode-conversation-task-notices{padding:10px 16px}.kode-conversation-task-notices li{align-items:flex-start;flex-direction:column}}`),
    h('style',null,'.kode-conversation-task-notices{box-sizing:border-box}'),
    h('header',null,h('strong',null,'频道任务提醒'),state.error&&h(Button,{variant:'text',disabled:state.loading,onClick:()=>setRefresh(value=>value+1)},'重试')),
    state.loading?h('p',{role:'status'},'正在核对频道任务…'):state.error?h('p',{role:'status'},state.error):h(React.Fragment,null,
      !state.items.length&&h('p',null,'本页暂无待处理问题或任务结果。'),
      h('ul',null,...state.items.filter(row=>!terminal(row)).map(renderRow)),
      results.length>0&&h('details',null,h('summary',null,`本页已结束任务（${results.length}）`),h('ul',null,...results.map(renderRow))),
      state.unavailable&&h('p',{role:'status'},'部分任务的访问范围已变化，相关内容已隐藏。'),
      state.items.length>0&&h('p',null,'问题与结果留在原频道；这里的私信不会自动代答。')),
    h('nav',{'aria-label':'任务提醒分页'},after&&h(Button,{disabled:state.loading,onClick:()=>setAfter('')},'返回第一页'),
      state.next_cursor&&h(Button,{disabled:state.loading,onClick:()=>setAfter(state.next_cursor)},'还有更多，查看下一页')))
}
