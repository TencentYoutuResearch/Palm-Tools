/** Public-data/public-interaction adapter for the sidebar.workspaces owner.
 * These are adaptation rows, not dsh's private SessionRow. The untouched native
 * browser stays mounted once for its full sorting, drag/drop and archive flows.
 * The caller owns registered canonical scopes, navigation and scoped drafts. */
import React from 'react'
import * as UI from '@deepseek-ai/dsh-client-ui-primitives'
import { Icon } from './icons.js'
import { ROW, LIST, nativeCss, nativeRowStyles, ProjectRow, ItemRow, RowAction, HoverText, OverflowButton, indent } from './native-rows.js'
import { SidebarSection, loadSections, saveSections } from './sidebar-sections.js'
import { validWorkspaceScope, workspaceScopeKey, sameWorkspace } from './workspace-scope.js'
const h=React.createElement
const {Tooltip,relativeTime,IconNewChatOutlineRegular,IconSettingsOutlineRegular,IconFlatListOutlineRegular,IconPlusOutlineRegular,IconFolderOpenRegular}=UI

/** Pure membership projection. Never mutate or replace either controller snapshot. */
export function scopedWorkspaceSessions(scopes, selected, workspaces, sessions) {
  const scope=scopes.find(value=>validWorkspaceScope(value)&&sameWorkspace(value,selected))
  if(!scope)return {phase:'unselected',scope:null,rows:[]}
  if(workspaces?.phase!=='ready'||sessions?.phase!=='ready')return {phase:'loading',scope,rows:[]}
  // rowId is the registered directory's exact UI/controller identity binding.
  // Never derive host identity from a workspace title, path prefix or Session cwd.
  const workspace=workspaces.items.find(value=>value.workspaceId===scope.rowId&&value.path===scope.root_ref)
  if(!workspace)return {phase:'missing',scope,rows:[]}
  const archived=new Set(workspaces.archivedSessionIds??[]),seen=new Set()
  const rows=[]
  for(const id of workspace.sessionIds??[]){
    if(seen.has(id))continue
    seen.add(id)
    const session=sessions.byId[id]
    if(session)rows.push({session,archived:archived.has(id)})
  }
  return {phase:'ready',scope,workspace,rows}
}

/** Append existing read-only Workers only to the selected owner's workspace UI. */
export function scopedManagedWorkerRows(scope, entries, existing = []) {
  if (!validWorkspaceScope(scope) || scope.home_hub !== scope.host_id) return []
  const seen = new Set(existing.map(row => row.session.id))
  return (entries ?? []).flatMap(entry => {
    const item = entry?.item, run = entry?.run
    if (!sameWorkspace(entry?.scope, scope) || entry.read_only !== true || !entry.id || seen.has(entry.id)
      || item?.worker?.session_id !== entry.id || item.worker.node_id !== scope.host_id || run?.home_hub !== scope.home_hub
      || !run.id || !run.team_id || !item.assignment_id || !item.operation?.id) return []
    seen.add(entry.id)
    return [{ session: { id: entry.id, title: entry.title, managedWorker: entry }, archived: false }]
  })
}
function ManagedWorkerRow({session,onOpenManagedSession}) {
  const [error,setError]=React.useState(''),[busy,setBusy]=React.useState(false)
  const entry=session.managedWorker
  const open=async()=>{if(busy||!onOpenManagedSession)return;setBusy(true);setError('');try{await onOpenManagedSession(entry.run,entry.item,{scope:entry.scope})}catch{setError('无法核对会话归属，请刷新后重试。')}finally{setBusy(false)}}
  return h(React.Fragment,null,h(ItemRow,{rowKey:'managed:'+session.id,kind:'managed-session','data-managed-session-id':session.id,label:'打开受管会话：'+session.title,
    leading:h(Icon,{name:'chat',size:16}),title:session.title,trailing:'受管只读',onOpen:()=>void open(),'aria-disabled':busy||!onOpenManagedSession||undefined}),
    error&&h('p',{role:'status',className:'kode-sidebar-empty',style:indent(2)},error))
}

function NativeRequests({useRequests,onRequest}) {
  const value=useRequests(state=>state),before=React.useRef({searchRequest:0,addRequested:false,renameTarget:null})
  React.useLayoutEffect(()=>{
    const old=before.current;before.current=value
    if((value.searchRequest??0)>(old.searchRequest??0)||value.addRequested&&!old.addRequested
      ||value.renameTarget&&value.renameTarget!==old.renameTarget)onRequest()
  },[value,onRequest])
  return null
}

