import { MessageWindow } from './message-window.js'
import { visibleMessageStream } from './message-stream.js'
import { TeamManagementView } from './team-management-view.js'
import { ContactPreferenceControls } from './contact-preference-controls.js'
import { createConversationViews } from './conversation-views.js'
import { createNavigationStorage } from './navigation-storage.js'
import React from 'react'
import { symbols } from '@deepseek-ai/cordis'
import { createCollabViewState } from './view-state.js'
import { createCollabData, requestCollabRead } from './data.js'
import { installCollabNavigation } from './navigation.js'
import { createOutboxStorage } from './outbox-storage.js'
import { createCollabOutbox, requestCollabMessage } from './outbox.js'
import { visibleRefresh } from './visible-refresh.js'
import { observeConversationRead } from './read-visibility.js'
import { BudgetView } from './budget-view.js'
import { BuilderView } from './builder-view.js'
import { ProcessView } from './process-view.js'
import { installManagedSessionUi } from './managed-session-ui.js'
import { styles } from './styles.js'
const h = React.createElement
const { useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore } = React
export const inject = ['slots', 'layout', 'uiWorkspace', 'conversation']
export function apply(ctx) {
  let storage
  try { storage = window.localStorage } catch {}
  const messageHeights = new Map()
  const heightsFor = team => {
    const key = JSON.stringify([team.home_hub, team.id, team.conversation_id])
    if (!messageHeights.has(key)) messageHeights.set(key, new Map())
    return messageHeights.get(key)
  }
  let conversationViews, navigationStorage
  const view = createCollabViewState({ storage,
    onConversationChange: (id, value) => conversationViews?.update(id, value),
    onNavigationChange: value => { void navigationStorage?.save(value).catch(() => {}) } })
  const data = createCollabData({ request: requestCollabRead, contactDirectory: true, schedulePublish: requestAnimationFrame, cancelPublish: cancelAnimationFrame })
  const outboxStorage = createOutboxStorage()
  conversationViews = createConversationViews({ storage: outboxStorage, view })
  const outbox = createCollabOutbox({ storage: outboxStorage, request: requestCollabMessage })
  let restorePending = view.getSnapshot().mode === 'im'
  const useView = () => useSyncExternalStore(view.subscribe, view.getSnapshot)
  const useData = () => useSyncExternalStore(data.subscribe, data.getSnapshot)
  const openBuilder = () => { view.selectSuperagent('kode-builtin-builder', { homeHub: data.getSnapshot().homeHub }); navigation.selectMode('im') }
  const navigation = installCollabNavigation({ workspace: ctx.get('uiWorkspace'), originalSymbol: symbols.original, layout: ctx.layout, view, openBuilder })
  const managedSessions = installManagedSessionUi(ctx, mode => navigation.selectMode(mode))
  navigationStorage = createNavigationStorage({ storage: outboxStorage, view, home: () => data.getSnapshot().homeHub,
    selectMode: mode => {
      restorePending = mode === 'im'
      if (mode === 'session' || ctx.slots.entries('main').some(entry => entry.options.key === 'kode-collab')) {
        restorePending = false
        navigation.selectMode(mode)
      }
    }, restoreTeam: (id, superagentId) => data.restoreSelectedTeam(id, superagentId) })
  ctx.effect(() => {
    void data.loadTeams().then(() => navigationStorage.restore()).catch(() => {})
  }, 'kode.collab.restore-navigation')
  ctx.effect(() => () => { navigation.dispose(); data.dispose(); outbox.dispose(); conversationViews.close(); navigationStorage.close(); outboxStorage.close() }, 'kode.collab.lifecycle')
  const selectTeam = team => { view.selectSuperagent(team.superagent_id, { teamId: team.id, homeHub: team.home_hub }); navigation.selectMode('im') }
  function ModeSwitch() {
    const state = useView()
    return h('button', { type: 'button', className: 'kode-collab-button', onClick: () => navigation.selectMode(state.mode === 'im' ? 'session' : 'im'), 'aria-label': state.mode === 'im' ? '切换到 Session 模式' : '切换到 IM 模式' }, state.mode === 'im' ? 'Session' : 'IM')
  }
  function Contacts({ collapsed, width, renderSlot, toggleSidebar }) {
    const state = useView(), directory = useData()
    const [search, setSearch] = useState(() => directory.directoryQuery), [searchError, setSearchError] = useState('')
    const find = value => { setSearchError(''); void data.loadTeams({ search: value }).catch(() => setSearchError('搜索内容过长，请缩短后重试。')) }
    useEffect(() => { void data.loadTeams() }, [])
    useEffect(() => visibleRefresh({ delay: 5000, refresh: async signal => {
      await data.refreshContacts({ signal })
      for (const team of data.getSnapshot().teams) { if (signal.aborted) break; await data.loadReadState(team.conversation_id, { signal }) }
    } }), [directory.directoryQuery, directory.archivedContacts])
    const wide = !collapsed
    return h('aside', { className: 'kode-collab-contacts', style: { width: collapsed ? 56 : width }, 'aria-label': 'Superagents 联系人' },
      h('div', { className: 'kode-collab-toolbar' }, h('button', { type: 'button', className: 'kode-collab-button', onClick: toggleSidebar, 'aria-label': wide ? '收起联系人' : '展开联系人' }, wide ? '收起' : '展开'), wide && h('strong', null, 'Superagents')),
      wide && h(React.Fragment, null,
        h('button', { type: 'button', className: 'kode-collab-contact', onClick: openBuilder, 'aria-current': state.lastSuperagentId === 'kode-builtin-builder' ? 'page' : undefined }, '团队搭建助手'),
        h('button', { type: 'button', className: 'kode-collab-button', onClick: () => void data.loadTeams({ archived: !directory.archivedContacts }) }, directory.archivedContacts ? '返回联系人' : '已归档联系人'),
        h('form', { className: 'kode-collab-search', role: 'search', onSubmit: event => { event.preventDefault(); find(search) } },
          h('label', { className: 'kode-collab-input-label' }, '搜索联系人', h('input', { type: 'search', value: search, onChange: event => setSearch(event.target.value), placeholder: '名称或用途', 'aria-label': '搜索联系人' })),
          h('div', null, h('button', { type: 'submit', className: 'kode-collab-button' }, '搜索'), (search || directory.directoryQuery) && h('button', { type: 'button', className: 'kode-collab-button', onClick: () => { setSearch(''); find('') } }, '清除搜索')),
          searchError && h('p', { role: 'status', className: 'kode-collab-note' }, searchError)),
        h('div', { className: 'kode-collab-contact-list' },
          ...directory.teams.map(team => h('button', { type: 'button', key: team.superagent_id, className: 'kode-collab-contact', 'aria-current': state.lastSuperagentId === team.superagent_id ? 'page' : undefined, onClick: () => selectTeam(team) },
            h('span', { className: 'kode-collab-contact-name' }, team.spec?.name || '未命名 Superagent'),
            team.contact?.preference.pinned && h('small', null, '置顶'),
            team.contact?.attention?.decisions > 0 && h('span', { className: 'kode-collab-note' }, '需要你确认'),
            team.contact?.attention?.stopping > 0 && h('span', { className: 'kode-collab-note' }, '停止待确认'),
            team.contact?.attention?.resources > 0 && h('span', { className: 'kode-collab-note' }, '等待资源'),
            (directory.conversations[team.conversation_id]?.readState?.unread_count ?? team.contact?.unread_count) > 0 && h('span', { className: 'kode-collab-unread', 'aria-label': `${directory.conversations[team.conversation_id]?.readState?.unread_count ?? team.contact.unread_count} 条未读消息` }, String(directory.conversations[team.conversation_id]?.readState?.unread_count ?? team.contact.unread_count)),
            directory.conversations[team.conversation_id]?.readError && h('span', { className: 'kode-collab-note' }, '未读状态待同步'))),
          directory.directoryLoaded && !directory.teams.length && h('p', { className: 'kode-collab-note' }, directory.directoryQuery ? '没有找到匹配的联系人。' : '还没有配置团队。'),
          directory.directoryError && h('p', { role: 'status', className: 'kode-collab-note' }, directory.directoryError),
          h('button', { type: 'button', className: 'kode-collab-button', disabled: directory.directoryLoading, onClick: () => void data.loadTeams() }, directory.directoryLoading ? '正在读取…' : '刷新联系人'),
          directory.nextTeamCursor && h('button', { type: 'button', className: 'kode-collab-button', disabled: directory.directoryLoading, onClick: () => void data.loadTeams({ more: true }) }, '更多联系人'))),
      h('div', { className: 'kode-collab-footer' }, h(ModeSwitch), renderSlot?.('sidebar.settings', { wide })))
  }
  function Composer({ team, priorRunId, onClearFollowup }) {
    const [draft, setDraft] = useState(() => view.conversation(team.conversation_id).draft)
    const [error, setError] = useState(''), [busy, setBusy] = useState(false)
    const records = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot)
    const record = records[outbox.keyOf(team)]
    const draftStates = useSyncExternalStore(conversationViews.subscribe, conversationViews.getSnapshot)
    const draftState = draftStates[team.conversation_id]
    useEffect(() => { if (draftState?.ready) setDraft(draftState.value.draft) }, [draftState?.value.draft])
    useEffect(() => {
      let active = true
      void outbox.load(team).catch(() => { if (active) setError('无法读取发送记录。请检查浏览器存储权限后重试。') })
      return () => { active = false }
    }, [team.home_hub, team.conversation_id])
    const run = async retry => {
      if (busy) return
      setBusy(true); setError('')
      try {
        const savedDraft = await conversationViews.flush(team)
        const input = savedDraft.value
        const result = await (retry ? outbox.retry(team) : outbox.send(team, input.draft,
          { draft_token: savedDraft.draftToken, ...(input.priorRunId ? { prior_run_id: input.priorRunId } : {}) }))
        if (result?.state === 'accepted') {
          const cleared = await conversationViews.acknowledge(team, result)
          if (cleared) onClearFollowup()
          if (!result.draft_token && view.conversation(team.conversation_id).draft === result.content && (view.conversation(team.conversation_id).priorRunId || undefined) === result.prior_run_id) {
            view.saveConversation(team.conversation_id, { draft: '' }); setDraft(''); onClearFollowup()
            await conversationViews.flush(team)
          }
          void data.loadMessages(team.conversation_id)
        }
      } catch { setError('消息未能发送。请检查发送记录或浏览器存储权限后重试。') }
      finally { setBusy(false) }
    }
    const unresolved = record && record.state !== 'accepted'
    return h('form', { className: 'kode-collab-composer', onSubmit: event => { event.preventDefault(); void run(false) } },
      unresolved && h('div', { role: 'status' }, h('p', { className: 'kode-collab-note' }, '有一条消息尚未确认接收。'), h('p', { className: 'kode-collab-pending' }, record.content), record.prior_run_id && h('p', { className: 'kode-collab-note' }, '关联原任务：', record.prior_run_id), h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || record.busy, onClick: () => void run(true) }, '查询并重试原消息')),
      priorRunId && h('div', { role: 'status', className: 'kode-collab-note' }, '关联原任务：', priorRunId, '。发送后将按当前流程处理修改请求。', h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || !!unresolved, onClick: onClearFollowup }, '取消关联')),
      h('label', { className: 'kode-collab-input-label' }, '消息', h('textarea', { value: draft, rows: 3, placeholder: '描述你希望完成的需求…', onChange: event => { const value = event.target.value; view.saveConversation(team.conversation_id, { draft: value }); setDraft(value) }, maxLength: 65536,
        onKeyDown: event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent?.isComposing) { event.preventDefault(); if (!unresolved && draft.trim()) void run(false) } } })),
      h('div', { className: 'kode-collab-toolbar' }, h('button', { type: 'submit', className: 'kode-collab-button', disabled: busy || record?.busy || !!unresolved || !draft.trim() }, busy ? '正在发送…' : '发送'),
        record?.state === 'accepted' && h('span', { role: 'status', className: 'kode-collab-note' }, 'Hub 已接收。')),
      h('p', { role: 'status', className: 'kode-collab-draft-status kode-collab-note' }, draftState?.error || (draftState?.saving ? '正在保存草稿…' : draftState?.draftToken ? '草稿已保存。' : '')),
      draftState?.error && h('button', { type: 'button', className: 'kode-collab-button', disabled: busy || draftState.writing, onClick: () => void conversationViews.retry(team, { overwrite: draftState.conflict }).catch(() => {}) }, draftState.conflict ? '以当前草稿覆盖已保存版本' : '重试保存草稿'),
      (error || record?.error) && h('p', { role: 'alert', className: 'kode-collab-note' }, error || record.error))
  }
  function Conversation({ team }) {
    const state = useData(), scroll = useRef(null)
    const draftStates = useSyncExternalStore(conversationViews.subscribe, conversationViews.getSnapshot)
    const draftState = draftStates[team.conversation_id]
    const restoredScroll = useRef({ done: false })
    const [priorRunId, setPriorRunId] = useState(() => view.conversation(team.conversation_id).priorRunId || null)
    const clearFollowup = () => { view.saveConversation(team.conversation_id, { priorRunId: null }); setPriorRunId(null) }
    const followup = run => {
      if (run.team_id !== team.id || run.home_hub !== team.home_hub || !['completed', 'failed', 'cancelled'].includes(run.state)) return
      view.saveConversation(team.conversation_id, { priorRunId: run.id }); setPriorRunId(run.id); setShowProcess(false)
    }
    const [showProcess, setShowProcess] = useState(false)
    const [showBudget, setShowBudget] = useState(false)
    const [showManagement, setShowManagement] = useState(false)
    const history = state.conversations[team.conversation_id]
    useEffect(() => { void conversationViews.open(team).catch(() => {}) }, [team.home_hub, team.id, team.conversation_id])
    useEffect(() => { if (draftState?.ready) setPriorRunId(draftState.value.priorRunId) }, [draftState?.value.priorRunId])
    useEffect(() => visibleMessageStream({ store: data, conversationId: team.conversation_id }), [team.conversation_id])
    useEffect(() => visibleRefresh({ delay: 15000, refresh: async signal => {
      await data.loadMessages(team.conversation_id, { signal })
      if (!signal.aborted) await data.loadReadState(team.conversation_id, { signal })
      const current = data.getSnapshot().conversations[team.conversation_id]
      return current?.error ? 10000 : current?.hasMore ? 250 : 15000
    } }), [team.conversation_id])
    useEffect(() => observeConversationRead({ root: scroll.current, getState: () => data.getSnapshot().conversations[team.conversation_id], markRead: sequence => data.markRead(team.conversation_id, sequence) }), [team.conversation_id])
    useLayoutEffect(() => {
      const element = scroll.current
      if (!element || !draftState?.ready || !history?.loaded || restoredScroll.current.done) return
      const target = view.conversation(team.conversation_id).scrollTop
      element.scrollTop = target
      restoredScroll.current.done = element.scrollHeight - element.clientHeight >= target || !history.hasMore
    }, [team.conversation_id, draftState?.ready, history?.items.length])
    return h('section', { className: 'kode-collab-conversation', 'aria-label': `${team.spec?.name || 'Superagent'}的对话` },
      h('header', { className: 'kode-collab-header' }, h('h1', null, team.spec?.name || 'Superagent'), h('button', { type: 'button', className: 'kode-collab-button', 'aria-expanded': showManagement, onClick: () => setShowManagement(value => !value) }, showManagement ? '收起团队管理' : '团队管理'), h('button', { type: 'button', className: 'kode-collab-button', 'aria-expanded': showBudget, onClick: () => setShowBudget(value => !value) }, showBudget ? '收起预算' : '团队预算'), h('button', { type: 'button', className: 'kode-collab-button', 'aria-expanded': showProcess, onClick: () => setShowProcess(value => !value) }, showProcess ? '收起工作过程' : '工作过程'), h('button', { type: 'button', className: 'kode-collab-button', disabled: history?.loading, onClick: () => void data.loadMessages(team.conversation_id) }, history?.loading ? '正在读取…' : '刷新对话')),
      showManagement && h(React.Fragment, null,
        h(ContactPreferenceControls, { team, storage: outboxStorage, onChanged: () => data.refreshContacts() }),
        h(TeamManagementView, { key: team.id, team, request: requestCollabRead, storage: outboxStorage })),
      showBudget && h(BudgetView, { team, request: requestCollabRead, storage: outboxStorage }),
      showProcess && h(ProcessView, { key: team.id, team, request: requestCollabRead, storage: outboxStorage, onFollowup: followup, onOpenSession: managedSessions?.open }),
      h(MessageWindow, { items: history?.items ?? [], team, heightCache: heightsFor(team), scrollRef: scroll, onScroll: event => { if (restoredScroll.current.done) view.saveConversation(team.conversation_id, { scrollTop: event.currentTarget.scrollTop }) } },
        history?.loaded && !history.items.length && h('p', { className: 'kode-collab-note' }, '这段长期对话还没有消息。'),
        history?.readError && h('p', { role: 'status', className: 'kode-collab-note' }, history.readError),
        history?.error && h('p', { role: 'status', className: 'kode-collab-note' }, history.error),
        history?.hasMore && h('button', { type: 'button', className: 'kode-collab-button', disabled: history.loading, onClick: () => void data.loadMessages(team.conversation_id) }, '继续读取消息')),
      team.spec?.kind === 'coordinator' ? (draftState?.ready
        ? h(Composer, { key: team.conversation_id, team, priorRunId, onClearFollowup: clearFollowup })
        : h('div', { role: 'status', className: 'kode-collab-note' }, draftState?.error || '正在恢复草稿…', draftState?.error && h('button', { type: 'button', className: 'kode-collab-button', onClick: () => void conversationViews.reopen(team).catch(() => {}) }, '重新读取草稿')))
        : h('p', { className: 'kode-collab-note kode-collab-preview' }, '创建助手的对话入口仍在接入。'))
  }
  function Main() {
    const state = useView(), directory = useData()
    const team = directory.knownTeams[state.lastSuperagentId]
    useEffect(() => { if (!directory.directoryLoaded) void data.loadTeams() }, [directory.directoryLoaded])
    if (state.lastSuperagentId === 'kode-builtin-builder') return h(BuilderView, { request: requestCollabRead, storage: outboxStorage, onTeamSaved: () => { void data.loadTeams() } })
    if (team) return h(Conversation, { key: team.conversation_id, team })
    return h('section', { className: 'kode-collab-empty' },
      h('h1', null, state.lastSuperagentId === 'kode-builtin-builder' ? '团队搭建助手' : '与 Superagent 对话'),
      h('p', null, state.lastSuperagentId === 'kode-builtin-builder' ? '创建助手的配置界面仍在接入，当前入口不会创建团队或启动任务。' : '从联系人中选择一个团队，查看长期对话。'),
      directory.directoryError && h('p', { role: 'status' }, directory.directoryError), h(ModeSwitch))
  }
  // One shell owner; preserve the native registrations, injections and child slot declarations.
  function adapt(slot, render) {
    return ctx.slots.inject(slot, () => {
      const adapted = new Map()
      const install = () => {
        for (const entry of ctx.slots.entries(slot)) {
          if (adapted.has(entry) || (entry.locale ?? entry.options.locale) !== 'sidebar') continue
          const original = entry.component
          if (typeof original !== 'function') continue
          const wrapper = props => { const state = useView(); return state.mode === 'im' ? render(props) : h(original, props) }
          adapted.set(entry, { original, wrapper }); entry.component = wrapper
        }
      }
      const off = ctx.slots.subscribe(slot, install); install()
      return () => { off(); for (const [entry, { original, wrapper }] of adapted) if (entry.component === wrapper) entry.component = original }
    })
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'kode-collab' }, Main))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'kode-collab-mode' }, ModeSwitch))
  adapt('sidebar', props => h(Contacts, props))
  adapt('shell.leading', props => h('div', { className: 'kode-collab-toolbar' }, h('button', { type: 'button', className: 'kode-collab-button', onClick: props.toggleSidebar }, '联系人'), h(ModeSwitch)))
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => style.remove()
  }, 'kode.collab.styles')
  // The main registration may appear after plugin application. Restore IM only once it exists.
  ctx.effect(() => {
    const restore = () => {
      if (view.getSnapshot().mode !== 'im') restorePending = false
      if (restorePending && ctx.slots.entries('main').some(entry => entry.options.key === 'kode-collab')) { restorePending = false; ctx.layout.selectPanel('kode-collab') }
    }
    const off = ctx.slots.subscribe('main', restore); restore(); return off
  }, 'kode.collab.restore')
}
