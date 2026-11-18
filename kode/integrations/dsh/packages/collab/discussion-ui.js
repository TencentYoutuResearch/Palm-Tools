import {ChannelProjectResources} from './project-resource-session-tabs.js'
import {DiscussionDelivery} from './discussion-delivery-recovery.js'
import {interactiveTargets,interactiveSelection,interactiveTargetTier} from './interactive-composer-selection.js'
import {interactiveDmScope,readInteractiveDms,openPrimaryInteractiveDm} from './interactive-team-dm.js'
import {useDiscussionSidebarDirectory} from './discussion-sidebar-directory.js'
import {DiscussionTaskPanel,discussionTaskStyles} from './discussion-task-ui.js'
import {collaborationLayout} from './collaboration-layout.js'
import {createScopeSource} from './team-sidebar.js'
import {resolveViewTabList} from './session-view-tabs.js'
import {ClarificationCard,clarificationStyles} from './clarification-card.js'
import * as conversationModule from '@kode/dsh-composer'
import {portableComposerSupport,portableDiscussionProps} from './portable-composer.js'
import {InviteAgent} from './member-invite-ui.js'
/** Channel and DM share a thread renderer, never a model execution context. */
import React from 'react'
import {Button,Input,Modal,MarkdownText,Tooltip,Menu,IconChevronDownOutlineRegular} from '@deepseek-ai/dsh-client-ui-primitives'
import {SidebarSection} from './sidebar-sections.js'
import {Icon,IconButton} from './icons.js'
import {ItemRow,RowAction,PinArchiveActions,HoverText,OverflowButton,createLocalRowPreferences,arrangeRows,indent} from './native-rows.js'
import {requirementGuidance,requirementExample} from './requirement-guidance.js'
import {discussionScope,discussionKey,sameDiscussionScope,requestDiscussion,draftKey,createMessageDraft,validateMessagePage,validateThreads,discussionDeliveryLabel,discussionActorTeam,discussionActorLabel,discussionContextCommand} from './discussion-model.js'
const NativeComposer=portableComposerSupport(conversationModule)
const h=React.createElement,{useState,useEffect,useRef,useSyncExternalStore}=React
export function installDiscussions(ctx,{storage,teams=()=>[],renderTeamAvatar,renderUserAvatar,onBuilder,onOpenProcess,onOpenSession,onOpenInteractiveSession,onOpenTeam,onOpenTeamDm,onNavigationChange,renderTeamSettings,onOpenSessionMode}){
 let selected=null,activeScope=null,version=0,sidebarHost=null,requestedTab=null;const listeners=new Set(),sidebarScope=createScopeSource()
 const emit=()=>{version++;for(const fn of listeners)fn()}
 const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)}
 const snapshot=()=>version
 const select=(scope,surface,thread=null)=>{onNavigationChange?.();activeScope=discussionScope(scope);selected={scope:activeScope,surface,thread};sidebarScope.set(discussionSidebarScope(activeScope,surface));emit();ctx.layout.selectPanel('kode-discussions')}
 const setScope=scope=>{if(sameDiscussionScope(activeScope,scope))return;onNavigationChange?.();activeScope=scope?discussionScope(scope):null;if(selected&&!sameDiscussionScope(selected.scope,scope))selected=null;if(!selected)sidebarScope.set(undefined);emit()}
 const openHome=scope=>{onNavigationChange?.();if(scope)activeScope=discussionScope(scope);selected=null;sidebarScope.set(undefined);emit();ctx.layout.selectPanel('kode-discussions')}
 const openTeamDm=async(team,scope,tab='discussion')=>{const target=await openPrimaryInteractiveDm({team,scope,storage});requestedTab={surfaceId:target.surface.id,tab};onOpenTeamDm?.(team,target.scope);select(target.scope,target.surface);return target}
 const openThread=(scope,surface,thread)=>{select(scope,surface,thread);if(sidebarHost)try{sidebarHost.openTab(DISCUSSION_THREAD_KIND)}catch{}}
 const returnPoint=()=>{const origin=selected;return()=>{if(!origin||!sameDiscussionScope(origin.scope,activeScope))return false;select(origin.scope,origin.surface,origin.thread);return true}}
 const useVersion=()=>useSyncExternalStore(subscribe,snapshot)
 function Identity({surface,message}){
  const team=message?discussionActorTeam(message.actor,surface,teams()):surface.team_ids?.length===1?teams().find(t=>t.home_hub===surface.scope.home_hub&&surface.team_ids[0]===t.id):null
  const human=message?.actor?.kind==='human'
  return h('span',{className:'kode-discussion-avatar','data-identity':human?'human':team?'team':'unknown','aria-hidden':true},human&&renderUserAvatar?renderUserAvatar():!human&&team&&renderTeamAvatar?renderTeamAvatar(team):h(Icon,{name:human?'user':team?'users':'process',size:18}))
 }
 // Channel mentions are navigation to the named team; DMs have no @ concept.
 function Mentions({surface,message}){
  const rows=surface.kind==='dm'?[]:Array.isArray(message.mentions)?message.mentions.filter(m=>typeof m?.team_id==='string'):[]
  if(!rows.length)return null
  return h('small',{className:'kode-discussion-mentions','data-mentions':''},rows.map((m,index)=>{
   const team=teams().find(t=>t.id===m.team_id&&t.home_hub===surface.scope.home_hub),label='@'+(team?.spec?.name||m.team_id)
   return h(React.Fragment,{key:mentionKey(m)||index},index>0?'、':null,team&&onOpenTeam?h('button',{type:'button',className:'kode-discussion-mention',onClick:()=>onOpenTeam(team,surface.scope)},label):label)
  }))
 }
 function Delivery({message}){return h(DiscussionDelivery,{message,onUpdated:emit,onOpenSession:onOpenInteractiveSession})}


 // Channels and discussion DMs have no server pin/archive yet: a local presentation preference.
 const rowPreferences=createLocalRowPreferences(storage)
 function Sidebar({scope,kind,section,children}){
  const tick=useVersion(),{page,error,retry}=useDiscussionSidebarDirectory(scope,tick),[creating,setCreating]=useState(false),[showArchived,setShowArchived]=useState(false)
  const prefs=useSyncExternalStore(rowPreferences.subscribe,rowPreferences.getSnapshot)
  const panel=ctx.layout.panelInfo,active=useSyncExternalStore(panel?.subscribe??(()=>()=>{}),panel?.getSnapshot??(()=>null))
  const key=discussionKey(scope),createKey='kode.discussion.create:'+key+':'+kind
  // A create request that is not confirmed yet reopens the dialog so it is retried, never duplicated.
  useEffect(()=>{try{if(storage.getItem(createKey))setCreating(true)}catch{}},[createKey])
  const rowId=surface=>key+':'+surface.id
  const {rows,archived}=arrangeRows((page?.items??[]).filter(s=>s.kind===kind&&s.enabled),rowId,prefs)
  const noun=kind==='dm'?'私信':'频道'
  const row=surface=>{const id=rowId(surface),pinned=prefs.pinned.includes(id),isArchived=prefs.archived.includes(id)
   return h(ItemRow,{key:surface.id,rowKey:'surface:'+surface.id,kind:kind==='dm'?'dm':'channel','data-surface-id':surface.id,label:`${noun} ${surface.title}`,title:surface.title,pinned,archived:isArchived,
    selected:active?.activePanelId==='kode-discussions'&&sameDiscussionScope(selected?.scope,scope)&&selected?.surface.id===surface.id,
    leading:kind==='dm'?h(Identity,{surface,small:true}):h(Icon,{name:'channel',size:16}),onOpen:()=>select(scope,surface),
    hover:h(HoverText,{title:surface.title,detail:kind==='dm'?'私信 · 仅本私信可见':'频道 · 讨论与任务归档'}),copyText:surface.title,
    actions:h(PinArchiveActions,{pinned,archived:isArchived,onPin:()=>rowPreferences.togglePin(id),onArchive:()=>rowPreferences.toggleArchive(id)})})}
  return h(SidebarSection,{...section,actions:kind==='channel'&&h(RowAction,{label:'新建频道',onClick:()=>setCreating(true)},h(Icon,{name:'plus',size:16}))},
   kind==='channel'&&rows.map(row),
   kind==='channel'&&!page&&!error&&h('p',{className:'kode-sidebar-empty',style:indent(2),role:'status'},'正在读取…'),
   page&&kind==='channel'&&!rows.length&&!archived.length&&h('p',{className:'kode-sidebar-empty',style:indent(2)},'还没有频道。',h('button',{type:'button',onClick:()=>setCreating(true)},'新建频道')),
   kind==='channel'&&error&&h('p',{role:'status',className:'kode-sidebar-empty',style:indent(2)},error,' ',h(IconButton,{icon:'refresh',size:'sm',label:'重新读取频道目录',onClick:retry})),
   children,
   kind==='channel'&&archived.length>0&&h(OverflowButton,{expanded:showArchived,onClick:()=>setShowArchived(v=>!v)},showArchived?'收起已归档':`已归档 ${archived.length}`),
   kind==='channel'&&showArchived&&archived.map(row),
   kind==='channel'&&creating&&h(CreateSurface,{scope,kind,createKey,onClose:()=>setCreating(false)}))
 }
 /** New channel / team DM: a name and one team of this workspace. The request id is kept
  * until the backend confirms, so a retry reuses it and never creates a second surface. */
 function CreateSurface({scope,kind,createKey,onClose,boundTeam}){
  const pending=useRef(null),running=useRef(false),active=useRef(null),[ready,setReady]=useState(false),[title,setTitle]=useState(boundTeam?.spec?.name??''),[team,setTeam]=useState(boundTeam?.id??''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  useEffect(()=>{const controller=new AbortController();active.current=controller;try{const saved=JSON.parse(storage.getItem(createKey)||'null');if(saved&&(!sameDiscussionScope(saved.input?.scope,scope)||saved.input?.kind!==kind||boundTeam&&(saved.input?.team_ids?.length!==1||saved.input.team_ids[0]!==boundTeam.id)))throw Error('saved scope differs');pending.current=saved;if(saved){setTitle(saved.input.title);setTeam(saved.input.team_ids[0]);setError('上次创建尚未确认。请重试原请求，不会重复创建。')}setReady(true)}catch{setError('无法读取创建记录，请恢复本地存储后重试。')}return()=>controller.abort()},[createKey])
  const available=teams().filter(t=>(!boundTeam||t.id===boundTeam.id)&&t.home_hub===scope.home_hub&&(t.spec?.workspace_refs??[]).some(w=>w.host_id===scope.host_id&&w.workspace_id===scope.workspace_id&&w.root_ref===scope.root_ref))
  const locked=busy||!!pending.current,dm=kind==='dm'
  const create=async()=>{if(running.current||busy||!ready||!title.trim()||!available.some(t=>t.id===team))return;running.current=true;setBusy(true);setError('');const controller=active.current;try{if(boundTeam&&!pending.current){const existing=await readInteractiveDms({team:boundTeam,scope,signal:controller.signal});if(existing.length){setError('已有原生私信可用。请关闭此窗口，重新读取并选择已有私信。');return}}const request=pending.current??{id:crypto.randomUUID(),input:{request_id:crypto.randomUUID(),expected_revision:0,scope:discussionScope(scope),kind,title:title.trim(),team_ids:[team],enabled:true}};storage.setItem(createKey,JSON.stringify(request));pending.current=request;const result=await requestDiscussion('surfaces/'+request.id,{},request.input,{signal:controller.signal});if(result.id!==request.id||!sameDiscussionScope(result.scope,scope)||result.kind!==kind||result.enabled!==true||result.revision!==1||result.title!==request.input.title||JSON.stringify(result.team_ids)!==JSON.stringify(request.input.team_ids))throw Error('scope mismatch');if(controller.signal.aborted)return;storage.removeItem(createKey);pending.current=null;onClose();select(scope,result)}catch{if(!controller.signal.aborted)setError('创建未确认。请重试原请求，不要重复创建。')}finally{running.current=false;if(!controller.signal.aborted)setBusy(false)}}
  return h(Modal,{open:true,onClose:()=>{if(!locked)onClose()},title:dm?'发起团队私信':'新建频道',closeLabel:'关闭',className:'kode-surface-create',
   footer:available.length?h(React.Fragment,null,!pending.current&&h(Button,{disabled:busy,onClick:onClose},'取消'),h(Button,{variant:'primary',disabled:busy||!title.trim()||!team,onClick:()=>void create()},pending.current?'重试原创建请求':'创建')):h(React.Fragment,null,h(Button,{onClick:onClose},'关闭'),onBuilder&&h(Button,{variant:'primary',onClick:()=>{onClose();onBuilder()}},'打开 Team Builder'))},
   h('p',{className:'kode-surface-create-scope'},h(Icon,{name:'folder',size:14}),scope.title||scope.workspace_id),
   available.length?h('form',{className:'kode-surface-create-form',onSubmit:event=>{event.preventDefault();void create()}},
    h('label',{className:'kode-surface-create-field'},h('span',null,'名称'),h(Input,{value:title,autoFocus:true,disabled:locked,maxLength:120,placeholder:dm?'例如：发布进度':'例如：需求评审',onChange:e=>setTitle(e.target.value),'aria-label':dm?'私信名称':'频道名称'})),
    h('fieldset',{className:'kode-surface-create-field',disabled:locked},h('legend',null,dm?'参与团队':'邀请成员'),
     h('div',{className:'kode-surface-create-teams',role:'radiogroup','aria-label':dm?'参与团队':'邀请成员'},available.map(t=>h('label',{key:t.id,className:'kode-surface-create-team','data-checked':team===t.id||undefined},
      h('input',{type:'radio',name:createKey,value:t.id,checked:team===t.id,onChange:()=>setTeam(t.id)}),
      h('span',{className:'kode-discussion-avatar','aria-hidden':true},renderTeamAvatar?renderTeamAvatar(t):h(Icon,{name:'users',size:16})),
      h('span',{className:'kode-surface-create-team-copy'},h('strong',null,t.spec?.name||t.id),t.spec?.purpose&&h('small',null,t.spec.purpose)))))),
    h('p',{className:'kode-surface-create-note'},dm?'私信只在你和这个团队之间可见。':'频道保存讨论与任务归档。',boundTeam?'确认后仅建立这个团队的原生私信，不发送消息、不迁移旧历史；发送时按团队设置自动选择执行环境。':dm?'消息只记录，不会自动开始执行。':'之后可以在频道里继续邀请成员；@ 只标记要找的成员，目前不会自动回复，也不会开始执行。'),
    error&&h('p',{role:'alert',className:'kode-surface-create-error'},error))
   :h('div',{className:'kode-surface-create-empty'},h('p',null,dm?'这个工作区还没有可私信的团队。先在 Team Builder 规划一个团队，再回来发起私信。':'频道至少需要一位成员。这个工作区还没有可邀请的团队，先在 Team Builder 规划一个团队，再回来新建频道并邀请成员。')))
 }
 function CreateTeamDm({team,scope,onClose}){
  try{interactiveDmScope(team,scope)}catch{return h('p',{role:'alert'},'工作区已变化，未创建私信。')}
  return h(CreateSurface,{scope,kind:'dm',boundTeam:team,createKey:'kode.discussion.create.team-dm:'+discussionKey(scope)+':'+team.id,onClose})
 }
 function ComposerMenu({label,display,value,items,onSelect,disabled,open,onOpen,align='start'}){
  return h(Menu,{open,onClose:()=>onOpen(false),portal:true,selectedId:value,items,side:'top',align,
   onSelect:id=>{onOpen(false);if(!id.startsWith('group:'))onSelect(id)},
   anchor:h('button',{type:'button',className:'kode-trigger','aria-label':label,'aria-haspopup':'menu','aria-expanded':open,disabled,onClick:()=>onOpen(!open)},h('span',null,display),h(IconChevronDownOutlineRegular,{size:12,className:open?'kode-chevron-open':''}))})
 }
 function Composer({scope,surface,thread,onSent,onContextAction,contextReady=false}){
  const key=draftKey(scope,surface.id,thread),draft=useRef(null),inFlight=useRef(false),alive=useRef(true),[text,setText]=useState(''),[pending,setPending]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ready,setReady]=useState(false),[recipient,setRecipient]=useState(''),[target,setTarget]=useState(''),[delivery,setDelivery]=useState(null)
  const [recipientOpen,setRecipientOpen]=useState(false),[modelOpen,setModelOpen]=useState(false),[modelPreferences,setModelPreferences]=useState(null)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{try{draft.current=createMessageDraft(storage,key);const saved=draft.current.read();setText(saved.text);setPending(!!saved.pending);setRecipient(mentionKey(saved.pending?.mentions?.[0]));setTarget(saved.pending?.interactive_selection?.target_id??'');setDelivery(saved.last_delivery??null);setReady(true)}catch{setError('无法保存草稿，暂不能发送。')}},[key])
  // Structured @ candidates: invited teams of this surface and their members; only ids the surface already holds.
  const inScope=refs=>Array.isArray(refs)&&refs.some(r=>r?.host_id===scope.host_id&&r?.workspace_id===scope.workspace_id&&r?.root_ref===scope.root_ref)
  const recipients=surface.team_ids.map(id=>teams().find(t=>t.id===id&&t.home_hub===scope.home_hub)).filter(t=>t&&inScope(t.spec?.workspace_refs))
  const dm=surface.kind==='dm',interactiveDm=dm&&recipients.length===1&&recipients[0].spec?.execution_mode==='interactive_native'
  const candidates=recipients.flatMap(t=>[{key:mentionKey({team_id:t.id,worker_id:null}),label:interactiveDm?'协调者':(t.spec?.name||t.id),mention:{team_id:t.id,team_revision:t.revision,worker_id:null}},
   ...(thread&&t.spec?.execution_mode!=='interactive_native'?[]:t.spec?.workers??[]).filter(w=>typeof w?.id==='string'&&w.id&&inScope(w.workspace_refs)).map(w=>({key:mentionKey({team_id:t.id,worker_id:w.id}),label:interactiveDm?(w.role||w.id):(t.spec?.name||t.id)+' · '+(w.role||w.id),mention:{team_id:t.id,team_revision:t.revision,worker_id:w.id}}))])
  const chosen=candidates.find(c=>c.key===recipient),chosenTeam=interactiveDm?recipients[0]:recipients.find(t=>t.id===chosen?.mention.team_id),interactive=chosenTeam?.spec?.execution_mode==='interactive_native',targets=interactiveTargets(chosenTeam,chosen?.mention.worker_id,scope)
  const targetSignature=targets.map(t=>t.id).join('|'),preferredTarget=targets.find(t=>interactiveTargetTier(t,modelPreferences)==='Reasonable')??targets[0]
  useEffect(()=>{let alive=true;setModelPreferences(null);const controls=ctx.get('kodeAgentControls');if(chosenTeam&&controls?.readAgentConfiguration)void controls.readAgentConfiguration({host:'local',teamId:chosenTeam.id}).then(value=>{if(alive)setModelPreferences(value)}).catch(()=>{});return()=>{alive=false}},[chosenTeam?.id,chosenTeam?.home_hub])
  useEffect(()=>{if(interactiveDm&&!pending&&!chosen){const coordinator=candidates.find(c=>c.mention.worker_id===null);if(coordinator)setRecipient(coordinator.key)}},[key,interactiveDm,pending,recipient])
  useEffect(()=>{if(interactive&&!pending&&!targets.some(t=>t.id===target))setTarget(preferredTarget?.id??'')},[key,recipient,interactive,pending,targetSignature,modelPreferences])
  const recipientItems=recipients.flatMap((t,index)=>[
   ...(index>0?[{type:'separator'}]:[]),{id:'group:'+t.id,label:t.spec?.name||t.id,disabled:true},
   ...candidates.filter(c=>c.mention.team_id===t.id).map(c=>({id:c.key,label:(c.mention.worker_id===null?'协调者':c.label.split(' · ').at(-1))}))])
  const chooseRecipient=value=>{setRecipient(value);setTarget('');setError('')}
  const recipientPicker=(dm&&!interactiveDm)?null:h(ComposerMenu,{label:interactiveDm?'角色':'@ 提及角色',display:chosen?'@ '+chosen.label:'@ 提及角色',value:chosen?recipient:'',items:recipientItems,onSelect:chooseRecipient,disabled:pending||busy||!ready,open:recipientOpen,onOpen:setRecipientOpen})
  const currentTarget=targets.find(t=>t.id===target)??preferredTarget,currentTier=interactiveTargetTier(currentTarget,modelPreferences),modelName=currentTarget?.model_id??currentTarget?.model??'默认模型',modelLabel=[currentTier,modelName].filter(Boolean).join(' · ')
  const modelPicker=!interactiveDm||!interactive?null:targets.length===1?h('span',{className:'kode-discussion-model-readonly',title:'当前角色在团队设置中仅配置了此模型'},modelLabel):h(ComposerMenu,{label:'模型',display:targets.length?modelLabel:'模型未配置',value:target,items:targets.map(t=>({id:t.id,label:[interactiveTargetTier(t,modelPreferences),t.model_id??t.model??'默认模型'].filter(Boolean).join(' · ')})),onSelect:value=>{setTarget(value);setError('')},disabled:pending||busy||!ready||!targets.length,open:modelOpen,onOpen:setModelOpen,align:'end'})
  const send=async e=>{e.preventDefault();if(inFlight.current||busy||!ready)return;const activeDraft=draft.current,command=onContextAction&&discussionContextCommand(text);if(command){const saved=activeDraft.read();if(saved.pending){setError('请先完成或恢复原消息发送，再执行上下文命令。');return}if(!contextReady){setError('发送并收到原生回复后可执行此命令。');return}activeDraft.edit('');setText('');setError('');onContextAction(command);return}inFlight.current=true;setBusy(true);setError('');try{const original=activeDraft.read().pending;const selection=!original&&interactive?interactiveSelection(chosenTeam,chosen.mention.worker_id,target||preferredTarget?.id,scope,surface):null;const input=activeDraft.prepare(surface,thread,chosen?[chosen.mention]:[],selection);setPending(true);const receipt=await requestDiscussion('surfaces/'+surface.id+'/messages',{},input);if(!sameDiscussionScope(receipt.scope,scope)||receipt.thread_id!==(thread||receipt.id))throw Error('receipt mismatch');activeDraft.accept({surface_id:surface.id,input},receipt);if(alive.current){setText('');setPending(false);setDelivery(receipt);onSent();emit()}}catch(failure){if(alive.current){let original;try{original=activeDraft.read().pending}catch{setReady(false)}setError(original?'发送尚未确认。重试将使用同一请求，不会另建消息。':failure.message||'未发送，请检查所选角色与团队设置。')}}finally{inFlight.current=false;if(alive.current)setBusy(false)}}
  if(!NativeComposer)return h('p',{role:'alert',className:'kode-discussion-hint'},'原生编辑器尚未就绪，草稿仍保留。请重新加载应用后重试。')
  return h('div',{className:'kode-discussion-native-composer',onKeyDownCapture:event=>{if(event.key==='@'&&!event.metaKey&&!event.ctrlKey&&!event.altKey&&recipientPicker)setRecipientOpen(true)}},h(NativeComposer,{...portableDiscussionProps({key,text,pending,busy,ready,thread,draft,setText,setError,setReady,send}),tools:recipientPicker,trailing:modelPicker}),h('small',null,interactive?'按团队设置中的执行资源发送 · Enter 发送，Shift+Enter 换行':'仅讨论，不授予执行权限；未选择角色时仅记录消息 · Enter 发送，Shift+Enter 换行'),delivery?.interactive_delivery&&h('p',{role:'status'},discussionDeliveryLabel(delivery)),error&&h('p',{role:'alert'},error))
 }
 function Messages({scope,surface,thread,onOpen,activeThread,onLatestSession}){
  const tick=useVersion(),[page,setPage]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),latest=useRef(null);latest.current=page
  const readPage=async query=>{const result=await requestDiscussion('surfaces/'+surface.id+(thread?'/messages':'/threads'),query);if(thread)return validateMessagePage(result,scope,surface.id,thread);const summary=validateThreads(result,scope,surface.id);return {...summary,items:summary.items.map(row=>({...row.root,reply_count:row.reply_count,reply_actors:row.reply_actors??[]}))}}
  const load=async(more=false)=>{setBusy(true);try{const query={limit:'25',...(thread?{thread_id:thread}:{})};if(more)query.after=String(page.next_cursor);const result=await readPage(query);setPage(prev=>more?{...result,items:[...prev.items,...result.items]}:result);setError('')}catch{setPage(null);setError('无法读取消息，请检查访问权限。')}finally{setBusy(false)}}
  useEffect(()=>{let live=true,inFlight=false;const refresh=async()=>{if(inFlight||document.visibilityState==='hidden')return;inFlight=true;try{const rows=latest.current?.items??[],after=thread&&rows.length>25?rows[rows.length-26].sequence:0;const query={limit:'50',...(after?{after:String(after)}:{}),...(thread?{thread_id:thread}:{})};let result=await readPage(query);if(!thread){const all=[...result.items];while(live&&result.has_more&&all.length<rows.length){result=await readPage({limit:'50',after:String(result.next_cursor)});all.push(...result.items)}result={...result,items:all}}if(live){setPage(prev=>{const retained=(prev?.items??[]).filter(m=>m.sequence<=after);return {...result,items:[...retained,...result.items]}});setError('')}}catch{if(live)setError('无法读取消息，请检查访问权限。')}finally{inFlight=false}};refresh();const timer=setInterval(refresh,5000);return()=>{live=false;clearInterval(timer)}},[surface.id,thread,tick])
  // Main timeline is a root directory; nested replies never flatten into another task context.
  const items=(page?.items??[]).filter(m=>thread||m.id===m.thread_id)
  useEffect(()=>{const latest=[...items].reverse().find(m=>m.actor?.kind==='interactive_participant'&&m.actor.session_id);if(latest)onLatestSession?.(latest.actor.session_id)},[page,thread])
  return h('div',{className:'kode-discussion-messages','aria-label':thread?'消息列消息':'频道话题'},h('div',{className:'kode-discussion-reading-column'},error&&h('p',{role:'alert'},error),items.map(message=>h('article',{key:message.id,className:'kode-discussion-message','data-message-id':message.id,'data-message-sequence':message.sequence,'data-thread-root':thread===message.id||undefined,'data-selected':activeThread===message.thread_id||undefined},h(Identity,{surface,message}),h('div',{className:'kode-discussion-message-content'},h('header',null,h('strong',null,discussionActorLabel(message.actor,surface,teams())),h('time',{dateTime:message.created_at,title:new Date(message.created_at).toLocaleString()},new Date(message.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))),h(Mentions,{surface,message}),h('div',{className:'kode-discussion-prose'},message.actor?.kind==='human'?h('p',null,message.content):h(MarkdownText,{text:message.content})),message.kind==='worker_clarification'&&thread&&h(ClarificationCard,{key:message.id,scope,surface,thread,message,storage}),h(Delivery,{message}),!thread&&h(React.Fragment,null,h(Button,{className:'kode-discussion-reply kode-discussion-reply-action','aria-label':'回复消息列','aria-expanded':activeThread===message.thread_id,title:'回复消息列',onClick:()=>onOpen(message.thread_id)},h(Icon,{name:'chat',size:16}),'回复'),Number.isSafeInteger(message.reply_count)&&message.reply_count>0&&h(Button,{className:'kode-discussion-thread-summary','aria-label':`${message.reply_count} 条回复，打开消息列`,'aria-expanded':activeThread===message.thread_id,onClick:()=>onOpen(message.thread_id)},h('span',{className:'kode-discussion-reply-avatars','aria-hidden':true},message.reply_actors.map((actor,i)=>h(Identity,{key:i,surface,message:{actor}}))),h('span',null,`${message.reply_count} 条回复`)))))),!items.length&&!error&&h('div',{className:'kode-discussion-empty'},h('h3',null,page?'开始一个话题':'读取消息…'),page&&h('p',null,'把需求、问题或想法留在这里，后续回复会集中在同一消息列。')),page?.has_more&&h(Button,{disabled:busy,onClick:()=>load(true)},'读取更多消息')))
 }
 function ThreadBody({scope,surface,thread}){
  const key=discussionKey(scope)+':'+surface.id
  return h(React.Fragment,null,
   h(Messages,{key:key+':'+thread,scope,surface,thread}),
   h('details',{key:key+':tools:'+thread,className:'kode-discussion-task-tools'},h('summary',null,h(Icon,{name:'process',size:16}),'任务与执行',h(Icon,{name:'down',size:14})),h(DiscussionTaskPanel,{key:key+':task:'+thread,scope,surface,thread,teams:teams(),storage,onOpenProcess,onOpenSession,onOpenTask:(target,id)=>{if(target)openThread(scope,target,id)},onChanged:emit})),
   h(Composer,{key:key+':reply:'+thread,scope,surface,thread,onSent:()=>{}}))
 }
 function HostedThreadTab({useTabInfo}){
  useVersion();const info=useTabInfo()
  if(!selected?.thread||info.host?.scope!==discussionSidebarScope(selected.scope,selected.surface))return h('p',{className:'kode-sidebar-tab-status',role:'status'},'请从频道选择一条消息列。')
  return h('div',{className:'kode-discussion-detail kode-discussion-detail-native','aria-label':'消息列详情'},h(ThreadBody,{scope:selected.scope,surface:selected.surface,thread:selected.thread}))
 }
 function ChannelHome(){
  const [page,setPage]=useState(null),[error,setError]=useState(''),scope=activeScope,key=scope?discussionKey(scope):''
  useEffect(()=>{let live=true;setPage(null);setError('');if(scope)requestDiscussion('surfaces',discussionScope(scope)).then(data=>{if(!sameDiscussionScope(data.scope,scope)||data.items.some(s=>!sameDiscussionScope(s.scope,scope)))throw Error('scope mismatch');if(live)setPage(data)}).catch(()=>{if(live)setError('频道暂不可用，请从左侧重试。')});return()=>{live=false}},[key])
  return h('section',{className:'kode-discussion-home'},h(Icon,{name:'channel',size:28}),h('h1',null,'在频道中协作'),onBuilder&&h(Button,{variant:'primary',onClick:onBuilder},'创建团队'),h('p',null,'需求、讨论和任务归档集中在频道里。私信用于核心更新，执行记录可从对应任务打开。'),h('p',null,requirementGuidance),h('p',null,requirementExample),!scope?h('p',null,'先从侧边栏选择一个工作区。'):h(React.Fragment,null,h('div',{className:'kode-discussion-home-links'},(page?.items??[]).filter(s=>s.kind==='channel'&&s.enabled).map(s=>h(Button,{key:s.id,onClick:()=>select(scope,s)},h(Icon,{name:'channel',size:16}),s.title))),page&&!page.items.some(s=>s.kind==='channel'&&s.enabled)&&h('p',null,'点击左侧「频道」旁的 + 创建第一个频道。'),error&&h('p',{role:'alert'},error)))
 }
 function Main(){
  useVersion();const [full,setFull]=useState(false),[viewTab,setViewTab]=useState('discussion'),[latestSessionId,setLatestSessionId]=useState(null),[contextMenuOpen,setContextMenuOpen]=useState(false),heading=useRef(null)
  const selectionKey=selected?discussionKey(selected.scope)+':'+selected.surface.id+':'+selected.thread:''
  useEffect(()=>{setFull(false);setLatestSessionId(null);setContextMenuOpen(false);const wanted=requestedTab&&selected&&requestedTab.surfaceId===selected.surface.id?requestedTab.tab:'discussion';requestedTab=null;setViewTab(wanted);if(selected?.thread)heading.current?.focus()},[selectionKey])
  if(!selected||!sameDiscussionScope(selected.scope,activeScope))return h(React.Fragment,null,h('style',null,STYLES),h(ChannelHome,{key:activeScope?discussionKey(activeScope):'unscoped'}))
  const {scope,surface,thread}=selected,key=discussionKey(scope)+':'+surface.id,TabList=resolveViewTabList(ctx)
  const dmTeam=surface.kind==='dm'&&surface.team_ids?.length===1?teams().find(t=>t.home_hub===scope.home_hub&&t.id===surface.team_ids[0]):null
  const interactiveDm=dmTeam?.spec?.execution_mode==='interactive_native'
  const hasTabs=!!TabList&&(interactiveDm||surface.kind==='channel')
  const closeThread=()=>{select(scope,surface);requestAnimationFrame(()=>{const root=[...document.querySelectorAll('.kode-discussion-timeline [data-message-id]')].find(node=>node.dataset.messageId===thread);root?.querySelector('.kode-discussion-reply')?.focus()})}
  const contextAction=action=>{if(!latestSessionId)return false;window.dispatchEvent(new CustomEvent('kode-discussion-context',{detail:{action,sessionId:latestSessionId,surfaceId:surface.id}}));return true}
  const contextMenu=interactiveDm&&h(Menu,{open:contextMenuOpen,onClose:()=>setContextMenuOpen(false),portal:true,side:'bottom',align:'end',
   items:[{id:'open',label:'在会话模式打开',disabled:!latestSessionId},{id:'clear',label:'清空上下文 / Clear',disabled:!latestSessionId},{id:'resume',label:'恢复历史 / Resume',disabled:!latestSessionId}],
   onSelect:id=>{setContextMenuOpen(false);if(id==='open')void onOpenSessionMode?.(latestSessionId);else contextAction(id)},
   anchor:h(IconButton,{icon:'more',label:'更多对话操作','aria-haspopup':'menu','aria-expanded':contextMenuOpen,onClick:()=>setContextMenuOpen(value=>!value)})})
  const conversation=h('div',{className:'kode-discussion-split','data-full':full&&!!thread},h('main',{className:'kode-discussion-timeline'},h(Messages,{key:key,scope,surface,activeThread:thread,onLatestSession:setLatestSessionId,onOpen:id=>{setFull(false);openThread(scope,surface,id)}}),h(Composer,{key:key+':root',scope,surface,onSent:()=>{},onContextAction:interactiveDm?contextAction:undefined,contextReady:!!latestSessionId})),
   thread&&!sidebarHost&&h('aside',{className:'kode-discussion-detail','aria-label':'消息列详情',onKeyDown:event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();event.stopPropagation();closeThread()}}},h('header',null,h('div',null,h('strong',{ref:heading,tabIndex:-1},'消息列'),h('small',null,surface.title)),h('div',null,h(IconButton,{icon:'panel',label:full?'并排查看':'展开消息列',onClick:()=>setFull(v=>!v)}),h(IconButton,{icon:'close',label:'关闭消息列',onClick:closeThread}))),h(ThreadBody,{scope,surface,thread})))
  const settings=interactiveDm&&viewTab==='settings'?h('div',{className:'kode-discussion-settings kode-superagent-settings-host'},renderTeamSettings?.(dmTeam,()=>setViewTab('discussion'))):conversation
  const channelSettings=bindings=>h('div',{className:'kode-discussion-reading-column kode-discussion-channel-settings'},h('section',null,h('h3',null,'关联团队'),surface.team_ids.length?h('ul',null,surface.team_ids.map(id=>{const team=teams().find(t=>t.home_hub===scope.home_hub&&t.id===id);return h('li',{key:id},team?.spec?.name||id)})):h('p',null,'尚未关联团队。')),h('section',null,h('h3',null,'外部集成'),providersForChannel.map(([id,label])=>{const count=bindings.filter(row=>row.enabled&&row.source.provider===id).length;return h('p',{key:id},label,' · ',count?`已关联 ${count} 项`:'未关联')})),h(InviteAgent,{surface,teams:teams(),storage,onBuilder,onSaved:updated=>select(scope,updated,thread)}))
  return h('section',{className:'kode-discussions','aria-label':'协作讨论','data-private':surface.kind==='dm'},h('style',null,STYLES),
   h('header',{className:'kode-discussion-heading'+(hasTabs?' kode-discussion-heading-with-tabs':'')},h('span',{className:'kode-discussion-heading-icon'},h(Icon,{name:surface.kind==='channel'?'channel':'users',size:22})),h('div',{className:'kode-discussion-heading-copy'},h('h2',null,dmTeam?.spec?.name||surface.title),h('small',null,surface.kind==='dm'?'私信 · 长期对话':'频道 · 讨论与任务归档')),h('div',{className:'kode-discussion-heading-actions'},h(InviteAgent,{key:key+':invite',surface,teams:teams(),storage,onBuilder,onSaved:updated=>select(scope,updated,thread)}),contextMenu)),
   interactiveDm&&TabList&&h('div',{className:'kode-discussion-view-tabs'},h(TabList,{tabs:[{id:'discussion',label:'对话'},{id:'settings',label:'设置'}],value:viewTab,onSelect:setViewTab})),
   surface.kind==='channel'?h(ChannelProjectResources,{key,scope,surface,TabList,renderSettings:channelSettings},conversation):settings)
 }