const relative=(value,now=Date.now())=>{
  const at=typeof value==='number'?value:Date.parse(value);if(!Number.isFinite(at))return null
  const {unit,n}=relativeTime(at,now)
  return unit==='now'?'刚刚':`${n}${{minutes:'分钟',hours:'小时',days:'天',months:'个月',years:'年'}[unit]??''}`
}

/** The native sessionStatuses chain: a pending interaction first, live activity over a
 * completion reminder. `ongoing` is the native StateDot spinner. */
export function sessionStatuses({running,runningSubagentCount=0,pendingInteraction,completed}) {
  const subagents=runningSubagentCount>0?{state:'ongoing',label:`${runningSubagentCount} 个子智能体运行中`}:null
  const pending={approval:{state:'warning',label:'等待审批',trailingLabel:'待审批'},'plan-review':{state:'warning',label:'计划待审',trailingLabel:'计划待审'},question:{state:'warning',label:'等待回答',trailingLabel:'待回答'}}[pendingInteraction]
  const primary=pending??(running?{state:'ongoing',label:'进行中'}:subagents??(completed?{state:'done',label:'已完成'}:{state:'idle',label:'空闲'}))
  return subagents&&primary!==subagents?[primary,subagents]:[primary]
}
function StatusDots({statuses}) {
  return h(React.Fragment,null,h(UI.StateDot,{state:statuses[0].state}),statuses.map(status=>h('span',{key:status.label,className:ROW.visuallyHidden},status.label)))
}

/** A Session row with the native anatomy and the native row seats: leading status dot or
 * decoration, archive/pin row actions and the session menu (documented [open,setOpen] hook context). */
function SessionRow({session,archived,status,nativeProps,onManage,onOpenSession,currentSessionId}) {
  const title=session.displayTitle||session.title||'未命名会话'
  const owner={sessionId:session.id,displayTitle:session.displayTitle??session.title??''}
  const pendingInteraction=['approval','plan-review','question'].includes(status?.pendingInteraction?.kind)?status.pendingInteraction.kind:undefined
  const statuses=sessionStatuses({running:status?.running??session.running,runningSubagentCount:session.runningSubagentCount,pendingInteraction,completed:status?.completionUnread===true})
  const primary=statuses[0],shown=archived?statuses.filter(value=>value.state!=='done'&&value.state!=='idle'):statuses
  // With onOpenSession the caller shows the Session in place; otherwise the native open switches to session mode.
  const selected=onOpenSession?currentSessionId===session.id:(session.retainedBy?.mainView??0)>0
  const activate=()=>{if(archived){nativeProps.notifyArchivedNotOpenable?.();return}if(onOpenSession)onOpenSession(session.id);else nativeProps.open(session.id)}
  const slot=nativeProps.renderSlot
  const avatar=archived||session.blank?null:slot?.('sidebar.session.row.leading',{sessionId:session.id,useSessionStatus:nativeProps.useSessionStatus})
  return h(ItemRow,{rowKey:'session:'+session.id,kind:'session','data-adapted-session-id':session.id,'data-session-state':primary.state,label:`打开会话：${title}`,selected,archived,pinned:session.pinned,
    'aria-disabled':archived||undefined,onOpen:activate,title,
    leading:avatar??(!archived&&!session.blank&&primary.state!=='idle'?h(StatusDots,{statuses}):null),
    trailing:session.blank?null:primary.trailingLabel??relative(session.updatedAt),trailingLabel:primary.trailingLabel?primary.label:undefined,
    hover:h('div',{className:ROW.hoverContent},h('div',{className:ROW.hoverTitle},title),archived&&h('div',{className:ROW.hoverPath},'已归档的会话不能直接打开。'),
      shown.filter(value=>value.state!=='idle').map(value=>h('div',{key:value.label,className:ROW.hoverStatus},h(UI.StateDot,{state:value.state}),h('span',null,value.label)))),copyText:title,
    menu:slot?{label:`会话操作：${title}`,render:state=>slot('sidebar.workspaces.session.menu.item',owner,{hookContext:state})}:{label:`会话操作：${title}`,items:[{id:'manage',label:'在会话模式中管理'}],onSelect:onManage},
    actions:slot?slot('sidebar.workspaces.session.row.action',owner):null})
}

/** Native watermark paging: five rows at a time, raised to keep every running, waiting,
 * unread-completed or current row (within the first 50) visible; "收起" drops back. */
