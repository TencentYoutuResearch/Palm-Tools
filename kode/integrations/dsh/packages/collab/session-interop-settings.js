import React from 'react'
import { IconButton } from './icons.js'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { requestSessionInterop, parseInteropSnapshot, validateInteropSettings } from './session-interop-settings-model.js'
const h = React.createElement
export function SessionInteropSettings({ request = requestSessionInterop }) {
  const [settings,setSettings]=React.useState(null),[profiles,setProfiles]=React.useState([]),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[generation,reload]=React.useState(0),[blocked,setBlocked]=React.useState(false)
  React.useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');request(undefined,{signal:controller.signal}).then(value=>{if(controller.signal.aborted)return;const next=parseInteropSnapshot(value);setSettings(next.settings);setProfiles(next.profiles)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)});return()=>controller.abort()},[request,generation])
  const change=next=>{setSettings(next);setNotice('')}
  const save=async()=>{setNotice('');let next;try{next=validateInteropSettings(settings,profiles)}catch(e){setError(e.message);return}setBusy(true);setError('');try{await request(next);setNotice('已保存到本机。')}catch(e){setError(e.message);if(e.status===401||e.status===403)setBlocked(true)}finally{setBusy(false)}}
  const summary=settings?.summary,profile=profiles.find(row=>row.id===summary?.profile_id)
  const updateSummary=patch=>change({...settings,summary:{...summary,...patch}})
  const updateGrant=(index,patch)=>change({...settings,grants:settings.grants.map((row,i)=>i===index?{...row,...patch}:row)})
  return h('section',{'aria-label':'本机会话互通',className:'kode-agent-editor'},h('h3',null,'本机会话互通'),
    h('p',null,'仅保存于此电脑，不同步到 Hub 或远端。默认关闭摘要，默认不授权跨会话访问。'),
    h('p',{className:'kode-config-note'},'对话摘要默认关闭。开启后，需要摘要时只把会话中可见的 user / assistant 对话文字发送给下面所选的模型；不发送工具调用记录、工具结果或隐藏的系统记录。'),
    error&&h('p',{role:'alert'},error),notice&&h('p',{role:'status'},notice),
    settings===null?h('div',null,h('p',{role:'status'},busy?'正在加载本机设置…':'尚未加载本机设置。'),h(IconButton,{icon:'refresh',label:'重新加载本机设置',disabled:busy,onClick:()=>reload(n=>n+1)})):
    h('fieldset',{disabled:busy||blocked,style:{border:0,padding:0,display:'grid',gap:10}},
      h('label',null,h('input',{type:'checkbox',checked:summary!==null,onChange:e=>change({...settings,summary:e.target.checked?{profile_id:'',model:''}:null})}),'对话摘要'),
      summary!==null&&h(React.Fragment,null,
        h('label',null,'摘要配置',h('select',{'aria-label':'摘要配置',value:summary.profile_id,onChange:e=>{const p=profiles.find(row=>row.id===e.target.value);change({...settings,summary:{profile_id:e.target.value,model:p?.models[0]||''}})}},h('option',{value:''},'请选择'),...profiles.map(row=>h('option',{key:row.id,value:row.id},row.name)))),
        h('label',null,'摘要模型',h('select',{'aria-label':'摘要模型',value:summary.model,onChange:e=>updateSummary({model:e.target.value})},h('option',{value:''},'请选择'),...(profile?.models??[]).map(model=>h('option',{key:model,value:model},model)))),
        h('label',null,'推理强度',h('select',{'aria-label':'推理强度',value:summary.reasoningEffort||'',onChange:e=>updateSummary({reasoningEffort:e.target.value})},h('option',{value:''},'配置默认值'),...(profile?.reasoningEfforts??[]).map(value=>h('option',{key:value,value},value)))),
        !profile&&h('p',{role:'status'},'请选择当前可用配置；不可用的旧配置不会被自动覆盖。'),profile&&profile.models.length===0&&h('p',{role:'status'},'此配置没有可用的摘要模型，请选择其他配置或关闭摘要。')),
      // Exact per-Session grants are an advanced owner tool, folded by default. Saved grants are kept
      // as they are; the backend still checks owner, scope and the exact Session pair on every access.
      h('details',{className:'kode-interop-grants'},h('summary',null,'高级 · 按会话精确授权',settings.grants.length?`（${settings.grants.length} 条）`:'（未授权）'),
      h('p',{className:'kode-config-note'},'默认不授权任何跨会话访问。只有在需要让一个会话读取另一个会话摘要或切换其模型时，才在这里按来源与目标会话 ID 精确授权。'),
      ...settings.grants.map((row,index)=>h('div',{key:index,style:{display:'grid',gap:6}},
        h('label',null,'来源会话 ID',h('input',{'aria-label':`来源会话 ID ${index+1}`,value:row.source,onChange:e=>updateGrant(index,{source:e.target.value})})),
        h('label',null,'目标会话 ID',h('input',{'aria-label':`目标会话 ID ${index+1}`,value:row.target,onChange:e=>updateGrant(index,{target:e.target.value})})),
        ...[['summary','读取摘要'],['model','切换会话模型'],['direct_insert','打断并直接插入（仅本机普通原生会话）']].map(([action,label])=>h('label',{key:action},h('input',{type:'checkbox',checked:row.actions.includes(action),onChange:e=>updateGrant(index,{actions:e.target.checked?[...row.actions,action]:row.actions.filter(item=>item!==action)})}),label)),
        h(Button,{variant:'outline',type:'button',onClick:()=>change({...settings,grants:settings.grants.filter((_,i)=>i!==index)})},`删除授权 ${index+1}`))),
      h(Button,{variant:'outline',type:'button',onClick:()=>change({...settings,grants:[...settings.grants,{source:'',target:'',actions:[]}]})},'添加精确会话授权')),
      h(Button,{variant:'primary',type:'button',onClick:save},busy?'正在保存…':'保存本机会话互通设置')))
}