const providersForChannel=[['tapd','TAPD'],['gongfeng','工蜂 Git']]
 ctx.inject?.(['sidebarRight','sidebarRightTabs'],inner=>{
  const sidebar=inner.get('sidebarRight'),types=inner.get('sidebarRightTabs')
  if(typeof sidebar?.registerHost!=='function'||!types?.register)return
  inner.effect(()=>types.register({id:DISCUSSION_THREAD_TAB_ID,kind:DISCUSSION_THREAD_KIND,priority:'builtin',title:()=> '消息列'}),'kode.discussions.sidebar-thread-type')
  inner.effect(()=>inner.slots.inject('sidebar.right.host.tab',()=>inner.slots.register({name:'sidebar.right.host.tab',key:DISCUSSION_THREAD_TAB_ID},HostedThreadTab)),'kode.discussions.sidebar-thread-body')
  inner.effect(()=>{sidebarHost=sidebar.registerHost('kode-discussions',{scope:sidebarScope});emit();if(selected?.thread)try{sidebarHost.openTab(DISCUSSION_THREAD_KIND)}catch{}return()=>{sidebarHost.dispose();sidebarHost=null;emit()}},'kode.discussions.sidebar-host')
 })
 ctx.effect(()=>{const style=document.createElement('style');style.textContent=STYLES;document.head.append(style);return()=>style.remove()},'kode.discussions.styles')
 ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:'kode-discussions'},Main))
 return {Sidebar,CreateTeamDm,setScope,openHome,openTeamDm,returnPoint,openReference({scope,surface,thread}){setScope(scope);if(thread)openThread(scope,surface,thread);else select(scope,surface)},dispose(){selected=null;sidebarScope.set(undefined);listeners.clear()}}
}
const DISCUSSION_THREAD_KIND='kode-discussions.thread',DISCUSSION_THREAD_TAB_ID='@kode/dsh-collab:discussion-thread'
const discussionSidebarScope=(scope,surface)=>scope&&surface?`discussion/${encodeURIComponent(scope.home_hub)}/${encodeURIComponent(surface.id)}`:undefined
const mentionKey=m=>m?.team_id?JSON.stringify([m.team_id,m.worker_id??null]):''
const STYLES=clarificationStyles+discussionTaskStyles+`
.kode-surface-create .kode-surface-create-scope{display:flex;align-items:center;gap:6px;margin:0 0 16px;color:var(--dsw-alias-label-secondary);font-size:12px}
.kode-surface-create-form{display:flex;flex-direction:column;gap:16px}
.kode-surface-create-field{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;border:0;min-width:0}
.kode-surface-create-field>span,.kode-surface-create-field>legend{padding:0;margin-bottom:6px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.kode-surface-create-teams{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto}
.kode-surface-create-team{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;transition:background-color .15s ease,border-color .15s ease}
.kode-surface-create-team:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-surface-create-team[data-checked]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.kode-surface-create-team input{position:absolute;opacity:0;pointer-events:none}
.kode-surface-create-team:has(input:focus-visible){outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.kode-surface-create-team .kode-discussion-avatar{width:24px;height:24px}
.kode-surface-create-team-copy{display:flex;flex-direction:column;min-width:0}
.kode-surface-create-team-copy strong{font-size:13px;font-weight:500}
.kode-surface-create-team-copy small{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-surface-create-note{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.kode-surface-create-error{margin:0;font-size:12px;color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-label-primary))}
.kode-surface-create-empty p{margin:0 0 16px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
@media (prefers-reduced-motion:reduce){.kode-surface-create-team{transition:none}}
.kode-discussion-native-composer .kode-trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:240px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:0;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:12px;line-height:20px;display:inline-flex}.kode-discussion-native-composer .kode-trigger>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-discussion-native-composer .kode-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.kode-discussion-native-composer .kode-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}.kode-discussion-native-composer .kode-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.kode-discussion-model-readonly{display:inline-flex;align-items:center;max-width:200px;min-height:24px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kode-chevron-open{transform:rotate(180deg)}
.kode-discussion-settings{flex:1;min-height:0;overflow:auto}.kode-discussion-settings.kode-superagent-settings-host{display:flex;flex-direction:column;overflow:hidden}.kode-discussion-messages.kode-discussion-settings{padding:24px clamp(16px,4vw,48px) 32px}.kode-discussion-channel-settings{box-sizing:border-box;width:100%;max-width:960px;margin:0 auto;padding-block:0}.kode-discussion-channel-settings section{margin-bottom:24px}.kode-discussion-channel-settings h3{font-size:15px}.kode-discussion-channel-settings p,.kode-discussion-channel-settings li{font-size:13px;line-height:1.7}

.kode-discussions{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.kode-discussion-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-member-invite p{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.kode-member-invite h3{margin:8px 0 0;font-size:14px}.kode-member-invite select{border-radius:8px}.kode-discussion-heading-actions{display:flex;align-items:center;gap:10px}.kode-discussion-heading-actions>button{display:flex;align-items:center;gap:6px;white-space:nowrap}.kode-discussion-heading h2{font-size:18px;margin:0 0 3px}.kode-discussion-heading small,.kode-discussion-status,.kode-discussion-hint{color:var(--dsw-alias-label-secondary);font-size:12px}
.kode-discussion-split{display:flex;min-height:0;flex:1}.kode-discussion-timeline,.kode-discussion-detail{display:flex;flex:1;min-width:0;flex-direction:column;min-height:0}.kode-discussion-detail{max-width:480px;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.kode-discussion-detail>header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}.kode-discussion-detail>header>div{display:flex}.kode-discussion-split[data-full=true]>.kode-discussion-timeline{display:none}.kode-discussion-split[data-full=true]>.kode-discussion-detail{max-width:none}
.kode-discussion-messages{flex:1;overflow:auto;padding:8px 24px}.kode-discussion-message{padding:14px 0;display:flex;align-items:flex-start;gap:12px}.kode-discussion-message-content{flex:1;min-width:0}.kode-discussion-avatar{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);overflow:hidden}.kode-discussion-message>.kode-discussion-avatar{width:34px;height:34px;margin-top:2px}.kode-discussion-channel-icon{display:flex;width:24px;flex:none;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary)}.kode-discussion-subheading{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);padding:12px 6px 4px}.kode-discussion-message header{display:flex;gap:12px;align-items:center;font-size:13px}.kode-discussion-message time{color:var(--dsw-alias-label-secondary);font-size:11px}.kode-discussion-message p{font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;margin:8px 0}.kode-discussion-reply{font-size:12px;display:flex;gap:6px;background:transparent}
.kode-discussion-native-composer{margin:12px auto 20px}.kode-discussion-native-composer>p{font-size:12px;line-height:18px;margin:6px 0 0;color:var(--dsw-alias-label-secondary)}.kode-discussion-native-composer>small{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:6px}.kode-discussion-composer{margin:12px 20px 20px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px)}.kode-discussion-composer textarea{width:100%;resize:vertical;min-height:64px;max-height:180px;box-sizing:border-box;background:transparent;color:inherit;font:inherit;border:0;outline:none}.kode-discussion-composer>div{display:flex;align-items:center;justify-content:space-between;gap:8px}.kode-discussion-composer small{font-size:11px;color:var(--dsw-alias-label-secondary)}.kode-discussion-composer button{display:flex;gap:6px}.kode-discussion-composer p{color:var(--dsw-alias-label-secondary);font-size:12px}
.kode-discussion-row{display:flex;align-items:center;gap:6px;min-height:36px;width:100%;text-align:left;font-size:14px;background:transparent;border:0;box-shadow:none;padding:4px 6px}.kode-discussion-row>span:not(.kode-discussion-avatar):not(.kode-discussion-channel-icon){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.kode-discussion-row[aria-current=page]{background:var(--dsw-alias-interactive-bg-hover)}.kode-discussion-create{font-size:12px;margin:4px 6px}.kode-discussion-form{display:flex;flex-direction:column;gap:12px}.kode-discussion-form label{display:flex;flex-direction:column;gap:6px}.kode-discussion-form select{padding:8px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2)}.kode-discussion-empty{padding:28px;color:var(--dsw-alias-label-secondary)}.kode-discussion-hint{display:block;padding:6px;line-height:1.5}
@media(max-width:700px){.kode-discussion-heading{padding:14px}.kode-discussion-status{display:none}.kode-discussion-split:has(.kode-discussion-detail)>.kode-discussion-timeline{display:none}.kode-discussion-detail{max-width:none;border-left:0}.kode-discussion-native-composer{margin:12px auto 20px}.kode-discussion-native-composer>small{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:6px}.kode-discussion-composer{margin:10px}.kode-discussion-messages{padding:6px 14px}}
`+collaborationLayout