export const SESSION_PAGE=5
const AUTO_MAX=50
export function sessionWatermark(rows,{statuses,currentSessionId}={}) {
  let index=0,required=0
  for(const {session} of rows){
    if(session.blank)continue
    index+=1
    const status=statuses?.get?.(session.id)
    if(index<=AUTO_MAX&&((status?.running??session.running)||session.runningSubagentCount>0||status?.pendingInteraction||status?.completionUnread===true||session.id===currentSessionId))required=index
  }
  return Math.max(SESSION_PAGE,required)
}
export function pageRows(rows,watermark) {
  let count=0
  const visible=rows.filter(({session})=>session.blank||++count<=watermark)
  return {rows:visible,hiddenCount:rows.length-visible.length}
}
function SessionRows({rows,nativeProps,onManage,statuses,onOpenManagedSession,onOpenSession,currentSessionId}) {
  const [extra,setExtra]=React.useState(null)
  const baseline=sessionWatermark(rows,{statuses,currentSessionId})
  const watermark=Math.max(baseline,extra??0)
  const collapsed=pageRows(rows,baseline),visible=pageRows(rows,watermark),expanded=visible.hiddenCount===0
  return h(React.Fragment,null,
    visible.rows.map(row=>row.session.managedWorker?h(ManagedWorkerRow,{key:row.session.id,...row,onOpenManagedSession}):h(SessionRow,{key:row.session.id,...row,status:statuses?.get(row.session.id),nativeProps,onManage,onOpenSession,currentSessionId})),
    collapsed.hiddenCount>0&&h(OverflowButton,{expanded,onClick:()=>expanded?setExtra(null):setExtra(visible.hiddenCount<=SESSION_PAGE?Infinity:watermark+SESSION_PAGE)},
      expanded?'收起':`展开其余 ${visible.hiddenCount} 个会话`))
}
function SessionRowsWithStatus(props) {
  const statuses=props.nativeProps.useSessionStatus(value=>value)
  return h(SessionRows,{...props,statuses})
}

function ScopedContent({scope,current,projection,nativeProps,renderChannels,renderChannelSection,renderDirect,renderDirectSection,storage,onManage,onOpenManagedSession,onOpenSession,currentSessionId}) {
  const key='kode.collab.scoped-sidebar.sections.v1:'+workspaceScopeKey(scope)
  const [sections,setSections]=React.useState(()=>loadSections(storage,key))
  const toggle=(open,id)=>setSections(value=>{const next={...value,[id]:open};saveSections(storage,next,key);return next})
  const title=scope.title||scope.workspace_id
  return h('div',{className:'kode-scoped-content','data-workspace-scope':workspaceScopeKey(scope),'data-current-workspace-scope':current?workspaceScopeKey(scope):undefined},
    renderChannelSection?renderChannelSection(scope,{id:'channels',label:'频道',icon:'channel',open:sections.channels,onToggle:toggle}):h(SidebarSection,{id:'channels',label:'频道',icon:'channel',open:sections.channels,onToggle:toggle},renderChannels?.(scope)??h('p',{className:'kode-sidebar-empty',style:indent(2)},'暂无工作区频道。')),
    renderDirectSection?renderDirectSection(scope,{id:'direct',label:'私信',icon:'users',open:sections.direct,onToggle:toggle}):h(SidebarSection,{id:'direct',label:'私信',icon:'users',open:sections.direct,onToggle:toggle},renderDirect?.(scope)??h('p',{className:'kode-sidebar-empty',style:indent(2)},'暂无工作区私信。')),
    h(SidebarSection,{id:'sessions',label:'会话',icon:'session',open:sections.sessions,onToggle:toggle,
      actions:projection.phase==='ready'&&h(RowAction,{label:`在“${title}”中新建会话`,onClick:()=>nativeProps.startSession(scope.rowId)},h(IconNewChatOutlineRegular,null))},
      projection.phase==='loading'&&h('p',{role:'status',className:'kode-sidebar-empty',style:indent(2)},'正在读取工作区会话…'),
      projection.phase==='missing'&&h('p',{role:'status',className:'kode-sidebar-empty',style:indent(2)},'该工作区暂不可用，请在会话模式中检查。'),
      projection.phase==='ready'&&projection.rows.length===0&&h('p',{className:'kode-sidebar-empty',style:indent(2)},'还没有会话。'),
      h(nativeProps.useSessionStatus?SessionRowsWithStatus:SessionRows,{rows:projection.rows,nativeProps,onManage,onOpenManagedSession,onOpenSession,currentSessionId})))
}

