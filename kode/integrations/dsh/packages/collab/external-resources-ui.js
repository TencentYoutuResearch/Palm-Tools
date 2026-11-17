/** A read surface, not another app installer, credential store, or task composer. */
import React from 'react'
import {Button} from '@deepseek-ai/dsh-client-ui-primitives'
import {Icon,IconButton} from './icons.js'
import {workspaceScopeKey} from './workspace-scope.js'
import {createExternalResourcesModel,externalResourceLink,externalResourceNotice,RESOURCE_PROVIDERS,RESOURCE_KINDS} from './external-resources-model.js'
const h=React.createElement
function BindingConditions({onPluginManagement}) {
  const reasonId=React.useId()
  return h('details',{className:'kode-external-binding-conditions'},
    h('summary',null,'TAPD / 工蜂绑定 · 查看条件'),
    h('p',{id:reasonId,className:'kode-config-note'},'当前没有可用于新建绑定的授权连接目录，暂不能新建绑定或发起首次同步。'),
    h('p',{className:'kode-config-note'},'绑定需要现有插件提供已授权的 TAPD 项目或工蜂仓库，并关联当前工作区及指定频道。',onPluginManagement?'可通过上方「管理插件」查看插件；':'','安装或启用插件不等于项目授权。'),
    h('div',{className:'kode-external-resources-actions'},
      h(Button,{type:'button',variant:'outline',disabled:true,'aria-describedby':reasonId},'新建绑定'),
      h(Button,{type:'button',variant:'outline',disabled:true,'aria-describedby':reasonId},'首次同步')))
}
function ResourceCard({card}) {
  const link=externalResourceLink(card.url,card.source)
  return h('article',{className:'kode-external-resource','data-origin':'external','data-trusted-instruction':'false','data-resource-id':card.id},
    h('div',{className:'kode-external-resource-meta'},h('span',null,RESOURCE_PROVIDERS[card.source.provider]),h('span',null,RESOURCE_KINDS[card.kind]),h('span',null,`#${card.id}`),card.native_state&&h('span',null,card.native_state)),
    h('h3',null,card.title||'无标题资源'),
    h('p',{className:'kode-external-resource-byline'},card.author?`作者：${card.author}`:'作者未提供',card.updated_at?` · 来源更新时间：${card.updated_at}`:''),
    card.body&&h('details',null,h('summary',null,'查看原文'),h('p',{className:'kode-external-resource-body'},card.body)),
    link?h('a',{href:link,target:'_blank',rel:'noopener noreferrer',referrerPolicy:'no-referrer','aria-label':`打开原资源：${card.title||card.id}`},'打开原资源')
      :h('span',{className:'kode-external-resource-byline'},'暂无可验证的原资源链接'))
}
function SourceObservation({observation}) {
  if(!observation)return h('p',{className:'kode-external-resource-byline','data-source-coverage':'unknown'},'来源覆盖与最近成功读取时间：未知。现有缓存没有可确认的读取记录，不能据此判断外部资源是否完整。')
  return h('div',{className:'kode-external-source-observation','data-source-coverage':observation.mode},
    h('p',{className:'kode-external-resource-byline'},'来源覆盖：单页快照 · ',RESOURCE_KINDS[observation.kind],
      observation.parent?`（${RESOURCE_KINDS[observation.parent.kind]} #${observation.parent.id}）`:'',
      ` · 第 ${observation.observed_page} 页 · 请求上限 ${observation.requested_limit} 条 · 来源返回 ${observation.observed_count} 条 · 后续页：未知`),
    h('p',{className:'kode-external-resource-byline'},'最近一次成功读取：',h('time',{dateTime:observation.read_at},observation.read_at)),
    h('p',{className:'kode-external-resource-byline'},'此记录仅代表最近一次单页读取。缓存可能包含其他页、其他时间读取的旧记录，不代表同一时点的完整来源。未执行全量对账，未据此删除缺失记录。'))
}
export function ExternalResourcesPanel({model,onPluginManagement,SelectField}) {
  const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot)
  const scopeKey=workspaceScopeKey(state.scope)
  React.useEffect(()=>{
    let timer,closed=false
    const refresh=async()=>{clearTimeout(timer);if(closed||document.visibilityState==='hidden')return;await model.refresh();if(!closed)timer=setTimeout(refresh,30000)}
    const changed=()=>{clearTimeout(timer);if(document.visibilityState==='hidden')model.clear();else void refresh()}
    document.addEventListener('visibilitychange',changed)
    window.addEventListener('focus',changed)
    void refresh()
    return()=>{closed=true;clearTimeout(timer);document.removeEventListener('visibilitychange',changed);window.removeEventListener('focus',changed);model.clear()}
  },[model,scopeKey])
  const source=state.selected?.source
  const notice=externalResourceNotice(state)
  const bindingLabel=binding=>`${RESOURCE_PROVIDERS[binding.source.provider]} · ${binding.source.resource} · ${binding.surface_id}${binding.enabled?'':'（已停用）'}`
  const ready=state.status?.state==='ready'?'只读入口已就绪，外部服务健康尚未检查。'+(state.compatibility==='unverified-instance'?'此实例的接口兼容性尚未验证。':state.compatibility==='instance-validated'?'此实例的接口兼容性已验证。':''):''
  // Native settings hierarchy: one column, flat groups, native rows and SelectField.
  return h('section',{className:'kode-external-resources kode-settings-main','aria-label':'外部资源','data-phase':state.phase,'aria-busy':state.loading},
    h('style',null,externalResourcesStyles),
    h('div',{className:'kode-settings-page kode-external-resources-page'},
      h('header',{className:'kode-external-resources-header'},h('h2',null,'外部资源'),
        h('p',null,'当前工作区已缓存的 TAPD / 工蜂资源。只读快照：第三方正文不作为指令，不会自动创建任务、派发执行或写回。')),
      h('div',{className:'kode-settings-group','aria-label':'来源与连接'},
        h('h3',{className:'kode-settings-group-title'},'来源与连接'),
        state.scope&&h('div',{className:'kode-integration-row kode-external-scope'},
          h('span',null,h('strong',null,'工作区 ',state.scope.workspace_id),
            h('span',{className:'kode-config-note'},'Host / Home：',state.scope.host_id,' / ',state.scope.home_hub),
            h('span',{className:'kode-config-note'},'根目录：',state.scope.root_ref))),
        h('div',{className:'kode-integration-row'},
          h('span',null,h('strong',null,'插件与授权连接'),h('span',{className:'kode-config-note'},'资源来自现有插件提供的已授权项目或仓库，这里不另建连接或保存凭据。')),
          onPluginManagement&&h(Button,{type:'button',variant:'outline',onClick:onPluginManagement},'管理插件')),
        h(BindingConditions,{onPluginManagement})),
      h('div',{className:'kode-settings-group','aria-label':'资源快照'},
        h('h3',{className:'kode-settings-group-title'},'资源快照'),
        h('div',{className:'kode-integration-row'},
          h('span',null,h('strong',null,'本地快照'),h('span',{className:'kode-config-note'},ready||'读取本机缓存的快照并核对访问权限；页面可见时每 30 秒自动核对一次。')),
          h(IconButton,{icon:'refresh',label:state.loading?'正在核对快照…':'刷新本地快照',disabled:state.loading,onClick:()=>void model.refresh()})),
        state.bindings.length>0&&(SelectField
          ? h('div',{className:'kode-settings-scope kode-external-binding-field'},h(SelectField,{label:'资源绑定',value:state.selected?.id??'',disabled:state.loading,
            options:[...(!state.selected?[{value:'',label:'选择资源绑定'}]:[]),...state.bindings.map(binding=>({value:binding.id,label:bindingLabel(binding)}))],onChange:id=>{if(id)void model.select(id)}}))
          : h('label',{className:'kode-external-binding-label'},'资源绑定',h('select',{'aria-label':'资源绑定',value:state.selected?.id??'',disabled:state.loading,onChange:event=>void model.select(event.target.value)},
            !state.selected&&h('option',{value:'',disabled:true},'选择资源绑定'),...state.bindings.map(binding=>h('option',{key:binding.id,value:binding.id},bindingLabel(binding)))))),
        source&&h('p',{className:'kode-external-source kode-config-note'},'来源：',source.instance,' · ',source.resource),
        source&&!state.loading&&['ready','empty'].includes(state.phase)&&h(SourceObservation,{observation:state.last_sync}),
        state.loading&&h('p',{role:'status',className:'kode-external-notice'},'正在核对当前工作区的本地快照与访问权限…'),
        notice&&h('p',{role:'status',className:'kode-external-notice'},notice),
        h('div',{className:'kode-external-resource-list'},...state.items.map(card=>h(ResourceCard,{key:card.key,card}))),
        state.more&&h(Button,{type:'button',variant:'outline',className:'kode-external-more',disabled:state.loading,onClick:()=>void model.more()},'继续显示本地快照'),
        source&&['ready','empty'].includes(state.phase)&&!state.more&&h('p',{className:'kode-external-resource-byline'},'本地快照已显示。此处的分页结束不代表外部来源已全部读取。'))))
}
export function installExternalResources(ctx,{request}={}) {
  const model=createExternalResourcesModel({request})
  // The native DSH plugins panel and the Kode SelectField; nothing here installs or connects apps.
  function Main(){return h(ExternalResourcesPanel,{model,SelectField:ctx.get?.('kodeAgentControls')?.SelectField,onPluginManagement:()=>ctx.layout.selectPanel('plugins')})}
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'kode-external-resources'},Main))
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:'kode-external-resources',order:45,label:'外部资源'},({size})=>h(Icon,{name:'process',size})))
  return model
}
export const externalResourcesStyles=`
.kode-external-resources{height:100%;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:22px;scrollbar-width:thin}
.kode-external-resources-page{display:flex;flex-direction:column;gap:0}
.kode-external-resources-header{padding:4px 0 20px}.kode-external-resources-header h2{margin:0;font-size:16px;font-weight:600;line-height:24px}.kode-external-resources-header p{margin:4px 0 0;max-width:75ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-external-scope strong{overflow-wrap:anywhere}.kode-external-scope .kode-config-note{overflow-wrap:anywhere}
.kode-external-resources-actions{display:flex;gap:8px;flex-wrap:wrap}
.kode-external-binding-conditions{padding:12px 0 16px;font-size:13px;line-height:20px;overflow-wrap:anywhere}.kode-external-binding-conditions summary{cursor:pointer;min-height:28px;width:fit-content;align-content:center;font-weight:500}.kode-external-binding-conditions p{margin:8px 0;max-width:75ch}
.kode-external-binding-field{margin:0}.kode-external-binding-label{display:flex;flex-direction:column;gap:6px}.kode-external-binding-label select{min-width:0;max-width:100%;padding:8px 10px;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font:inherit}
.kode-external-source{margin:0;overflow-wrap:anywhere}.kode-external-source-observation p{max-width:85ch}
.kode-external-notice{margin:8px 0;padding:16px 0;max-width:70ch;color:var(--dsw-alias-label-secondary)}
.kode-external-resource{padding:20px 0;border-top:1px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere}
.kode-external-resource h3{margin:8px 0;font-size:15px;font-weight:600;line-height:24px;max-width:75ch}.kode-external-resource-meta{display:flex;gap:6px 12px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.kode-external-resource-meta>span:first-child{font-weight:500;color:var(--dsw-alias-label-primary)}
.kode-external-resource-byline{font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:8px 0}.kode-external-resource details{margin:12px 0;font-size:13px}.kode-external-resource summary{cursor:pointer;width:fit-content;min-height:28px}.kode-external-resource-body{white-space:pre-wrap;max-width:75ch;margin:10px 0 18px;unicode-bidi:plaintext;font-size:14px;line-height:22px}
.kode-external-resource a{font-size:13px;color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:3px}.kode-external-resource a:hover{opacity:.8}.kode-external-resources :is(a,summary):focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:3px}.kode-external-more{align-self:flex-start;margin:16px 0}
@media(max-width:600px){.kode-external-resources .kode-integration-row{flex-direction:column;align-items:stretch;gap:10px}.kode-external-resources .kode-integration-row>button{align-self:flex-start}}
`
