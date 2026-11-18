import { BuilderControlsContext } from './builder-controls.js'
import { discussionProcessTarget, sessionProcessTarget, readProcessReturn } from './process-target.js'
import { ConversationQuestions } from './conversation-questions.js'
import { sameConversationTarget } from './conversation-target.js'
import { createUserAvatarStore, connectUserAvatar } from './user-avatar.js'
import { createUserAvatarComponents } from './user-avatar-view.js'
import { createCollaborationSettings } from './settings-view.js'
import {ModeSwitch} from './mode-switch.js'
import {teamPrimaryAction} from './team-primary-action.js'
import { installDiscussions } from './discussion-ui.js'
import { installProjectResourceSessionTabs } from './project-resource-session-tabs.js'
import { adaptSlotComponent } from './component-adapter.js'
import { MessageWindow } from './message-window.js'
import { visibleMessageStream } from './message-stream.js'
import { createConversationViews, conversationViewKey } from './conversation-views.js'
import { createNavigationStorage } from './navigation-storage.js'
import React from 'react'
import * as composerModule from '@kode/dsh-composer'
import { portableComposerSupport } from './portable-composer.js'
import { Input, Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { symbols } from '@deepseek-ai/cordis'
import { createCollabViewState } from './view-state.js'
import { createCollabData, requestCollabRead } from './data.js'
import { installCollabNavigation } from './navigation.js'
import { createOutboxStorage } from './outbox-storage.js'
import { createCollabOutbox, requestCollabMessage } from './outbox.js'
import { MessageDeliveryStatus, messageDeliveryStyles } from './message-delivery-status.js'
import { visibleRefresh } from './visible-refresh.js'
import { observeConversationRead } from './read-visibility.js'
import { SuperagentSettingsPanel, superagentSettingsStyles } from './superagent-settings-panel.js'
import { BuilderView, PlanningHostContext, BuilderDraftSettings, BuilderHomeSettings } from './builder-view.js'
import { usePlanningChoice } from './builder-planning-controls.js'
import { PLANNING_SLOT, PlanningConversationPanel } from './planning-session-embed.js'
import { OrbitSessionView } from './orbit-session-view.js'
import { resolveViewTabList } from './session-view-tabs.js'
import { ProcessView } from './process-view.js'
import { installManagedSessionUi } from './managed-session-ui.js'
import { styles } from './styles.js'
import { SidebarSection } from './sidebar-sections.js'
import { ItemRow, RowAction, PinArchiveActions, HoverText } from './native-rows.js'
import { useContactPreference } from './contact-preference-controls.js'
import {createWorkspaceContacts} from './workspace-contacts.js'
import {workspaceScopeKey,sameWorkspace,teamInWorkspace,teamProjectPointer,registeredWorkspaceScopes} from './workspace-scope.js'
import {ScopedWorkspaceSidebar} from './scoped-workspace-sidebar.js'
import { Icon, IconButton } from './icons.js'
import { installTeamSidebar, createScopeSource, useHostScope, teamScope, draftScope, builderScope, DraftScopeNote, TeamSidebarContext, TEAM_SIDEBAR_PANEL, MESSAGES_KIND, SETTINGS_KIND } from './team-sidebar.js'
const h = React.createElement
const PortableTextComposer = portableComposerSupport(composerModule)
const { useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore } = React
// Cordis enforces property access even for optional chaining. Declare the avatar
// account/locale dependencies as well as the visible layout services.
export const inject = ['slots', 'layout', 'uiWorkspace', 'conversation', 'kodeAppearance', 'kodeAgentControls', 'remote', 'remote.account', 'locale']
export function apply(ctx) {
  return ctx.inject(['kodeAppearance', 'kodeAgentControls'], scope => applyReady(scope))
}
function applyReady(ctx) {
  // Kode appears in the native DSH plugin list as @kode/dsh; no parallel Kode plugins tab.
  const appearance = ctx.get('kodeAppearance')
  let storage
  try { storage = window.localStorage } catch {}
  const userAvatars = createUserAvatarStore({storage,host:ctx.remote?.$host?.id??''})
  const {UserAvatar,UserAvatarSettings} = createUserAvatarComponents(userAvatars)
  const disconnectAvatar = connectUserAvatar(ctx,userAvatars)
  ctx.effect(()=>disconnectAvatar,'kode.collab.user-avatar')
  const messageHeights = new Map()
  const heightsFor = team => {
    const key = JSON.stringify([team.home_hub, team.id, team.conversation_id])
    if (!messageHeights.has(key)) messageHeights.set(key, new Map())
    return messageHeights.get(key)
  }
  const catalogueListeners=new Set()
  let workspaceCatalogue={ready:false,keys:[],scopes:[],native:null}
  const catalogueSource={getSnapshot:()=>workspaceCatalogue,subscribe:fn=>{catalogueListeners.add(fn);return()=>catalogueListeners.delete(fn)}}
  const publishCatalogue=(scopes,ready,native)=>{const keys=scopes.map(workspaceScopeKey);if(workspaceCatalogue.ready===ready&&workspaceCatalogue.native===native&&JSON.stringify(workspaceCatalogue.keys)===JSON.stringify(keys))return;workspaceCatalogue={ready,keys,scopes,native};for(const fn of catalogueListeners)fn()}
  let conversationViews, navigationStorage
  const view = createCollabViewState({ storage,
    onConversationChange: (id, value) => conversationViews?.update(id, value),
    onNavigationChange: value => { void navigationStorage?.save(value).catch(() => {}) } })
  const data = createCollabData({ request: requestCollabRead, contactDirectory: true, schedulePublish: requestAnimationFrame, cancelPublish: cancelAnimationFrame })
  let processReturn = null
  const openManagedSession = (run, item, source) => {
    const scope = source?.scope ?? view.getSnapshot().workspace
    const team = Object.values(data.getSnapshot().knownTeams).find(row => row.id === run.team_id && row.home_hub === run.home_hub)
    let target = null
    // A direct/unknown native Session never reaches this source-bound adapter.
    try { target = sessionProcessTarget(scope, run, team, source?.task) } catch {}
    if (target && workspaceCatalogue.ready && workspaceCatalogue.keys.includes(workspaceScopeKey(scope))) view.selectWorkspace(scope)
    else target = null
    // From Orbit, a verified execution Session opens as a native right-Sidebar tab; the panel stays.
    const inOrbit = (ctx.layout.panelInfo?.getSnapshot?.()?.activePanelId ?? null) === TEAM_SIDEBAR_PANEL && teamSidebar.available()
    return managedSessions.open(run, item, target, inOrbit ? { present: id => teamSidebar.openSession(id) } : {})
  }
  const discussions=installDiscussions(ctx,{storage,renderUserAvatar:()=>h(UserAvatar,{size:28}),teams:()=>Object.values(data.getSnapshot().knownTeams),renderTeamAvatar:team=>h(TeamAvatar,{team,size:24}),onBuilder:()=>openBuilder(),onNavigationChange:()=>managedSessions?.invalidate(),onOpenSession:openManagedSession,onOpenInteractiveSession:id=>openOrbitSession(id),onOpenTeam:(team,scope)=>selectTeam(team,scope),onOpenTeamDm:(team,scope)=>{if(!sameWorkspace(view.getSnapshot().workspace,scope))view.selectWorkspace(scope);view.selectSuperagent(team.superagent_id,{teamId:team.id,homeHub:team.home_hub});view.setMode('im')},onOpenSessionMode:async id=>{navigation.selectMode('session');await ctx.get('uiWorkspace').openSession(id)},renderTeamSettings:(team,onClose)=>h(SuperagentSettingsPanel,{key:conversationViewKey(team),variant:'tab',team,request:requestCollabRead,storage:outboxStorage,controls:ctx.get('kodeAgentControls'),appearance,TeamAppearance,TeamAvatar,onRefreshContacts:()=>data.refreshContacts(),onClose}),onOpenProcess:(scope,task)=>{
    const team=Object.values(data.getSnapshot().knownTeams).find(row=>row.id===task.team_id&&row.home_hub===scope.home_hub)
    const target=discussionProcessTarget(scope,task,team)
    selectTeam(team,scope);processReturn=discussions.returnPoint();view.openProcess(target)
  }})
  installProjectResourceSessionTabs(ctx,{catalogue:catalogueSource})
  const workspaceContacts=createWorkspaceContacts({request:requestCollabRead,onTeams:(teams,home)=>data.acceptScopedTeams(teams,home)})
  const outboxStorage = createOutboxStorage()
  conversationViews = createConversationViews({ storage: outboxStorage, view })
  const outbox = createCollabOutbox({ storage: outboxStorage, request: requestCollabMessage })
  let restorePending = false
  const useView = () => useSyncExternalStore(view.subscribe, view.getSnapshot)
  const useData = () => useSyncExternalStore(data.subscribe, data.getSnapshot)
  // Orbit's right Sidebar host: the scope is the team or draft the main view really shows.
  const hostScope = createScopeSource()
  const sessionTitle = id => { const row = ctx.get('sessions')?.list?.getSnapshot()?.byId?.[id]; return row?.displayTitle || row?.title || '会话' }
  // The main DM composer is its conversation's writer; a Sidebar message column yields to it.
  const mainWriters = (() => { const held = new Map(), listeners = new Set(); let keys = new Set()
    const change = (key, delta) => { const count = (held.get(key) ?? 0) + delta; if (count > 0) held.set(key, count); else held.delete(key); keys = new Set(held.keys()); for (const fn of listeners) fn() }
    return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => keys,
      hold: key => { change(key, 1); let held = true; return () => { if (held) { held = false; change(key, -1) } } } } })()
  // What the open Builder view shows for a draft: the settings tab of that draft scope renders with it.
  const builderDetails = (() => { let value = null; const listeners = new Set()
    return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => value,
      publish: next => { value = next; for (const fn of listeners) fn(); return () => { if (value === next) { value = null; for (const fn of listeners) fn() } } } } })()
  const teamSidebar = installTeamSidebar(ctx, { scope: hostScope, MessagesTab, SettingsTab, sessionTitle })
  const openBuilderForTeam = team => { view.selectWorkspace(null); view.selectSuperagent('kode-builtin-builder', {teamId:team.id,homeHub:team.home_hub}); navigation.selectMode('im') }
  // A sidebar Session stays in Orbit: its real native Session renders in Orbit's canvas, not session mode.
  const openOrbitSession = id => { view.setMode('im'); view.openOrbitSession(id); ctx.layout.selectPanel('kode-collab') }
  const openBuilder = () => { view.selectWorkspace(null); view.selectSuperagent('kode-builtin-builder', { homeHub: data.getSnapshot().homeHub }); navigation.selectMode('im'); ctx.layout.selectPanel('kode-collab') }
  // Planning chat is a real native Session: open it with the native workspace and hand
  // text only to its own input. Builder never renders a parallel chat surface.
  const panelSource = { subscribe: fn => ctx.layout.panelInfo?.subscribe?.(fn) ?? (() => {}), isActive: () => (ctx.layout.panelInfo?.getSnapshot?.()?.activePanelId ?? null) === 'kode-collab' }
  const planningHost = { get sessions() { return ctx.get('sessions') }, get uiWorkspace() { return ctx.get('uiWorkspace') }, selectMode: mode => navigation.selectMode(mode), panel: panelSource, Handoff: NativeHandoff }
  const navigation = installCollabNavigation({ workspace: ctx.get('uiWorkspace'), originalSymbol: symbols.original, layout: ctx.layout, view, openBuilder })
  const selectedHost = () => ctx.get('kodeWorkspaces')?.currentHost?.() ?? ctx.get('kodeWorkspaces')?.directory?.getSnapshot()?.current ?? 'local'
  ctx.inject(['kodeSettings'], scope => {
    const component = createCollaborationSettings({ appearance, view, data, navigation, TeamAppearance, UserAvatarSettings, controls: ctx.get('kodeAgentControls'), request: requestCollabRead })
    scope.effect(() => scope.get('kodeSettings').register({ id: 'collaboration', label: '协作', component }), 'kode.collab.settings')
  })
  const managedSessions = installManagedSessionUi(ctx, mode => navigation.selectMode(mode), {
    current: target => selectedHost() === 'local' && sameWorkspace(view.getSnapshot().workspace, target.scope) && workspaceCatalogue.ready
      && workspaceCatalogue.keys.includes(workspaceScopeKey(target.scope))
      && Object.values(data.getSnapshot().knownTeams).some(team => team.id === target.teamId && teamInWorkspace(team, target.scope)),
    read: (target, signal) => readProcessReturn(target, requestCollabRead, signal),
    open: target => {
      const team = Object.values(data.getSnapshot().knownTeams).find(row => row.id === target.teamId && teamInWorkspace(row, target.scope))
      // Force a fresh ProcessDetail mount even if the native shell retained its pane.
      selectTeam(team, target.scope); view.openProcess({ ...target, sessionReturn: crypto.randomUUID() })
    },
  })
  ctx.effect(() => {
    const stopView = view.subscribe(() => managedSessions?.invalidate())
    let panel = ctx.layout.panelInfo?.getSnapshot()?.activePanelId
    const stopPanel = ctx.layout.panelInfo?.subscribe(() => {
      const next = ctx.layout.panelInfo.getSnapshot()?.activePanelId
      if (next !== panel) { panel = next; managedSessions?.invalidate() }
    })
    const source = ctx.get('sessions')?.list
    const currentSession = () => Object.values(source?.getSnapshot()?.byId ?? {}).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
    let session = currentSession()
    const stopSession = source?.subscribe(() => {
      const next = currentSession()
      if (next !== session) { session = next; managedSessions?.invalidate() }
    })
    const stopCatalogue = catalogueSource.subscribe(() => managedSessions?.invalidate())
    let host = selectedHost()
    const stopHost = ctx.get('kodeWorkspaces')?.directory?.subscribe(() => {
      const next = selectedHost()
      if (next !== host) { host = next; managedSessions?.invalidate() }
    })
    return () => { stopView(); stopPanel?.(); stopSession?.(); stopCatalogue(); stopHost?.(); managedSessions?.invalidate() }
  }, 'kode.managed-session-navigation-scope')
  navigationStorage = createNavigationStorage({ storage: outboxStorage, view, home: () => data.getSnapshot().homeHub,
    selectMode: mode => {
      restorePending = mode === 'im' && !!view.getSnapshot().lastSuperagentId
      if (mode === 'session' || ctx.slots.entries('main').some(entry => entry.options.key === 'kode-collab')) {
        restorePending = false
        const currentPanel = ctx.layout.panelInfo?.getSnapshot()?.activePanelId
        navigation.selectMode(mode, { showPanel: mode === 'im' && !!view.getSnapshot().lastSuperagentId && (!currentPanel || currentPanel === 'kode-collab') })
      }
    }, restoreTeam: (id, superagentId) => data.restoreSelectedTeam(id, superagentId) })
  ctx.effect(() => {
    void data.loadTeams().then(() => navigationStorage.restore()).catch(() => {})
  }, 'kode.collab.restore-navigation')
  ctx.effect(() => () => { discussions.dispose(); navigation.dispose(); data.dispose(); workspaceContacts.close(); outbox.dispose(); conversationViews.close(); navigationStorage.close(); outboxStorage.close() }, 'kode.collab.lifecycle')
  const selectTeam = (team,scope=null) => { if(scope&&!teamInWorkspace(team,scope))return;processReturn=null;view.selectWorkspace(scope); view.selectSuperagent(team.superagent_id, { teamId: team.id, homeHub: team.home_hub }); navigation.selectMode('im'); ctx.layout.selectPanel('kode-collab') }
  function TeamAvatar({ team, size = 36 }) {
    const state = appearance?.useTeam?.(team)
    return state?.profile?.avatar?.id
      ? h(appearance.Avatar, { profile: state.profile, host: 'local', size, status: 'idle' })
      : h(Icon, { name: 'users', size: size <= 20 ? size : Math.round(size * .55) })
  }
  function TeamAppearance({ team, showBackground = true, row = false }) {
    const state = appearance?.useTeam?.(team)
    const [choosing, setChoosing] = useState(false)
    const [background, setBackground] = appearance.useBackgroundPreference()
    const choose = h(Button, { variant: row ? 'outline' : undefined, onClick: () => setChoosing(true), disabled: state?.loading || !state?.profile }, '头像与背景')
    const retry = state?.error && h(IconButton, { icon: 'refresh', label: '重试读取外观', onClick: () => void state.refresh() })
    // Settings row: the same choices and store, laid out as a native settings row.
    return h(row ? 'div' : 'section', { className: row ? 'kode-integration-row kode-collab-appearance-row' : 'kode-collab-appearance', 'aria-label': '团队外观' },
      row ? h('span', null, h('strong', null, '团队头像与背景'), h('span', { className: 'kode-config-note', role: state?.error ? 'status' : undefined }, state?.error || '团队在私信与侧边栏中显示的头像，以及与之配套的背景。'))
        : h('h2', null, '团队外观'),
      row ? h('div', { className: 'kode-collab-row-actions' }, retry, choose) : choose,
      !row && showBackground && h('label', null, h('input', { type: 'checkbox', checked: background, onChange: event => setBackground(event.target.checked) }), '显示配套背景（全局）'),
      !row && state?.error && h('p', { role: 'status' }, state.error, retry),
      h(Modal, { open: choosing && !!state?.profile, title: '团队头像与背景', closeLabel: '关闭', onClose: () => setChoosing(false), className: 'kode-avatar-dialog' }, choosing && state?.profile && h(appearance.Choices, { profile: state.profile, host: 'local',
        onChoose: async avatarId => { await state.save(avatarId); setChoosing(false) },
        onCancel: () => setChoosing(false), onGenerated: () => void appearance.refreshLibrary() })))
  }
  // Settings for a row that is not on screen yet: open the settings tab once the main view
  // publishes that row's scope and the right Sidebar is available. Never opens another scope's tab.
  let pendingSettings=null
  // Deferred one task so the Sidebar host has adopted the new scope before the tab opens in it.
  const flushSettings=()=>setTimeout(()=>{if(!pendingSettings||hostScope.getSnapshot()!==pendingSettings||!teamSidebar.available())return;pendingSettings=null;try{teamSidebar.openTab(SETTINGS_KIND)}catch{}},0)
  ctx.effect(()=>{const stop=teamSidebar.source.subscribe(flushSettings);return()=>{stop();pendingSettings=null}},'kode.collab.pending-settings')
  // Without the native right Sidebar (stock dsh) a row's settings action opens the DM's in-place inspector instead.
  const inlineSettings=(()=>{let value=null;const fns=new Set();return {get:()=>value,set:next=>{value=next;for(const fn of fns)fn()},subscribe:fn=>{fns.add(fn);return()=>fns.delete(fn)}}})()
  const openSettingsFor=(target,superagentId)=>{if(!teamSidebar.hosted()&&superagentId){inlineSettings.set(superagentId);return}pendingSettings=target;flushSettings()}
  // A Team DM row on the native row anatomy: hover pin/archive (server contact preference)
  // and a "…" menu with SuperAgent 设置. Pinned and archived come from the contact directory.
  function TeamRow({team,scope,current}){
    const directory=useData(),[opening,setOpening]=useState(false),[openError,setOpenError]=useState('')
    const pref=useContactPreference({team,storage:outboxStorage,onChanged:()=>data.refreshContacts()})
    const name=team.spec?.name||'未命名 Superagent',preference=pref.preference??team.contact?.preference
    const interactive=team.spec?.execution_mode==='interactive_native'
    const unread=directory.conversations[team.conversation_id]?.readState?.unread_count??team.contact?.unread_count??0
    const attention=team.contact?.attention?.decisions>0?'需要你确认':team.contact?.attention?.stopping>0?'停止待确认':team.contact?.attention?.resources>0?'等待资源':''
    const open=async tab=>{
      if(opening)return
      if(!interactive){selectTeam(team,scope);if(tab==='settings')openSettingsFor(teamScope(team),team.superagent_id);return}
      setOpening(true);setOpenError('')
      try{await discussions.openTeamDm(team,scope,tab)}catch(error){setOpenError(error.message||'无法打开团队私信，请重试。')}finally{setOpening(false)}
    }
    const locked=pref.busy||!pref.ready||!preference
    return h(React.Fragment,null,h(ItemRow,{rowKey:'team:'+team.id,kind:'team','data-team-id':team.id,label:`私信 ${name}`,selected:current,pinned:preference?.pinned,archived:preference?.archived,
      leading:h(TeamAvatar,{team,size:16}),title:name,onOpen:()=>void open(),
      trailing:opening?h('span',{className:'kode-sidebar-attention'},'正在打开…'):unread>0?h('span',{className:'kode-sidebar-unread'},unread>99?'99+':String(unread)):attention?h('span',{className:'kode-sidebar-attention'},attention):null,
      trailingLabel:unread>0?`${unread} 条未读消息`:attention||undefined,
      hover:h(HoverText,{title:name,detail:pref.message||attention||team.spec?.purpose||undefined}),
      menu:{label:`${name} 操作`,items:[{id:'settings',label:'SuperAgent 设置',icon:h(Icon,{name:'settings',size:16})},
        ...(pref.pending?[{id:'recover',label:'恢复原联系人设置请求',disabled:pref.busy}]:[])],
        onSelect:id=>{if(id==='settings')void open('settings');else void pref.change(pref.pending.command.action)}},
      actions:h(React.Fragment,null,h(RowAction,{label:'SuperAgent 设置',onClick:()=>void open('settings')},h(Icon,{name:'settings',size:14})),
        !pref.pending&&h(PinArchiveActions,{pinned:preference?.pinned,archived:preference?.archived,busy:locked,
          onPin:()=>void pref.change(preference.pinned?'unpin':'pin'),onArchive:()=>void pref.change(preference.archived?'unarchive':'archive')}))}),openError&&h('p',{className:'kode-sidebar-empty',role:'alert'},openError))
  }
  function TeamRows({teams,scope=null,selected}) {
    const state=useView()
    return teams.map(team=>h(TeamRow,{key:team.superagent_id,team,scope,current:!!selected&&!state.orbitSessionId&&state.lastSuperagentId===team.superagent_id}))
  }
  // Team Builder is an ordinary DM row; its hover gear opens Builder settings in the right Sidebar.
  function BuilderRow({current=true}){
    const state=useView(),directory=useData()
    const settings=()=>{openBuilder();requestAnimationFrame(()=>window.dispatchEvent(new CustomEvent('kode-builder-tab',{detail:'settings'})))}
    return h(ItemRow,{rowKey:'builder',kind:'builder','data-system-contact-kind':'builder',label:'私信 Team Builder',title:'Team Builder',
      selected:current&&!state.orbitSessionId&&state.lastSuperagentId==='kode-builtin-builder',leading:h(Icon,{name:'agent',size:16}),onOpen:openBuilder,
      hover:h(HoverText,{title:'Team Builder',detail:'规划团队、成员与职责'}),
      actions:h(RowAction,{label:'Team Builder 设置',onClick:settings},h(Icon,{name:'settings',size:14}))})
  }
  // New extension is opt-in; stock dsh keeps the safe workspace-level switch.
  let hasBrandControl=false
  const brandListeners=new Set()
  const brandSource={subscribe:fn=>{brandListeners.add(fn);return()=>brandListeners.delete(fn)},getSnapshot:()=>hasBrandControl}
  let lastModePanel='kode-discussions'
  const switchSidebarMode=mode=>{if(mode==='im'){view.setMode('im');ctx.layout.selectPanel(lastModePanel)}else navigation.selectMode('session')}
  function BrandControl({wide=true,identity}){const state=useView();return h(ModeSwitch,{mode:state.mode,onSelect:switchSidebarMode,wide,brand:true,identity})}
  function PrimaryAction({native}){const state=useView();return state.mode==='im'?teamPrimaryAction(native,openBuilder):native}
  ctx.slots.inject('sidebar.brand.control',()=>{
    hasBrandControl=true;for(const fn of brandListeners)fn()
    const dispose=ctx.slots.register({name:'sidebar.brand.control',key:'kode-collab-brand'},BrandControl)
    return()=>{dispose();hasBrandControl=false;for(const fn of brandListeners)fn()}
  })
  ctx.slots.inject('sidebar.primary.action',()=>ctx.slots.register({name:'sidebar.primary.action',key:'kode-collab-primary'},PrimaryAction))
  function UnifiedSidebar({native:NativeWorkspaces,...nativeProps}) {
    const {wide}=nativeProps,state=useView(),directory=useData()
    const panel=ctx.layout.panelInfo
    const active=useSyncExternalStore(panel?.subscribe??(()=>()=>{}),panel?.getSnapshot??(()=>null))
    const selected=active?['kode-collab','kode-discussions'].includes(active.activePanelId):state.mode==='im'
    const previousPanel=useRef(active)
    const headerSwitch=useSyncExternalStore(brandSource.subscribe,brandSource.getSnapshot)
    useEffect(()=>{if(previousPanel.current===active)return;previousPanel.current=active;if(!active)return;const id=active.activePanelId;if(id==='kode-collab'||id==='kode-discussions'){lastModePanel=id;view.setMode('im')}else if(id===null)view.setMode('session')},[active])
    const switchMode=switchSidebarMode
    const facade=ctx.get('kodeWorkspaces'),source=facade?.directory
    const cold=useSyncExternalStore(source?.subscribe??(()=>()=>{}),source?.getSnapshot??(()=>null))
    const native=nativeProps.useWorkspaces?nativeProps.useWorkspaces(value=>value):null
    const scopes=registeredWorkspaceScopes(native,cold&&facade?.currentHost?{...cold,current:facade.currentHost()}:cold,directory.homeHub)
    const pages=useSyncExternalStore(workspaceContacts.subscribe,workspaceContacts.getSnapshot)
    const signature=JSON.stringify(scopes)
    const hasNative=typeof nativeProps.useWorkspaces==='function'&&typeof nativeProps.useSessions==='function'&&typeof nativeProps.open==='function'&&typeof nativeProps.startSession==='function'
    const catalogueReady=facade?!!cold?.hosts?.some(host=>host.id==='local')&&!cold.error:native?.phase==='ready'
    useLayoutEffect(()=>{if(hasNative)publishCatalogue(scopes,catalogueReady,native)},[signature,catalogueReady,hasNative,native])
    const [chosen,setChosen]=useState(null)
    let savedScope
    const selectionKey='kode.collab.current-workspace.v1:'+directory.homeHub
    try{savedScope=JSON.parse(storage?.getItem(selectionKey)??'null')}catch{}
    const currentScope=scopes.find(scope=>sameWorkspace(scope,state.workspace))??scopes.find(scope=>sameWorkspace(scope,chosen))??scopes.find(scope=>sameWorkspace(scope,savedScope))??scopes[0]??null
    const currentKey=workspaceScopeKey(currentScope)
    useLayoutEffect(()=>discussions.setScope(currentScope),[currentKey])
    useEffect(()=>{if(currentScope){setChosen(currentScope);try{storage?.setItem(selectionKey,JSON.stringify(currentScope))}catch{}}},[currentKey,selectionKey])
    useEffect(()=>{void facade?.refresh?.()},[facade])
    useEffect(()=>{if(currentScope)void workspaceContacts.load(currentScope)},[currentKey])
    useEffect(()=>{if(directory.homeHub&&catalogueReady&&state.workspace&&!scopes.some(scope=>sameWorkspace(scope,state.workspace))){view.selectWorkspace(null);if(selected)navigation.selectMode('session')}},[signature,state.workspace,directory.homeHub,catalogueReady])
    useEffect(()=>{facade?.setChannelWorkspaces?.(scopes.filter(scope=>Object.values(directory.knownTeams).some(team=>teamInWorkspace(team,scope))).map(scope=>scope.rowId))},[signature,pages,facade,directory.knownTeams])
    useEffect(()=>()=>facade?.setChannelWorkspaces?.([]),[facade])
    useEffect(()=>{void data.loadTeams()},[])
    useEffect(()=>visibleRefresh({delay:5000,refresh:async signal=>{await data.refreshContacts({signal});if(currentScope&&!signal.aborted)await workspaceContacts.load(currentScope,{reload:true})}}),[currentKey])
    const chooseWorkspace=scope=>{setChosen(scope);try{storage?.setItem(selectionKey,JSON.stringify(scope))}catch{};if(view.selectWorkspace(scope)){view.setMode('im');discussions.openHome(scope)}}
    // A row clicked inside another project makes that project current; the row then acts itself.
    const focusWorkspace=scope=>{setChosen(scope);try{storage?.setItem(selectionKey,JSON.stringify(scope))}catch{};view.selectWorkspace(scope);view.setMode('im')}
    const openProjectSettings=()=>{try{ctx.get('kodeSettings')?.open?.('collaboration')}catch{}}
    const [legacySearch,setLegacySearch]=useState(''),[managingNative,setManagingNative]=useState(false)
    const unassigned=directory.teams.filter(team=>!team.spec?.workspace_refs?.length)
    return h('section',{className:'kode-collab-unified-sidebar','aria-label':'工作区与团队','data-wide':wide},
      (!headerSwitch||!wide)&&h(ModeSwitch,{mode:state.mode,onSelect:switchMode,wide}),
      hasNative?h(ScopedWorkspaceSidebar,{mode:state.mode,onSelectMode:switchMode,native:NativeWorkspaces,nativeProps,scopes,selectedScope:currentScope,onSelectScope:chooseWorkspace,onFocusScope:focusWorkspace,onOpenProjectSettings:openProjectSettings,storage,onNativeManagerChange:setManagingNative,
        onOpenSession:openOrbitSession,currentSessionId:selected?state.orbitSessionId:null,
        ownerManagedSessions:(facade?.currentHost?.()??cold?.current)==='local'?cold?.hosts?.find(host=>host.id==='local')?.ownerManagedSessions:[],
        onOpenManagedSession:openManagedSession,
        renderChannelSection:(scope,section)=>h(discussions.Sidebar,{key:workspaceScopeKey(scope)+':channels',scope,kind:'channel',section}),
        renderDirectSection:(scope,section)=>h(discussions.Sidebar,{key:workspaceScopeKey(scope)+':dm',scope,kind:'dm',section},h(BuilderRow,{current:sameWorkspace(scope,currentScope)}),h(TeamRows,{teams:directory.teams.filter(team=>teamInWorkspace(team,scope)),scope,selected:selected&&sameWorkspace(state.workspace,scope)}))}):h(NativeWorkspaces,nativeProps),
      state.mode==='im'&&wide&&!managingNative&&(unassigned.length>0||directory.directoryQuery||directory.archivedContacts)&&h('div',{className:'kode-native-tree',role:'tree','aria-label':'未关联工作区的团队'},h(SidebarSection,{id:'channels',label:'未关联工作区的团队',depth:0},h('form',{className:'kode-collab-search',onSubmit:e=>{e.preventDefault();void data.loadTeams({search:legacySearch})}},h(Input,{'aria-label':'搜索联系人',value:legacySearch,onChange:e=>setLegacySearch(e.target.value),placeholder:'搜索未关联团队'}),h(IconButton,{icon:'search',label:'搜索',type:'submit'}),h(IconButton,{icon:'archive',label:directory.archivedContacts?'返回联系人':'已归档联系人',onClick:()=>void data.loadTeams({archived:!directory.archivedContacts})})),h(TeamRows,{teams:unassigned,selected:selected&&!state.workspace}))),
      state.mode==='im'&&directory.nextTeamCursor&&wide&&h(Button,{onClick:()=>void data.loadTeams({more:true})},'继续读取团队'))
  }
  function Composer(props) {
    return h(ManagedComposer, props)
  }
  function ManagedComposer({ team, priorRunId, onClearFollowup }) {
    const sending = useRef(false)
    const [draft, setDraft] = useState(() => view.conversation(team).draft)
    const [error, setError] = useState(''), [busy, setBusy] = useState(false)
    const records = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot)
    const record = records[outbox.keyOf(team)]
    const draftStates = useSyncExternalStore(conversationViews.subscribe, conversationViews.getSnapshot)
    const draftState = draftStates[conversationViewKey(team)]
    useEffect(() => { if (draftState?.ready) setDraft(draftState.value.draft) }, [draftState?.value.draft])
    useEffect(() => {
      let active = true
      void outbox.load(team).catch(() => { if (active) setError('无法读取发送记录。请检查浏览器存储权限后重试。') })
      return () => { active = false }
    }, [team.home_hub, team.conversation_id])
    const run = async retry => {
      if (sending.current || busy) return
      sending.current=true; setBusy(true); setError('')
      try {
        const savedDraft = await conversationViews.flush(team)
        const input = savedDraft.value
        const result = await (retry ? outbox.retry(team) : outbox.send(team, input.draft,
          { draft_token: savedDraft.draftToken, ...(input.clarificationTarget ? { clarification_target: input.clarificationTarget } : {}), ...(input.priorRunId ? { prior_run_id: input.priorRunId } : {}) }))
        if (result?.state === 'accepted') {
          const cleared = await conversationViews.acknowledge(team, result)
          if (cleared) onClearFollowup()
          if (!result.draft_token && sameConversationTarget(view.conversation(team).clarificationTarget, result.clarification_target) && view.conversation(team).draft === result.content && (view.conversation(team).priorRunId || undefined) === result.prior_run_id) {
            view.saveConversation(team, { draft: '' }); setDraft(''); onClearFollowup()
            await conversationViews.flush(team)
          }
          void data.loadMessages(team.conversation_id)
        }
      } catch { setError('消息未能发送。请检查发送记录或浏览器存储权限后重试。') }
      finally { sending.current=false; setBusy(false) }
    }
    const unresolved = record && !['accepted', 'rejected'].includes(record.state)
    return h('div', { className: 'kode-collab-composer' },
      h(ConversationQuestions, { team, compact:true, target: draftState?.value.clarificationTarget, disabled: busy || !!unresolved, onSelect: target => {
        view.saveConversation(team, { clarificationTarget: target, priorRunId: null }); onClearFollowup()
      } }),
      h('style', null, messageDeliveryStyles),
      h(MessageDeliveryStatus, { record, busy, onRetry: () => void run(true) }),
      priorRunId && h('div', { role: 'status', className: 'kode-collab-note' }, '关联原任务：', priorRunId, '。发送后将按当前流程处理修改请求。', h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !!unresolved, onClick: onClearFollowup }, '取消关联')),
      PortableTextComposer ? h(PortableTextComposer, { scopeKey: conversationViewKey(team), value: draft, ariaLabel: '发送给团队的内容', placeholder: `发给 ${team.spec?.name || 'Superagent'}…`, maxLength: 65536,
        disabled: busy || record?.busy || !!unresolved || !draftState?.ready || !!draftState?.error,
        onChange: value => { view.saveConversation(team, { draft: value }); setDraft(value) },
        onSubmit: async request => { if (request.scopeKey !== conversationViewKey(team) || request.text !== draft || unresolved || !draftState?.ready || draftState.error) throw Error('Draft scope or revision changed'); await run(false) },
        accessory: h('span', { className: 'kode-collab-composer-hint' }, 'Enter 发送 · Shift+Enter 换行') }) : h('p', { role:'alert',className:'kode-collab-note' }, '原生编辑器尚未就绪，草稿仍保留。请重新加载应用后重试。'),
      h('p', { role: 'status', className: 'kode-collab-draft-status kode-collab-note' }, draftState?.error || (draftState?.saving ? '正在保存草稿…' : draftState?.draftToken ? '草稿已保存。' : '')),
      draftState?.error && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || draftState.writing, onClick: () => void conversationViews.retry(team, { overwrite: draftState.conflict }).catch(() => {}) }, draftState.conflict ? '以当前草稿覆盖已保存版本' : '重试保存草稿'),
      error && h('p', { role: 'alert', className: 'kode-collab-note' }, error))
  }
  // One message column's live reads: the shared draft view, message stream, refresh and read marks.
  function useTeamMessages(team, scroll) {
    useEffect(() => { void conversationViews.open(team).catch(() => {}) }, [team.home_hub, team.id, team.conversation_id])
    useEffect(() => visibleMessageStream({ store: data, conversationId: team.conversation_id }), [team.conversation_id])
    useEffect(() => visibleRefresh({ delay: 15000, refresh: async signal => {
      await data.loadMessages(team.conversation_id, { signal })
      if (!signal.aborted) await data.loadReadState(team.conversation_id, { signal })
      const current = data.getSnapshot().conversations[team.conversation_id]
      return current?.error ? 10000 : current?.hasMore ? 250 : 15000
    } }), [team.conversation_id])
    useEffect(() => observeConversationRead({ root: scroll.current, getState: () => data.getSnapshot().conversations[team.conversation_id], markRead: sequence => data.markRead(team.conversation_id, sequence) }), [team.conversation_id])
  }
  function Conversation({ team, project }) {
    const teamAppearance = appearance?.useTeam?.(team)
    const state = useData(), scroll = useRef(null)
    const draftStates = useSyncExternalStore(conversationViews.subscribe, conversationViews.getSnapshot)
    const draftState = draftStates[conversationViewKey(team)]
    const restoredScroll = useRef({ done: false })
    const [scrollReady, setScrollReady] = useState(false)
    const [priorRunId, setPriorRunId] = useState(() => view.conversation(team).priorRunId || null)
    const clearFollowup = () => { view.saveConversation(team, { priorRunId: null }); setPriorRunId(null) }
    const followup = run => {
      if (run.team_id !== team.id || run.home_hub !== team.home_hub || !['completed', 'failed', 'cancelled'].includes(run.state)) return
      view.saveConversation(team, { priorRunId: run.id, clarificationTarget: null }); setPriorRunId(run.id); setShowProcess(false)
    }
    const processTarget = useView().processTarget
    const [showProcess, setShowProcess] = useState(false)
    const processButton = useRef(null), inspectorHeading = useRef(null)
    const closeProcess = () => { view.clearProcess(); setShowProcess(false); const back=processReturn; processReturn=null; if(back?.())return; requestAnimationFrame(()=>processButton.current?.focus()) }
    useEffect(() => { if(showProcess)inspectorHeading.current?.focus() }, [showProcess])
    useEffect(() => { if (processTarget) setShowProcess(true) }, [processTarget])
    // One right-hand inspector seat: execution details or this DM's settings.
    const [showSettings, setShowSettings] = useState(false), [viewTab, setViewTab] = useState('discussion')
    const TabList = resolveViewTabList(ctx)
    const settingsButton = useRef(null)
    const closeSettings = () => { setShowSettings(false); setViewTab('discussion'); requestAnimationFrame(() => settingsButton.current?.focus()) }
    const inlineRequest = useSyncExternalStore(inlineSettings.subscribe, inlineSettings.get)
    // The message column lives in the host sidebar; without it the header offers no target.
    const messagesReady = useSyncExternalStore(teamSidebar.source.subscribe, teamSidebar.source.getSnapshot)
    useEffect(() => { if (inlineRequest !== team.superagent_id) return; inlineSettings.set(null); if (showProcess) closeProcess(); setShowSettings(true); setViewTab('settings') }, [inlineRequest, team.superagent_id])
    const history = state.conversations[team.conversation_id]
    useTeamMessages(team, scroll)
    useEffect(() => { if (draftState?.ready) setPriorRunId(draftState.value.priorRunId) }, [draftState?.value.priorRunId])
    useLayoutEffect(() => team.spec?.kind === 'coordinator' ? mainWriters.hold(conversationViewKey(team)) : undefined, [conversationViewKey(team), team.spec?.kind])
    useLayoutEffect(() => {
      const element = scroll.current
      if (!element || !draftState?.ready || !history?.loaded || restoredScroll.current.done) return
      const target = view.conversation(team).scrollTop
      element.scrollTop = target
      restoredScroll.current.done = element.scrollHeight - element.clientHeight >= target || !history.hasMore
      if (restoredScroll.current.done) setScrollReady(true)
    }, [team.conversation_id, draftState?.ready, history?.items.length])
    return h('section', { className: 'kode-collab-conversation', 'data-conversation-content': '', 'data-process-open': showProcess || undefined, 'aria-label': `${team.spec?.name || 'Superagent'}的对话` },
      h(appearance.Background, { profile: teamAppearance?.profile }),
      h('header', { className: 'kode-collab-header' + (TabList ? ' kode-collab-header-with-tabs' : '') }, h('span', { className: 'kode-collab-header-avatar', 'aria-hidden': true }, h(TeamAvatar, {team, size:32})), h('div', { className:'kode-collab-heading-copy' }, h('h1', {title:team.spec?.name||'Superagent'}, team.spec?.name || 'Superagent'), h('small',null,'私信 · 核心更新')), h('div', { className: 'kode-collab-header-actions' }, messagesReady&&h(IconButton,{icon:'chat',label:'查看关联设计消息列',onClick:()=>{teamSidebar.openTab(MESSAGES_KIND);openBuilderForTeam(team)}}), h('span',{ref:settingsButton,tabIndex:-1},h(IconButton, { icon: 'settings', label: 'SuperAgent 设置', 'aria-expanded': showSettings && !showProcess, onClick: () => { if(showProcess)closeProcess();setShowSettings(true);setViewTab('settings') } })), h('span',{ref:processButton,tabIndex:-1},h(IconButton, { icon: 'process', label: showProcess ? '收起工作过程' : '工作过程', 'aria-expanded': showProcess, onClick: () => { if(showProcess)closeProcess();else{processReturn=null;setShowSettings(false);setViewTab('discussion');setShowProcess(true)} } })))),
      TabList && h('div',{className:'kode-collab-view-tabs'},h(TabList,{tabs:[{id:'discussion',label:'对话'},{id:'settings',label:'设置'}],value:viewTab,onSelect:value=>{setViewTab(value);setShowSettings(value==='settings');if(value==='settings'&&showProcess)closeProcess()}})),
      h('div',{className:'kode-collab-narrow-hint',role:'status'},h('p',null,'收起侧边栏，即可完整查看对话。'),h(Button,{onClick:()=>ctx.layout.toggleSidebar()},'收起侧边栏')),
      team.contact?.attention?.decisions > 0 && h('div', { className: 'kode-collab-attention', role: 'status' }, h('span', null, '有任务需要你确认'), h('button', { type: 'button', className: 'kode-collab-button', onClick: () => setShowProcess(true) }, '查看待确认任务')),
      viewTab==='settings' ? h(SuperagentSettingsPanel,{key:conversationViewKey(team),variant:'tab',team,request:requestCollabRead,storage:outboxStorage,controls:ctx.get('kodeAgentControls'),appearance,TeamAppearance,TeamAvatar,onRefreshContacts:()=>data.refreshContacts(),onClose:closeSettings}) : h('div', { className: 'kode-collab-workspace' },
        h('div', { className: 'kode-collab-thread' }, h(MessageWindow, { items: history?.items ?? [], team, renderAvatar: message => message.actor?.kind === 'human' ? h(UserAvatar,{size:34}) : h(TeamAvatar,{team,size:34}), heightCache: heightsFor(team), scrollRef: scroll, followLatest: scrollReady, onScroll: event => { if (restoredScroll.current.done) view.saveConversation(team, { scrollTop: event.currentTarget.scrollTop }) } },
          history?.loaded && !history.items.length && h('p', { className: 'kode-collab-note' }, '这段长期对话还没有消息。'),
          history?.readError && h('p', { role: 'status', className: 'kode-collab-note' }, history.readError),
          history?.error && h('div', { role: 'status', className: 'kode-collab-note' }, history.error, h(IconButton, { icon: 'refresh', label: '重新读取对话', disabled: history.loading, onClick: () => void data.loadMessages(team.conversation_id) })),
          history?.hasMore && h('button', { type: 'button', className: 'kode-collab-button', disabled: history.loading, onClick: () => void data.loadMessages(team.conversation_id) }, '继续读取消息')),
        team.spec?.kind === 'coordinator' ? (draftState?.ready
          ? h(Composer, { key: conversationViewKey(team), team, priorRunId, onClearFollowup: clearFollowup })
          : h('div', { role: 'status', className: 'kode-collab-note' }, draftState?.error || '正在恢复草稿…', draftState?.error && h('button', { type: 'button', className: 'kode-collab-button', onClick: () => void conversationViews.reopen(team).catch(() => {}) }, '重新读取草稿')))
          : h('p', { className: 'kode-collab-note kode-collab-preview' }, 'Team Builder 的对话入口仍在接入。')),
        showProcess && h('aside',{className:'kode-collab-inspector','aria-label':'执行详情',onKeyDown:event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();closeProcess()}}},
          h('header',null,h('strong',{ref:inspectorHeading,tabIndex:-1},'执行详情'),h(IconButton,{icon:'close',label:'关闭执行详情',onClick:closeProcess})),
          h(ProcessView, { key: team.id, team, request: requestCollabRead, storage: outboxStorage, onFollowup: followup, onOpenSession: openManagedSession, focus: processTarget, onClearFocus: () => view.clearProcess() })) ))
  }
  // Right-Sidebar tab bodies. Each reads the exact team its tab's host scope names, never the current view.
  const scopedTeam = (scope, directory) => scope?.kind === 'team' ? Object.values(directory.knownTeams).find(row => row.id === scope.team_id && row.home_hub === scope.home_hub) ?? null : null
  const tabStatus = text => h('div', { className: 'kode-sidebar-tab-status', role: 'status' }, h('p', null, text))
  function MessagesTab({ useTabInfo }) {
    const scope = useHostScope(useTabInfo), directory = useData()
    if (scope?.kind === 'draft') return h(DraftScopeNote, null, '这个团队草案还没有团队。创建团队后，这里显示它的私信消息列。')
    const team = scopedTeam(scope, directory)
    if (!team) return tabStatus(directory.directoryLoaded ? '找不到这个团队，可能已归档或不在当前主机。' : '正在读取团队…')
    return h(TeamMessageColumn, { key: conversationViewKey(team), team })
  }
  function TeamMessageColumn({ team }) {
    const state = useData(), scroll = useRef(null)
    const history = state.conversations[team.conversation_id]
    const draftStates = useSyncExternalStore(conversationViews.subscribe, conversationViews.getSnapshot)
    const draftState = draftStates[conversationViewKey(team)]
    const yielded = useSyncExternalStore(mainWriters.subscribe, mainWriters.getSnapshot).has(conversationViewKey(team))
    const [priorRunId, setPriorRunId] = useState(() => view.conversation(team).priorRunId || null)
    const clearFollowup = () => { view.saveConversation(team, { priorRunId: null }); setPriorRunId(null) }
    useTeamMessages(team, scroll)
    useEffect(() => { if (draftState?.ready) setPriorRunId(draftState.value.priorRunId) }, [draftState?.value.priorRunId])
    return h('section', { className: 'kode-collab-conversation kode-sidebar-messages', 'data-conversation-content': '', 'data-sidebar-messages': conversationViewKey(team), 'aria-label': `${team.spec?.name || 'Superagent'}的私信消息列` },
      h('div', { className: 'kode-collab-workspace' }, h('div', { className: 'kode-collab-thread' },
        h(MessageWindow, { items: history?.items ?? [], team, renderAvatar: message => message.actor?.kind === 'human' ? h(UserAvatar, { size: 28 }) : h(TeamAvatar, { team, size: 28 }), heightCache: heightsFor(team), scrollRef: scroll, followLatest: !!history?.loaded },
          history?.loaded && !history.items.length && h('p', { className: 'kode-collab-note' }, '这段长期对话还没有消息。'),
          history?.readError && h('p', { role: 'status', className: 'kode-collab-note' }, history.readError),
          history?.error && h('div', { role: 'status', className: 'kode-collab-note' }, history.error, h(IconButton, { icon: 'refresh', label: '重新读取对话', disabled: history.loading, onClick: () => void data.loadMessages(team.conversation_id) })),
          history?.hasMore && h('button', { type: 'button', className: 'kode-collab-button', disabled: history.loading, onClick: () => void data.loadMessages(team.conversation_id) }, '继续读取消息')),
        team.spec?.kind !== 'coordinator' ? null
          : yielded ? h('p', { role: 'status', className: 'kode-collab-note kode-sidebar-writer-yield' }, '这个团队的私信已在主面板打开，请在那里输入；这里的输入框暂停使用，草稿共用并已保存。')
          : draftState?.ready ? h(Composer, { key: conversationViewKey(team), team, priorRunId, onClearFollowup: clearFollowup })
          : h('div', { role: 'status', className: 'kode-collab-note' }, draftState?.error || '正在恢复草稿…', draftState?.error && h('button', { type: 'button', className: 'kode-collab-button', onClick: () => void conversationViews.reopen(team).catch(() => {}) }, '重新读取草稿')))))
  }
  function SettingsTab({ useTabInfo }) {
    const info = useTabInfo(), scope = useHostScope(useTabInfo), directory = useData()
    if (scope?.kind === 'builder') return h(BuilderSettingsTab, { home: scope.home_hub })
    if (scope?.kind === 'draft') return h(DraftSettingsTab, { scope })
    const team = scopedTeam(scope, directory)
    if (!team) return tabStatus(directory.directoryLoaded ? '找不到这个团队，可能已归档或不在当前主机。' : '正在读取团队…')
    return h(SuperagentSettingsPanel, { key: conversationViewKey(team), variant: 'tab', team, request: requestCollabRead, storage: outboxStorage, controls: ctx.get('kodeAgentControls'), appearance, TeamAppearance, TeamAvatar,
      onRefreshContacts: () => data.refreshContacts(), onClose: () => info.tab.actions.close() })
  }
  function SettingsPage({ label, children }) {
    return h('section', { className: 'kode-superagent-settings kode-superagent-settings-tab', 'aria-label': label }, h('style', null, superagentSettingsStyles),
      h('div', { className: 'kode-settings-main kode-superagent-settings-body' }, h('div', { className: 'kode-settings-page' }, children)))
  }
  function BuilderSettingsTab({ home }) {
    const planning = usePlanningChoice({ controls: ctx.get('kodeAgentControls'), storage: outboxStorage, home, draftId: null })
    return h(SettingsPage, { label: 'Team Builder 设置' }, h(BuilderHomeSettings, { controls: ctx.get('kodeAgentControls'), planning, appearance }))
  }
  function DraftSettingsTab({ scope }) {
    const shown = useSyncExternalStore(builderDetails.subscribe, builderDetails.getSnapshot)
    if (!shown || shown.draft.id !== scope.draft_id || shown.draft.home_hub !== scope.home_hub) return h(DraftScopeNote, null, '在 Team Builder 中打开这个团队草案后，可在这里编辑它的设计设置。')
    return h(SettingsPage, { label: '团队设计设置' }, h(BuilderDraftSettings, shown))
  }
  // The native session-header handoff (kode-handoff), rendered as registered: same dialog,
  // same /api/kode/agent-hub handoff and navigation; the source Session is kept.
  const HEADER_ACTIONS = 'conversation.session.header.actions'
  // A Builder planning Session passes its `planning` adapter to the same registered menu.
  function NativeHandoff({ sessionId, planning }) {
    const find = () => ctx.slots.entries(HEADER_ACTIONS).find(entry => (entry.options?.id ?? entry.id) === 'kode-handoff') ?? null
    const [entry, setEntry] = useState(find)
    useEffect(() => { setEntry(find()); return ctx.slots.subscribe(HEADER_ACTIONS, () => setEntry(find())) }, [])
    if (!entry || typeof entry.component !== 'function') return null
    const inject = entry.inject ?? entry.options?.inject
    const props = inject ? inject(sessionId) : { sessionId, sessions: ctx.sessions }
    return h(entry.component, planning ? { ...props, planning } : props)
  }
  function Main({ SessionProvider, renderSlot }) {
    const state = useView(), directory = useData()
    // The planning Session renders through Orbit's own session-scope slot (official embedded pattern).
    const host = React.useMemo(() => SessionProvider && renderSlot ? Object.assign(Object.create(planningHost), { panel: panelSource,
      renderSession: (reference, props = {}) => h(SessionProvider, { session: reference }, renderSlot(PLANNING_SLOT, props)) }) : planningHost, [SessionProvider, renderSlot])
    const catalogue=useSyncExternalStore(catalogueSource.subscribe,catalogueSource.getSnapshot)
    const team = directory.knownTeams[state.lastSuperagentId]
    useEffect(() => { if (!directory.directoryLoaded) void data.loadTeams() }, [directory.directoryLoaded])
    const builder = state.lastSuperagentId === 'kode-builtin-builder'
    const initialTeam = builder ? Object.values(directory.knownTeams).find(row=>row.id===state.lastTeamId&&row.home_hub===state.lastHomeHub)??null : null
    // undefined: Builder has not reported yet (its initial team stands in); otherwise what it shows.
    const [builderShows, setBuilderShows] = useState(undefined)
    const sidebarAvailable = useSyncExternalStore(teamSidebar.source.subscribe, teamSidebar.source.getSnapshot)
    const sidebar = React.useMemo(() => ({ available: sidebarAvailable, open: kind => teamSidebar.openTab(kind), publishBuilder: builderDetails.publish }), [sidebarAvailable])
    const inWorkspace = team && !((state.workspace && !teamInWorkspace(team,state.workspace)) || (!state.workspace && team.spec?.workspace_refs?.length))
    const scope = state.orbitSessionId && host.renderSession ? undefined
      : builder ? (builderShows === undefined ? teamScope(initialTeam) ?? builderScope(state.lastHomeHub ?? directory.homeHub)
        : builderShows.draft ? draftScope(builderShows.draft) : builderShows.team ? teamScope(builderShows.team) : builderScope(builderShows.home ?? directory.homeHub))
      : state.workspace && (!catalogue.ready || !catalogue.keys.includes(workspaceScopeKey(state.workspace))) ? undefined
      : inWorkspace ? teamScope(team) : undefined
    useLayoutEffect(() => { hostScope.set(scope) }, [scope])
    useLayoutEffect(() => () => hostScope.set(undefined), [])
    const nativeTeam = !(state.orbitSessionId && host.renderSession) && team?.spec?.execution_mode === 'interactive_native' && state.workspace && inWorkspace ? team : null
    const nativeTeamKey = nativeTeam ? JSON.stringify([nativeTeam.home_hub, nativeTeam.id, workspaceScopeKey(state.workspace)]) : ''
    useEffect(() => {
      if (!nativeTeam) return
      void discussions.openTeamDm(nativeTeam, state.workspace).catch(() => {})
    }, [nativeTeamKey])
    if (state.orbitSessionId && host.renderSession) return h(OrbitSessionView, { key: state.orbitSessionId, host, views: teamSidebar.sessionViews, viewSource: teamSidebar.sessionViewSource, sessionId: state.orbitSessionId, actions: h(NativeHandoff, { sessionId: state.orbitSessionId }), onClose: () => view.openOrbitSession(null) })
    if (builder) return h(PlanningHostContext.Provider, {value:host}, h(BuilderControlsContext.Provider, {value:ctx.get('kodeAgentControls')}, h(TeamSidebarContext.Provider, {value:sidebar}, h(BuilderView, { initialTeam, TabList:resolveViewTabList(ctx), request: requestCollabRead, storage: outboxStorage, appearance, onScope: setBuilderShows, onTeamSaved: () => { void data.loadTeams() } }))))
    if(state.workspace&&(!catalogue.ready||!catalogue.keys.includes(workspaceScopeKey(state.workspace))))return h('section',{className:'kode-collab-empty'},h('p',{role:'status'},'正在核对登记工作区…'))
    if (team && ((state.workspace && !teamInWorkspace(team,state.workspace)) || (!state.workspace && team.spec?.workspace_refs?.length))) return h('section',{className:'kode-collab-empty'},h('h1',null,'请从所属工作区打开团队'),h('p',null,'频道、任务与团队资源按已登记工作区显示。'))
    if (nativeTeam) return h('section', { className: 'kode-collab-empty' }, h('p', { role: 'status' }, '正在打开团队私信…'))
    if (team) return h(Conversation, { key: conversationViewKey(team), team, project: teamProjectPointer(team,state.workspace,catalogue) })
    return h('section', { className: 'kode-collab-empty' },
      h('h1', null, state.lastSuperagentId === 'kode-builtin-builder' ? 'Team Builder' : '与 Superagent 对话'),
      h('p', null, state.lastSuperagentId === 'kode-builtin-builder' ? 'Team Builder 的配置界面仍在接入，当前入口不会创建团队或启动任务。' : '从联系人中选择一个团队，查看长期对话。'),
      h(Button, { variant: 'primary', onClick: openBuilder }, '创建团队'),
      directory.directoryError && h('p', { role: 'status' }, directory.directoryError))
  }
  // One shell owner; preserve the native registrations, injections and child slot declarations.
  function adapt(slot) {
    return ctx.slots.inject(slot, () => {
      const adapted = new Map()
      const install = () => {
        for (const entry of ctx.slots.entries(slot)) {
          if (adapted.has(entry) || (entry.locale ?? entry.options.locale) !== 'workspace') continue
          const original = entry.component
          if (typeof original !== 'function') continue
          adapted.set(entry, adaptSlotComponent(entry, UnifiedSidebar))
        }
      }
      const off = ctx.slots.subscribe(slot, install); install()
      return () => { off(); for (const adapter of adapted.values()) adapter.deactivate() }
    })
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'kode-collab', children: { [PLANNING_SLOT]: { kind: 'single', scope: 'session' } } }, Main))
  ctx.slots.inject(PLANNING_SLOT, () => ctx.slots.register({ name: PLANNING_SLOT }, PlanningConversationPanel))
  adapt('sidebar.workspaces')
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => style.remove()
  }, 'kode.collab.styles')
  // The main registration may appear after plugin application. Restore IM only once it exists.
  ctx.effect(() => {
    const restore = () => {
      if (view.getSnapshot().mode !== 'im') restorePending = false
      if (restorePending && ctx.slots.entries('main').some(entry => entry.options.key === 'kode-collab')) { const active=ctx.layout.panelInfo?.getSnapshot()?.activePanelId; restorePending=false; if (!active || active==='kode-collab') ctx.layout.selectPanel('kode-collab') }
    }
    const off = ctx.slots.subscribe('main', restore); restore(); return off
  }, 'kode.collab.restore')
}