const EXPANDED_KEY='kode.collab.projects.expanded.v1'
function loadExpanded(storage){try{const value=JSON.parse(storage?.getItem(EXPANDED_KEY)??'null');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return {}}}

/** One registered workspace as a project: the native project row and, when expanded, its
 * 频道/私信/会话 groups. Folding is a local UI preference; nothing is selected by it. */
function ProjectGroup({scope,current,expanded,onToggle,workspaces,sessions,ownerManagedSessions,onFocus,onOpenProjectSettings,onSelectMode,...content}) {
  const base=scopedWorkspaceSessions([scope],scope,workspaces,sessions)
  const projection=base.phase==='ready'?{...base,rows:[...base.rows,...scopedManagedWorkerRows(base.scope,current?ownerManagedSessions:[],base.rows)]}:base
  const title=scope.title||scope.workspace_id,key=workspaceScopeKey(scope)
  return h('div',{className:LIST.groupSection,'data-project-scope':key},
    h(ProjectRow,{rowKey:'workspace:'+key,label:title,expanded,active:current,onToggle,'aria-label':`项目：${title}`,'aria-current':current?'true':undefined,
      hover:h(HoverText,{title,detail:`${scope.host_id} · ${scope.root_ref}`}),copyText:scope.root_ref,
      menu:{label:`项目操作：${title}`,items:[{id:'settings',label:'协作设置',icon:h(IconSettingsOutlineRegular,null)},{id:'manage',label:'在会话模式中管理',icon:h(IconFlatListOutlineRegular,null)}],
        onSelect:id=>{if(id==='settings')onOpenProjectSettings?.(scope);else content.onManage()}},
      actions:projection.phase==='ready'&&h(RowAction,{label:`在“${title}”中新建会话`,onClick:()=>content.nativeProps.startSession(scope.rowId)},h(IconNewChatOutlineRegular,null))}),
    // A click inside another project makes it the current one before the row acts.
    expanded&&h('div',{role:'group','aria-label':title,onClickCapture:current?undefined:()=>onFocus(scope)},
      h(ScopedContent,{key,scope,current,projection,...content})))
}

/**
 * Caller renders this in the existing workspace slot entry, preserving that
 * entry's store, inject and declared child seats. nativeProps stays unfiltered.
 * renderSlot is the original owner renderer; never manufacture hook contexts
 * for any seat except the documented Session-menu [open,setOpen] pair.
 */
