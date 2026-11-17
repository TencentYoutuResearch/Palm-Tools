/** Project resources contribute to the existing DSH conversation.view tab row. */
import React from 'react'
import {workspaceScopeKey} from './workspace-scope.js'
import {requestExternalResources,validateExternalBindings,validateChannelProject,externalResourceLink,validateExternalCards,EXTERNAL_RESOURCE_PAGE_SIZE,enabledResourceTabs} from './external-resources-model.js'
const h=React.createElement
const providers=[['tapd','TAPD'],['gongfeng','工蜂 Git']]
const EMPTY=Object.freeze([])
const scopeFields=['home_hub','host_id','workspace_id','root_ref']
export function uniqueResourceScope(sessionId,workspaces,scopes){
  if(typeof sessionId!=='string'||workspaces?.phase!=='ready')return null
  const rows=(workspaces.items??[]).filter(row=>row.sessionIds?.includes(sessionId))
  if(rows.length!==1)return null
  const matches=scopes.filter(scope=>scope.rowId===rows[0].workspaceId&&scope.root_ref===rows[0].path&&workspaceScopeKey(scope))
  if(matches.length!==1)return null
  return Object.fromEntries(scopeFields.map(field=>[field,matches[0][field]]))
}
export function selectSessionBindings(bindings,provider){
  return bindings.filter(binding=>binding.enabled&&binding.source.provider===provider)
}
export const channelResourceTabs=bindings=>enabledResourceTabs(bindings,providers)
export function installProjectResourceSessionTabs(ctx,{catalogue,request=requestExternalResources}){
  const sessions=new Map()
  const lookup = id=>sessions.get(id)?.bindings??EMPTY
  const refresh=(id,row,force=false)=>{
    const current=catalogue.getSnapshot()
    const scope=current.ready?uniqueResourceScope(id,current.native,current.scopes):null
    const key=workspaceScopeKey(scope)
    if(!force&&key===row.key)return
    row.abort?.abort()
    const controller=new AbortController()
    row.key=key;row.abort=controller
    const update=value=>{row.bindings=value;for(const listener of row.listeners.keys())listener()}
    if(row.bindings.length)update(EMPTY)
    if(!scope)return
    void request('bindings',scope,{signal:controller.signal}).then(payload=>{
      if(controller.signal.aborted)return
      update(validateExternalBindings(payload,scope))
    }).catch(()=>{})
  }
  const subscribe=(id,listener)=>{
    let row=sessions.get(id)
    if(!row){
      row={key:null,bindings:EMPTY,listeners:new Map()}
      sessions.set(id,row)
      row.unsubscribe=catalogue.subscribe(()=>refresh(id,row))
      const poll=()=>refresh(id,row,true)
      row.timer=setInterval(poll,30000)
    }
    row.listeners.set(listener,(row.listeners.get(listener)??0)+1)
    refresh(id,row)
    return ()=>{
      const count=row.listeners.get(listener)??0
      if(count>1)row.listeners.set(listener,count-1);else row.listeners.delete(listener)
      if(row.listeners.size)return
      row.abort?.abort();row.unsubscribe();clearInterval(row.timer);sessions.delete(id)
    }
  }
  for(const [provider,label] of providers){
    function ResourceView({sessionId}){
      const subscribeSession=React.useCallback(listener=>subscribe(sessionId,listener),[sessionId])
      const snapshot=React.useCallback(()=>lookup(sessionId),[sessionId])
      const all=React.useSyncExternalStore(subscribeSession,snapshot)
      const bindings=selectSessionBindings(all,provider)
      const [bindingId,choose]=React.useState(null)
      const binding=bindings.find(row=>row.id===bindingId)??bindings[0]
      const [result,setResult]=React.useState(null)
      React.useEffect(()=>{
        if(!binding)return
        const controller=new AbortController()
        setResult(null)
        void request('cards',{binding:binding.id,after:'0',limit:String(EXTERNAL_RESOURCE_PAGE_SIZE)},{signal:controller.signal}).then(value=>{
          if(!controller.signal.aborted)setResult({binding,cards:validateExternalCards(value,binding).items})
        }).catch(()=>{if(!controller.signal.aborted)setResult({binding,error:true})})
        return()=>controller.abort()
      },[binding])
      if(!binding)return null
      const show=result?.binding===binding?result:null
      return h('section',{'aria-label':label},
        bindings.length>1&&h('label',null,'当前项目资源 ',h('select',{value:binding.id,onChange:e=>choose(e.currentTarget.value)},bindings.map(row=>h('option',{key:row.id,value:row.id},row.source.resource)))),
        h('p',null,'只读快照 · ',binding.source.resource),
        !show?h('p',{role:'status'},'正在核验项目绑定…'):show.error?h('p',{role:'status'},'资源暂不可用，未显示缓存内容。'):show.cards.length===0?h('p',{role:'status'},'当前绑定暂无快照。'):h('ul',null,show.cards.map(card=>{
          const url=externalResourceLink(card.url,card.source)
          return h('li',{key:card.key},url?h('a',{href:url,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'},card.title||card.id):(card.title||card.id))
        })))
    }
    ctx.slots.inject('conversation.view',()=>ctx.slots.register({
      name:'conversation.view',id:'kode-resource-'+provider,label,order:provider==='tapd'?40:41,
      kodeVisibleForSession:sessionId=>lookup(sessionId).some(row=>row.enabled&&row.source.provider===provider),
      kodeVisibilitySubscribe:subscribe,inject:sessionId=>({sessionId}),
    },ResourceView))
  }
}

/** Uses DSH's original renderer without conflating a channel with a Session. */
export function ChannelProjectResources({scope,surface,TabList,children,renderSettings,request=requestExternalResources}){
  const [bindings,setBindings]=React.useState(EMPTY)
  const [selected,select]=React.useState('discussion')
  const [response,show]=React.useState(null)
  const key=workspaceScopeKey(scope)
  const surfaceId=surface?.id
  React.useEffect(()=>{
    if(!TabList||!key||surface.kind!=='channel'||surface.enabled!==true)return
    let controller,timer,closed=false
    async function refresh(){
      controller=new AbortController()
      const signal=controller.signal
      try {
        const value=await request('project',{...Object.fromEntries(scopeFields.map(field=>[field,scope[field]])),surface_id:surfaceId},{signal})
        if(!closed)setBindings(validateChannelProject(value,scope,surfaceId))
      } catch {
        if(!closed)setBindings(EMPTY)
      }
      if(!closed)timer=setTimeout(refresh,30000)
    }
    void refresh()
    return()=>{closed=true;controller?.abort();clearTimeout(timer)}
  },[TabList,key,surfaceId,surface?.kind,surface?.enabled,request])
 const tabs=channelResourceTabs(bindings)
 const active=[...tabs.map(([id])=>id),'settings'].includes(selected)?selected:'discussion'
  const binding=selectSessionBindings(bindings,active)[0]
  React.useEffect(()=>{
    if(!binding)return
    const controller=new AbortController(),signal=controller.signal
    void request('cards',{binding:binding.id,after:'0',limit:String(EXTERNAL_RESOURCE_PAGE_SIZE)},{signal}).then(value=>{
      if(!signal.aborted)show({binding,items:validateExternalCards(value,binding).items})
    }).catch(()=>{if(!signal.aborted)show({binding,error:true})})
    return()=>controller.abort()
  },[binding,request])
  if(!TabList)return children
  const ready=response?.binding===binding?response:null
  return h(React.Fragment,null,
    h('div',{className:'kode-discussion-view-tabs'},h(TabList,{tabs:[{id:'discussion',label:'讨论'},...tabs.map(([id,label])=>({id,label})),{id:'settings',label:'设置'}],value:active,onSelect:select})),
    active==='discussion'?children:active==='settings'?h('section',{className:'kode-discussion-messages kode-discussion-settings','aria-label':'频道设置'},renderSettings?.(bindings)??h('p',null,'暂无频道设置。')):h('section',{className:'kode-discussion-messages','aria-label':tabs.find(([id])=>id===active)[1]},h('div',{className:'kode-discussion-reading-column'},
      !binding?h('p',null,'尚未关联此项目资源。请先在频道设置中核对关联团队与外部集成。'):h(React.Fragment,null,h('p',null,'项目资源 · 只读快照'),
      !ready?h('p',{role:'status'},'正在核验项目资源…'):
        ready.error?h('p',{role:'status'},'资源暂不可用，未显示缓存内容。'):
        ready.items.length===0?h('p',{role:'status'},'当前绑定暂无快照。'):
        h('ul',null,ready.items.map(card=>{
          const url=externalResourceLink(card.url,card.source)
          return h('li',{key:card.key},url?h('a',{href:url,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer'},card.title||card.id):(card.title||card.id))
        }))))))
}