export function ScopedWorkspaceSidebar({native:NativeWorkspaces,nativeProps,scopes,selectedScope,onSelectScope,onFocusScope,onOpenProjectSettings,
  renderChannels,renderChannelSection,renderDirect,renderDirectSection,storage,onNativeManagerChange,mode,onSelectMode,ownerManagedSessions,onOpenManagedSession,onOpenSession,currentSessionId}) {
  const workspaces=nativeProps.useWorkspaces(value=>value),sessions=nativeProps.useSessions(value=>value)
  const registered=scopes.filter(value=>validWorkspaceScope(value)&&typeof value.rowId==='string'&&value.rowId.length>0)
  const [managing,setManaging]=React.useState(false),[expanded,setExpanded]=React.useState(()=>loadExpanded(storage))
  const showManager=React.useCallback(()=>{if(onSelectMode)onSelectMode('session');else setManaging(true)},[onSelectMode])
  // Rows use the loaded ui-workspace CSS modules. Until they are present, show the native manager and say why.
  const cssReady=React.useSyncExternalStore(nativeCss.subscribe,nativeCss.getSnapshot)
  React.useEffect(()=>{if(!cssReady)console.error('[kode-collab] ui-workspace 原生侧栏样式未加载，协作树暂以原生会话列表显示')},[cssReady])
  const nativeVisible=!cssReady||(mode?mode==='session':managing)
  React.useEffect(()=>{onNativeManagerChange?.(managing)},[managing,onNativeManagerChange])
  const selected=registered.find(scope=>sameWorkspace(scope,selectedScope))??null,selectedKey=workspaceScopeKey(selected)
  // The current project opens once by default; afterwards folding is the user's choice.
  const isOpen=key=>expanded[key]??key===selectedKey
  React.useEffect(()=>{if(selectedKey)setExpanded(value=>value[selectedKey]===undefined?{...value,[selectedKey]:true}:value)},[selectedKey])
  const toggle=key=>setExpanded(value=>{const next={...value,[key]:!isOpen(key)};try{storage?.setItem(EXPANDED_KEY,JSON.stringify(next))}catch{};return next})
  const focus=scope=>{if(!sameWorkspace(scope,selected))(onFocusScope??onSelectScope)(scope)}
  const shared={nativeProps,renderChannels,renderChannelSection,renderDirect,renderDirectSection,storage,onManage:showManager,onOpenManagedSession,
    onOpenSession,currentSessionId}
  return h('section',{className:'kode-scoped-workspace-sidebar','aria-label':'工作区','data-native-css':cssReady?'ready':'missing'},
    cssReady&&h('style',null,nativeRowStyles()+scopedWorkspaceSidebarStyles()),
    !cssReady&&h('p',{role:'alert',className:'kode-native-css-missing'},'协作侧栏的原生样式尚未加载，暂时显示原生会话列表。'),
    nativeProps.useWorkspaceShortcuts&&h(NativeRequests,{useRequests:nativeProps.useWorkspaceShortcuts,onRequest:showManager}),
    h('header',{className:LIST.sectionHeader+' kode-scoped-workspace-heading',hidden:nativeVisible&&!!mode,style:{display:nativeVisible&&mode||nativeProps.wide===false?'none':undefined}},
      h('span',{className:LIST.sectionLabel,style:{marginRight:'auto'}},'工作区'),
      h('span',{className:LIST.headerActions},
        h(Tooltip,{label:'添加工作区',delayMs:500,portal:true},h('button',{type:'button',className:LIST.iconButton,'aria-label':'添加工作区',
          onClick:()=>window.dispatchEvent(new CustomEvent('kode-create-project',{detail:{preserveOrbit:true}}))},h(IconPlusOutlineRegular,{size:14}))))),
    cssReady&&h('div',{className:'kode-native-tree kode-scoped-tree',role:'tree','aria-label':'项目',hidden:nativeVisible||nativeProps.wide===false,style:{display:nativeVisible||nativeProps.wide===false?'none':undefined}},
      registered.length?registered.map(scope=>{const key=workspaceScopeKey(scope),current=key===selectedKey
        return h(ProjectGroup,{key,scope,current,expanded:isOpen(key),onToggle:()=>toggle(key),workspaces,sessions,ownerManagedSessions,onFocus:focus,onOpenProjectSettings,onSelectMode,
          ...shared})})
        :h('p',{role:'status',className:'kode-sidebar-empty'},'暂无已登记工作区。',h('button',{type:'button',onClick:()=>window.dispatchEvent(new CustomEvent('kode-create-project',{detail:{preserveOrbit:true}}))},'添加工作区'))),
    h('div',{'aria-label':'原生会话管理',hidden:!nativeVisible,style:{display:nativeVisible?'flex':'none',flexDirection:'column',minHeight:0,flex:1,overflow:'hidden'}},
      h('span',{className:'kode-collab-sr-only'},'这里显示全部原生会话，提供排序、拖拽及归档管理。'),
      // Without a mode switch the caller has no other way back from the full manager.
      cssReady&&!mode&&h('header',{className:LIST.sectionHeader+' kode-scoped-workspace-heading'},h('span',{className:LIST.sectionLabel,style:{marginRight:'auto'}},'全部会话'),
        h('span',{className:LIST.headerActions},h(Tooltip,{label:'返回当前工作区',delayMs:500,portal:true},h('button',{type:'button',className:LIST.iconButton,'aria-label':'返回当前工作区',onClick:()=>setManaging(false)},h(IconFolderOpenRegular,{size:14}))))),
      h(NativeWorkspaces,nativeProps)))
}

export const scopedWorkspaceSidebarStyles=()=>`
.kode-scoped-workspace-sidebar{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);padding-right:var(--dsh-sidebar-inline-padding,12px)}
.kode-scoped-workspace-heading{padding-left:8px}
.kode-scoped-tree{flex:1;min-height:0;overflow-y:auto;padding-bottom:16px;margin-left:-4px;padding-left:4px}
.kode-scoped-tree>.${LIST.groupSection}+.${LIST.groupSection}{margin-top:4px}
.kode-scoped-tree .${LIST.groupSection}>*+*,.kode-scoped-content>*+*,.kode-sidebar-section-body>*+*{margin-top:2px}
.kode-sidebar-section-body:empty{display:none}
`
