  const childStatusLabels = { running: '运行中', awaiting: '等待操作', completed: '已完成', failed: '失败', cancelled: '已停止', idle: '空闲', disconnected: '连接中断', unknown: '状态未知' }
  const childDotStates = { running: 'ongoing', awaiting: 'awaiting', completed: 'done', failed: 'error' }
  // The task body is Markdown; a title line drops heading/quote prefixes and emphasis/code markers.
  const childTitle = child => child.name || child.task?.split('\n')[0]?.replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '').replace(/\*\*|~~|`/g, '').trim().slice(0, 120) || '子 Agent'
  const childStatusLabel = child => childStatusLabels[child.status] ?? childStatusLabels.unknown
  const childStateDot = child => h(StateDot, { state: childDotStates[child.status] ?? 'idle', size: 14 })
  const deliveryStatusLabels = { queued: '已入队', received: '已到达目标节点', delivering: '正在投递', accepted: '已交给目标会话', uncertain: '投递结果待确认', rejected: '已拒绝', expired: '已过期' }
  function useSlotEntry(slots, seat, id) {
    const subscribe = useCallback(listener => slots.subscribe(seat, listener), [slots, seat])
    return useSyncExternalStore(subscribe, () => slots.entries(seat).some(entry => entry.options.id === id))
  }
  function legacyHeader(Component) {
    return function LegacyHeaderControl({ slots, ...props }) {
      const hasPanel = useSlotEntry(slots, 'conversation.session.header.utilities', 'session-panel')
      return hasPanel ? null : h(Component, props)
    }
  }
  // `hint` names what the leading icon shows: a tooltip for pointers and hidden text for screen readers.
  function SessionPanelRow({ icon, label, hint, preview, detail, detailTitle = detail, trailing, actionLabel, onClick, expanded, href, compact }) {
    const body = [
      h('span', { key: 'icon', 'data-row-part': 'icon', 'aria-hidden': true, title: preview ? undefined : hint }, icon),
      h('span', { key: 'label', 'data-row-part': 'lines' },
        h('span', { 'data-row-part': 'content', title: preview ? undefined : label }, label),
        hint && h('span', { className: 'kode-sr-only' }, `，${hint}`),
        detail && h('span', { 'data-row-part': 'detail', title: preview ? undefined : detailTitle }, detail)),
    ]
    const anchor = href ? h('a', { 'data-row-part': 'body', className: 'kode-panel-link', href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': actionLabel }, body) :
        onClick ? h('button', { type: 'button', 'data-row-part': 'body', 'aria-label': actionLabel, 'aria-expanded': expanded, onClick }, body) :
          h('span', { 'data-row-part': 'body' }, body)
    return h('div', { 'data-session-panel-row': '', 'data-kode-panel-row': '', 'data-kode-compact': compact ? '' : undefined },
      preview ? h(Tooltip, { label: h('span', {style:{display:'grid',gap:3,whiteSpace:'normal',overflowWrap:'anywhere'}}, h('strong',null,preview[0]), ...preview.slice(1).map((line,i) => h('span',{key:i},line))), side: 'bottom', maxWidth: 360, delayMs: 350, portal: true }, anchor) : anchor,
      trailing && h('span', { 'data-row-part': 'trailing' }, trailing))
  }
  function SessionGitLocation({ git }) {
    if (!git?.root || !['primary', 'worktree'].includes(git.kind)) return null
    const branch = git.branch || (git.commit ? `游离 HEAD · ${git.commit.slice(0, 8)}` : '游离 HEAD')
    const kind = git.kind === 'worktree' ? '独立 worktree' : '主工作区'
    return h('div', { className: 'kode-environment-git', role: 'group', 'aria-label': 'Git 工作位置' },
      h(IconBranchOutlineRegular, { size: 14, 'aria-hidden': true }),
      h('div', { className: 'kode-environment-ref' },
        h(Tooltip, { label: git.branch ? `当前分支：${git.branch}` : git.commit || branch, side: 'left', delayMs: 400, portal: true },
          h('code', { tabIndex: 0 }, branch)),
        h('span', { title: git.root, className: 'kode-environment-kind' }, kind)))
  }
  function SessionProjectLocation({ native, ...props }) {
    const { sessionId, useProjection, useSessions } = props
    const current = useProjection('workingDirectory'), created = useSessions(snapshot => snapshot.byId[sessionId]?.cwd)
    const cwd = current ?? created
    const running = useSessions(snapshot => snapshot.byId[sessionId]?.running === true)
    const host = useSyncExternalStore(
      useCallback(listener => transport?.subscribe(listener) ?? (() => {}), []),
      useCallback(() => transport?.current ?? 'local', []))
    const key = JSON.stringify([host, sessionId, cwd]), [snapshot, setSnapshot] = useState(null)
    useEffect(() => {
      if (!sessionId) return
      const lifetime = new AbortController()
      let loading = false
      const refresh = async () => {
        if (document.visibilityState === 'hidden' || loading) return
        loading = true
        try {
          const query = new URLSearchParams({ sessionId })
          const response = await fetchHost(`/api/kode/session-environment?${query}`, {
            credentials: 'same-origin', cache: 'no-store',
            signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(6000)]),
          }, host)
          const value = response.ok ? await response.json() : null
          if (!lifetime.signal.aborted) setSnapshot({ key, git: value?.git })
        } catch {
          if (!lifetime.signal.aborted) setSnapshot({ key, git: null })
        } finally { loading = false }
      }
      void refresh()
      window.addEventListener('focus', refresh)
      document.addEventListener('visibilitychange', refresh)
      return () => {
        lifetime.abort()
        window.removeEventListener('focus', refresh)
        document.removeEventListener('visibilitychange', refresh)
      }
    }, [key, host, sessionId, running])
    const git = snapshot?.key === key ? snapshot.git : null
    return h('div', { className: 'kode-environment-project', 'data-git': git ? git.kind : undefined },
      git && h(SessionGitLocation, { git }),
      h(native, props))
  }
  function PanelList({ rows, renderFactorySlot, renderRow, visibleLimit = 3 }) {
    const [expanded, setExpanded] = useState(false)
    const limit = visibleLimit, foldable = rows.length > limit
    const label = expanded ? '收起' : `显示另外 ${rows.length - limit} 项`
    return h(React.Fragment, null,
      (expanded ? rows : rows.slice(0, limit)).map(renderRow),
      foldable && renderFactorySlot('conversation.session.panel.fold', { expanded, label, name: label, onToggle: () => setExpanded(value => !value) }))
  }
  function DisclosurePanelRows({ rows, renderFactorySlot, rowProps, content }) {
    const [selected, setSelected] = useState(null)
    return h(PanelList, { rows, renderFactorySlot, renderRow: row => {
      const expanded = selected === row.id
      return h(React.Fragment, { key: row.id },
        h(SessionPanelRow, { ...rowProps(row), compact: true, expanded, onClick: () => setSelected(expanded ? null : row.id) }),
        expanded && h('div', { className: 'kode-panel-detail' }, content(row)))
    } })
  }
  const cardKey = sessionId => `${transport?.current ?? 'local'}:${sessionId}`
  function NativeSubagentRows({ sessionId, useProjection, renderFactorySlot }) {
    const state = useProjection('kodeNativeSubagents')
    if (!Object.keys(state ?? {}).length) return null
    const rank = { awaiting: 0, running: 1 }
    const rows = Object.values(state).reverse().sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2))
    return h(DisclosurePanelRows, { key: cardKey(sessionId), rows, renderFactorySlot,
      rowProps: child => ({ label: childTitle(child), hint: childStatusLabel(child), detail: child.model, icon: childStateDot(child),
        trailing: h(IconChevronDownOutlineRegular, { size: 14, 'aria-hidden': true }) }),
      content: child => h(React.Fragment, null,
        h('p', { className: 'kode-panel-meta' }, [childStatusLabel(child), child.model].filter(Boolean).join(' · ')),
        h(PanelMarkdown, { text: child.task }),
        child.output?.trim() ? h(PanelMarkdown, { text: child.output }) : h('p', null, '暂无输出记录。')),
    })
  }
  function relayKind(row, rows) {
    if (row.direction !== 'sent') return row.reply ? 'reply' : answeredBy(rows, row.id, row.nodeId, row.sessionId) ? 'responded' : 'incoming'
    if (row.reply) return 'replied'
    if (row.answered === true) return 'answered'
    return rows.some(other => other.direction === 'received' && other.replyTo === row.id && other.nodeId === row.nodeId && other.sessionId === row.sessionId) ? 'answered' : 'waiting'
  }
  // Untitled history gets a generic label so a collapsed card never leaks message content.
  function relayTitle(row) {
    return row.title?.trim() || (row.reply || row.replyTo ? '会话回复' : '会话消息')
  }
  // The collapsed row names the other end ("发往"/"来自" + its session title) next to the message title, never the body.
  // This session is the implied other side; the expanded detail spells out both ends.
  function relayPeer(row, nameOf) {
    return { direction: row.direction === 'sent' ? '发往' : '来自', name: row.sessionId ? nameOf(row.nodeId, row.sessionId) : '对端会话' }
  }
  function CommunicationRows({ sessionId, sessions, messages, renderFactorySlot }) {
    const nameOf = useNames(sessions)
    return h(DisclosurePanelRows, { key: cardKey(sessionId), rows: messages.toReversed(), renderFactorySlot,
      rowProps: row => {
        const key = relayKind(row, messages), kind = relayKinds[key], peer = relayPeer(row, nameOf), title = relayTitle(row)
        const { badge, label: delivery } = relayBadge(row, key), state = [kind.label, delivery].filter(Boolean).join('，')
        return { icon: relayIcon(key, badge),
          label: title, hint: state,
          preview: [title, peer.direction + ' ' + peer.name + ' · ' + state],
          detail: h('span', { className: 'kode-relay-peer' }, h('span', { className: 'kode-relay-direction' }, peer.direction), ' ', peer.name),
          detailTitle: `${peer.direction} ${peer.name}`, actionLabel: `${title}，${state}，${peer.direction} ${peer.name}`,
          trailing: h(IconChevronDownOutlineRegular, { size: 14, 'aria-hidden': true }) }
      },
      content: row => {
        const kind = relayKinds[relayKind(row, messages)], status = row.direction === 'sent' && deliveryStatusLabels[row.deliveryStatus ?? row.status]
        const peer = relayPeer(row, nameOf), here = `本会话 ${nameOf(undefined, sessionId)}`
        const route = row.direction === 'sent' ? `${here} → ${peer.name}` : `${peer.name} → ${here}`
        return h(React.Fragment, null,
          h('p', { className: 'kode-panel-meta' }, [kind.label, route, status && `发送时${status}`].filter(Boolean).join(' · ')),
          h(PanelMarkdown, { text: row.content }))
      },
    })
  }
  function KodeCommunication(props) {
    const messages = props.useProjection('kodeSessionPanel', state => state?.relays)
    return messages?.length ? h(CommunicationRows, { ...props, messages }) : null
  }
  function SessionReviewLinks({ sessionId, useProjection, renderFactorySlot, nativeChanges }) {
    const reviews = useProjection('kodeSessionPanel', state => state?.reviews)
    const tracked = new Set((nativeChanges ?? []).map(entry => entry.url?.split(/[?#]/)[0].replace(/\/$/, '')))
    const rows = reviews?.filter(row => /^https?:\/\//i.test(row.url) && !tracked.has(row.url)).toReversed()
    const host = transport?.current ?? 'local'
    const [provider,setProvider] = useState({host,states:{}})
    const urls = (rows ?? []).map(row => row.url).filter(url => /^https:\/\/github\.com\/|^https?:\/\/git\.woa\.com\//.test(url)).join('\n')
    useEffect(() => {
      if (!urls) return
      let active=true, busy=false
      const stop=new AbortController()
      async function refresh() {
        if (busy || document.visibilityState === 'hidden') return
        busy=true
        try {
          const links=urls.split('\n')
          for(let i=0;i<links.length && active;i+=20) {
            const params=new URLSearchParams(links.slice(i,i+20).map(u=>['url',u]))
            const response=await fetchHost('/api/kode/review-status?'+params,{credentials:'same-origin',signal:stop.signal},host)
            if (!response.ok) continue
            const states=await response.json()
            if(active) setProvider(prior=>({host,states:{...(prior.host===host?prior.states:{}),...states}}))
          }
        } catch {} finally { busy=false }
      }
      void refresh()
      const timer=setInterval(refresh,60000)
      document.addEventListener('visibilitychange',refresh)
      return ()=>{active=false;stop.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refresh)}
    },[host,urls])
    const resolved = rows?.map(row => provider.host===host && provider.states[row.url] ? {...row,status:provider.states[row.url]} : row)
    const finished = row => row.status === 'merged' || row.status === 'closed'
    const labels = {open:'打开',closed:'已关闭',merged:'已合入',draft:'草稿'}
    const ordered = resolved && [...resolved.filter(row => !finished(row)), ...resolved.filter(finished)]
    return rows?.length ? h(PanelList, { key: cardKey(sessionId), rows:ordered, visibleLimit:Math.min(3,resolved.filter(row => !finished(row)).length), renderFactorySlot,
      renderRow: row => h(SessionPanelRow, { key: row.url, href: row.url, compact: true, icon: h('span',{className:'kode-review-symbol'},h(IconBranchOutlineRegular, { size: 16 }),
          row.status && h('i',{'data-review-status':row.status})),
        preview: [`${row.repo} · ${row.kind} #${row.number}`, labels[row.status] ?? '状态未知', row.url],
        label: `${row.kind} #${row.number}`, detail: row.repo, actionLabel: `打开 ${row.repo} 的 ${row.kind} #${row.number}，${labels[row.status] ?? '状态未知'}`,
        trailing: h(IconChevronRightOutlineRegular, { size: 14, 'aria-hidden': true }) }),
    }) : null
  }
  function ForgeReviewLinks({ usePanel, ...props }) {
    const nativeChanges = usePanel(state => state.state?.changeRequests)
    return h(SessionReviewLinks, { ...props, nativeChanges })
  }
  function FallbackPanelSection({ slots, nativeId, component, ...props }) {
    return useSlotEntry(slots, CARD_SECTIONS, nativeId) ? null : h(component, props)
  }
  function BotSessionBoardSection({ sessionId, dismissOverlay }) {
    const host = useWorkspaceDirectory().current
    const roster = useBotsData(), bot = host === 'local' ? botOfSession(roster, sessionId) : undefined
    const watchData = useWatches().data
    const [title, setTitle] = useState(''), [busy, setBusy] = useState(false)
    if (!bot) return null
    const tasks = (watchData?.tasks ?? []).filter(t => t.bot === bot.id && t.status !== 'cancelled')
    const seen = new Set(tasks.map(t => t.session_uuid).filter(Boolean))
    const watchesById = new Map((watchData?.watches ?? []).map(w => [w.id, w]))
    const activeRuns = (watchData?.runs ?? []).filter(r => r.bot === bot.id && (!r.session_uuid || !seen.has(r.session_uuid)) && ['needs_user', 'starting', 'running'].includes(r.status))
    const needs = [
      ...tasks.filter(t => t.status === 'needs_user').map(t => ({ key: `t:${t.id}`, title: t.title, status: 'needs_user', task: t })),
      ...activeRuns.filter(r => r.status === 'needs_user').map(r => ({ key: `r:${r.id}`, title: watchesById.get(r.watch_id)?.spec?.name ?? '关注任务', status: 'needs_user', run: r })),
    ]
    const working = [
      ...tasks.filter(t => t.status === 'in_progress').map(t => ({ key: `t:${t.id}`, title: t.title, status: 'in_progress', task: t })),
      ...activeRuns.filter(r => r.status !== 'needs_user').map(r => ({ key: `r:${r.id}`, title: watchesById.get(r.watch_id)?.spec?.name ?? '后台执行', status: 'in_progress', run: r })),
    ]
    const waiting = tasks.filter(t => t.status === 'waiting' || t.status === 'planned').map(t => ({ key: `t:${t.id}`, title: t.title, status: t.status, task: t }))
    const openFullBoard = () => {
      dismissOverlay?.()
      requestedBotTasks = bot.id
      openBotsPage?.()
      window.dispatchEvent(new CustomEvent('kode-bot-tasks'))
    }
    const quickAdd = async event => {
      event.preventDefault()
      if (!title.trim() || busy) return
      setBusy(true)
      try { await taskAct({ action: 'task_upsert', task: { bot: bot.id, title: title.trim() } }); setTitle('') }
      catch { /* Handled on full board */ }
      finally { setBusy(false) }
    }
    const preview = [...needs, ...working, ...waiting].slice(0, 5)
    return h('div', { className: 'kode-session-bot-board' },
      h('div', { className: 'kode-session-bot-counts' },
        h('span', { className: 'kode-kanban-pill is-amber' }, `待处理 ${needs.length}`),
        h('span', { className: 'kode-kanban-pill is-blue' }, `进行中 ${working.length}`),
        h('span', { className: 'kode-kanban-pill is-slate' }, `计划 ${waiting.length}`)),
      preview.length > 0
        ? h('ul', { className: 'kode-session-bot-items' }, ...preview.map(item => h('li', { key: item.key, className: `kode-session-bot-item is-${item.status}` },
          h('span', { className: 'kode-session-bot-item-dot', 'aria-hidden': true }),
          h('span', { className: 'kode-session-bot-item-title', title: item.task?.reason || item.run?.summary || item.title }, item.title),
          item.task?.status === 'needs_user' && item.task?.kind === 'task' && h('button', {
            type: 'button',
            className: 'kode-session-bot-item-act',
            disabled: busy,
            onClick: () => void taskAct({ action: 'task_upsert', task: { id: item.task.id, status: 'in_progress', reason: '' } }),
          }, '继续'))))
        : h('p', { className: 'kode-secondary kode-session-bot-empty' }, '看板暂无待办，可在下方快速记录。'),
      h('form', { className: 'kode-session-bot-add', onSubmit: quickAdd },
        h('input', { 'aria-label': '快速新增任务', placeholder: `给 ${bot.name} 加一条任务…`, value: title, disabled: busy, onChange: event => setTitle(event.target.value) }),
        h(Button, { type: 'submit', size: 'sm', variant: 'ghost', disabled: busy || !title.trim() }, '添加')),
      h(Button, { size: 'sm', variant: 'outline', onClick: openFullBoard }, '打开完整看板'))
  }
  function BotSessionConnectorsSection({ sessionId, dismissOverlay }) {
    const host = useWorkspaceDirectory().current
    const roster = useBotsData(), bot = host === 'local' ? botOfSession(roster, sessionId) : undefined
    if (!bot) return null
    const connectors = bot.connectors ?? []
    const openConnectors = () => {
      dismissOverlay?.()
      requestedBotConnectors = bot.id
      openBotsPage?.()
      window.dispatchEvent(new CustomEvent('kode-bot-connectors'))
    }
    return h('div', { className: 'kode-session-bot-connectors' },
      connectors.length > 0
        ? h(BotConnectorChips, { connectors })
        : h('p', { className: 'kode-secondary kode-session-bot-empty' }, '尚未接入企微、GitHub、Webhook 或 MCP 应用。'),
      h(Button, { size: 'sm', variant: 'outline', onClick: openConnectors }, connectors.length ? '管理连接器' : '添加连接器'))
  }
  function installSessionPanel(ctx) {
    const session = sessionId => ({ sessionId, sessions: ctx.sessions, slots: ctx.slots })
    ctx.slots.inject(CARD_ENVIRONMENT, function* () {
      yield ctx.slots.register({ name: CARD_ENVIRONMENT, id: 'kode-agent-profile', order: -10, inject: session }, props => h(AgentIdentity, { ...props, panel: true }))
    })
    wrapSlot(ctx, CARD_ENVIRONMENT, entry => entry.options.id === 'project',
      native => props => h(SessionProjectLocation, { ...props, native }))
    ctx.slots.inject(CARD_SECTIONS, function* () {
      yield ctx.slots.register({ name: CARD_SECTIONS, id: 'kode-bot-board', order: 50, label: () => '伙伴看板', inject: session }, BotSessionBoardSection)
      yield ctx.slots.register({ name: CARD_SECTIONS, id: 'kode-bot-connectors', order: 60, label: () => '连接器', inject: session }, BotSessionConnectorsSection)
      yield ctx.slots.register({ name: CARD_SECTIONS, id: 'kode-review-links', order: 100, label: () => '代码评审', inject: session },
        props => h(FallbackPanelSection, { ...props, nativeId: 'change-requests', component: SessionReviewLinks }))
      yield ctx.slots.register({ name: CARD_SECTIONS, id: 'kode-child-agents', order: 200, label: () => '子 Agent', inject: session },
        props => h(FallbackPanelSection, { ...props, nativeId: 'subagents', component: NativeSubagentRows }))
      yield ctx.slots.register({ name: CARD_SECTIONS, id: 'kode-communication', order: 250, label: () => '会话通信', inject: session }, KodeCommunication)
    })
    wrapSlot(ctx, CARD_SECTIONS, entry => entry.options.id === 'change-requests', native => props => h(React.Fragment, null,
      h(native, props), props.usePanel ? h(ForgeReviewLinks, props) : h(SessionReviewLinks, props)))
    wrapSlot(ctx, CARD_SECTIONS, entry => entry.options.id === 'subagents', native => props => h(React.Fragment, null,
      h(FilteredSubagentCatalog, { ...props, native }), h(NativeSubagentRows, props)))
    wrapSlot(ctx, 'conversation.session.panel.section.actions', entry => entry.options.key === 'subagents',
      native => props => h(FilteredSubagentCatalog, { ...props, native }))
    wrapSlot(ctx, 'conversation.session.panel.indicator', entry => entry.options.id === 'subagents.running',
      native => props => h(FilteredSubagentCatalog, { ...props, native }))
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'kode-handoff-dialog', inject: () => ({ sessions: ctx.sessions }) }, HandoffOverlay))
    ctx.slots.inject('conversation.session.header.actions', function* () {
      yield ctx.slots.register({ name: 'conversation.session.header.actions', id: 'kode-native-subagents', order: -110, inject: session }, legacyHeader(NativeSubagentActivity))
      yield ctx.slots.register({ name: 'conversation.session.header.actions', id: 'kode-agent-identity', order: -100, inject: session }, legacyHeader(AgentIdentity))
      yield ctx.slots.register({ name: 'conversation.session.header.actions', id: 'kode-handoff', order: 100, inject: session }, legacyHeader(HandoffAction))
    })
  }
  function NativeSubagentDetails({ child, onClose }) {
    return h(Modal, { open: true, title: childTitle(child), closeLabel: '关闭', onClose, className: 'kode-subagent-dialog' },
      h('div', { className: 'kode-subagent-status' }, childStateDot(child), childStatusLabel(child),
        child.model && h('span', { className: 'kode-secondary' }, child.model)),
      child.task?.trim() && h('section', { className: 'kode-subagent-section' }, h('h4', null, '任务'), h(PanelMarkdown, { text: child.task })),
      h('section', { className: 'kode-subagent-section' }, h('h4', null, '已记录的输出'),
        child.output?.trim() ? h(PanelMarkdown, { text: child.output }) : h('p', { className: 'kode-config-note' }, '暂无输出记录。')))
  }
  function NativeSubagentActivity({ sessionId, useProjection }) {
    const children = useProjection('kodeNativeSubagents')
    const [open, setOpen] = useState(false), [selected, setSelected] = useState(null)
    useEffect(() => { setOpen(false); setSelected(null) }, [sessionId])
    const active = Object.values(children ?? {}).filter(child => child.status === 'running' || child.status === 'awaiting')
    const child = selected?.sessionId === sessionId ? children?.[selected.id] : undefined
    const state = active.some(child => child.status === 'awaiting') ? 'awaiting' : 'running'
    const label = `${active.length} 个活跃子 Agent${state === 'awaiting' ? '，有任务等待操作' : ''}`
    return h(React.Fragment, null,
      active.length > 0 && h(Menu, {
        open, onClose: () => setOpen(false), portal: true,
        anchor: h('button', { type: 'button', className: 'kode-trigger kode-subagent-trigger', 'aria-label': label, title: label,
          'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
        h(IconUsersOutlineRegular, { size: 16, 'aria-hidden': true }), active.length, childStateDot({ status: state })),
        items: active.map(child => ({ id: child.id, icon: childStateDot(child), label: h('span', { className: 'kode-subagent-menu-item' },
          h('span', null, childTitle(child)), h('small', { className: 'kode-secondary' }, childStatusLabel(child))) })),
        onSelect: id => { setOpen(false); setSelected({ sessionId, id }) },
      }),
      child && h(NativeSubagentDetails, { child, onClose: () => setSelected(null) }))
  }
  const nativeCatalogCache = new WeakMap()
  function hideLegacyNativeChildren(state) {
    let projectionsBySession = state.projectionsBySession
    if (!projectionsBySession) return state
    const cached = nativeCatalogCache.get(projectionsBySession)
    if (cached) return cached === projectionsBySession ? state : { ...state, projectionsBySession: cached }
    for (const [id, snapshot] of Object.entries(state.projectionsBySession)) {
      const catalog = snapshot.values?.subagentCatalog
      if (!Array.isArray(catalog)) continue
      const entries = catalog.filter(child => child.mode !== 'external' || !child.id?.startsWith('kode-native:'))
      if (entries.length === catalog.length) continue
      if (projectionsBySession === state.projectionsBySession) projectionsBySession = { ...projectionsBySession }
      projectionsBySession[id] = { ...snapshot, values: { ...snapshot.values, subagentCatalog: entries } }
    }
    nativeCatalogCache.set(state.projectionsBySession, projectionsBySession)
    return projectionsBySession === state.projectionsBySession ? state : { ...state, projectionsBySession }
  }
  function FilteredSubagentCatalog({ native, useSessions, ...props }) {
    const useFilteredSessions = React.useCallback(select => useSessions(state => select(hideLegacyNativeChildren(state))), [useSessions])
    return h(native, { ...props, useSessions: useFilteredSessions })
  }
  function NativeSubagentTool({ block, useDisclosure, useProjection }) {
    const { expanded: open, setExpanded: setOpen } = useDisclosure()
    const [details, setDetails] = useState(false)
    const id = block.args.text('id'), title = block.args.text('title')
    const projected = useProjection('kodeNativeSubagents', state => state?.[id])
    const child = { name: title === id ? undefined : title, task: block.args.text('task'), ...projected }
    const name = childTitle(child)
    return h('section', { className: 'kode-message-tool', 'aria-label': `子 Agent ${name}` },
      h('button', { type: 'button', className: 'kode-tool-heading', 'aria-expanded': open, onClick: () => setOpen(!open) },
        h(IconAgentPresetOutlineRegular, { size: 14 }), h('span', { className: 'kode-tool-action' }, name),
        h('span', { className: 'kode-tool-summary' }, childStatusLabel(child)), childStateDot(child),
        h(IconChevronDownOutlineRegular, { size: 12, className: open ? 'kode-chevron-open' : '' })),
      open && h(React.Fragment, null,
        child.task && h('p', { className: 'kode-native-input' }, child.task),
        child.output && h(ConsoleOutput, { text: child.output }),
        h('div', { className: 'kode-tool-detail' }, h(Button, { variant: 'outline', onClick: () => setDetails(true) }, '查看子 Agent'))),
      details && h(NativeSubagentDetails, { child, onClose: () => setDetails(false) }))
  }
  function NativeOperationTool({toolName,phase,block,useDisclosure}) {
    const {expanded:open,setExpanded:setOpen}=useDisclosure()
    let input=block.args.value?.('input') ?? block.args.value?.('rawInput') ?? {}
    let output=textContent(block.content), result
    try{result=JSON.parse(output)}catch{}
    if(typeof input==='string'){try{input=JSON.parse(input)}catch{input={command:input}}}
    if(!Object.keys(input ?? {}).length)input=result?.input ?? result?.rawInput ?? {}
    const command=block.args.text('cmd') || block.args.text('command') || input?.command || input?.cmd
    const patch=block.args.text('patch')
    const editing=['apply_patch','kode_native_fileChange'].includes(toolName)
    const kind=block.args.text('kind'), nativeTitle=block.args.text('title')
    const title=editing?'修改文件':command||kind==='execute'||/^(terminal|bash)$/i.test(nativeTitle??'')?'执行命令':kind==='read'?'读取文件':kind==='search'?'搜索':nativeTitle||'Agent 操作'
    const preview=editing ? changedFileSummary({ path: block.args.text('path') || input?.file_path || input?.path, paths: block.args.value?.('paths'), changes: result?.changes ?? block.args.value?.('changes') ?? input?.changes, patch }) : command || block.args.text('path') || input?.file_path || input?.path || (nativeTitle!==title?nativeTitle:undefined) || block.args.text('reason')
    if(result?.aggregatedOutput!==undefined)output=result.aggregatedOutput
    if(editing){try{const value=JSON.parse(output);if(Array.isArray(value.changes))output=value.changes.map(change=>[change.path,change.diff].filter(Boolean).join('\n')).join('\n\n')}catch{/* A native patch result can also be ordinary text. */}}
    const label = block.isError ? '执行未完成' : command ? (phase === 'result' ? '已执行' : '正在执行') : editing ? (phase === 'result' ? '已修改' : '正在修改') : title
    const terminalLabels = { commandLine: n => `命令第 ${n} 行`, signal: value => `信号 ${value}`, exitCode: value => `退出码 ${value}`, noExitCode: '未提供退出码', running: '运行中', failed: '未完成', done: '已结束', copy: '复制', copied: '已复制', noOutput: '无输出', collapseAria: '收起输出', collapse: '收起', expandAria: n => `展开剩余 ${n} 行`, expand: n => `展开 ${n} 行` }
    return h('section',{className:'kode-message-tool'},
      h('button',{type:'button',className:'kode-tool-heading','aria-expanded':open,onClick:()=>setOpen(!open)},h(editing ? IconEditOutlineRegular : IconApiOutlineRegular,{size:14}),h('span',{className:'kode-tool-action'},label),preview && h('span',{className:'kode-tool-summary',title:String(preview)},String(preview).split('\n')[0]),h(IconChevronDownOutlineRegular,{size:12,className:open?'kode-chevron-open':''})),
      open && (command ? h(TerminalBlock,{command,output:output || undefined,exitCode:result?.exitCode,running:phase!=='result',runStateDot:false,maxLines:24,labels:terminalLabels,className:'kode-tool-terminal'}) : h(React.Fragment,null,preview && h('code',{className:'kode-native-input'},preview),(output || (editing && patch)) && h(ConsoleOutput,{text:output || patch}))))
  }
  function ConsoleOutput({ text }) {
    const rows = [], pattern = /^```(?:console|shellsession|terminal|bash|sh|zsh)[^\S\r\n]*\r?\n[\s\S]*?^```[^\S\r\n]*$/gm
    let offset = 0, match
    while ((match = pattern.exec(text))) {
      if (match.index > offset) rows.push(h('pre', { className: 'kode-native-output', key: offset }, text.slice(offset, match.index)))
      rows.push(h('div', { className: 'kode-console-output', key: match.index }, h(MarkdownText, { text: match[0], labels: markdownLabels })))
      offset = pattern.lastIndex
    }
    if (offset < text.length) rows.push(h('pre', { className: 'kode-native-output', key: offset }, text.slice(offset)))
    return h(React.Fragment, null, ...rows)
  }
  function RelayTrigger(props) {
    const entries = useSyncExternalStore(fn => props.slots.subscribe('conversation.chat.node', fn), () => props.slots.entries('conversation.chat.node'))
    const nameOf = useNames(props.sessions)
    const relay = parseRelay(props.node.data)
    if (relay) return h(RelayCard, { relay, time: props.node.data.time, nameOf, sessionId: props.sessionId, node: props.node, useChat: props.useChat, useProjection: props.useProjection })
    // Preserve the native presentation of schedules, goals, and other triggers.
    const original = entries.find(entry => entry.options.key === 'turn-trigger' && entry.component !== RelayTrigger)
    return original ? h(original.component, props) : null
  }
  function MessagingTool({ toolName, block, phase, useDisclosure, sessions, sessionId, useProjection }) {
    const { expanded: open, setExpanded: setOpen } = useDisclosure()
    const nameOf = useNames(sessions)
    const relays = useProjection?.('kodeSessionPanel', state => state?.relays)
    const args = block.args, content = args?.text('content') ?? '', target = [args?.text('node_id'), args?.text('session_id')].filter(Boolean).join('/')
    const raw = textContent(block.content)
    let result
    try { result = JSON.parse(raw) } catch {}
    const title = { kode_sessions_list: '查找会话', kode_sessions_create: '创建协作会话', kode_sessions_send: args?.text('in_reply_to') ? '回复会话' : '发送会话消息', kode_sessions_read: '读取会话消息', kode_sessions_wait: '等待会话回复' }[toolName]
    const status = block.isError ? '调用失败' : phase !== 'result' ? '进行中' : result?.message ? `发送时：${deliveryStatusLabels[result.message.status] ?? result.message.status}` : result?.timed_out ? '暂未收到新消息' : '已返回'
    if (toolName === 'kode_sessions_send' && target) {
      const peer = nameOf(args?.text('node_id'), args?.text('session_id'))
      // Prefer the projected row (it carries later receipts and the answered flag); the call's own result is the fallback.
      const sent = result?.message?.id && relays?.find(row => row.direction === 'sent' && row.id === result.message.id && row.nodeId === args?.text('node_id') && row.sessionId === args?.text('session_id'))
      const kind = sent ? relayKind(sent, relays) : args?.text('in_reply_to') ? 'replied' : 'sent'
      const outcome = block.isError ? { badge: 'fail', label: '未送达：通信未成功' } : phase !== 'result' ? {} : relayBadge(sent || { direction: 'sent', status: result?.message?.status }, kind)
      return h('section', { className: 'kode-relay', 'aria-label': title, 'data-open': open ? '' : undefined },
        h(RelayToggle, { from: currentEnd(nameOf(undefined, sessionId)), to: { name: peer, title: peer }, title: relayTitle({ title: args?.text('title') ?? result?.message?.title ?? relayTitlePrefix(content).title, replyTo: args?.text('in_reply_to') }), open, onToggle: () => setOpen(!open), kind, badge: outcome.badge, state: [relayKinds[kind].label, outcome.label].filter(Boolean).join('，') }),
        open && h('div', { className: 'kode-relay-detail' }, h('p', { className: 'kode-panel-meta' }, `${title} · `, h('span', { className: block.isError ? 'kode-error' : undefined }, status)), h(PanelMarkdown, { text: relayTitlePrefix(content).content, className: 'kode-relay-body' }), h('p', { className: 'kode-config-note' }, '投递状态不代表目标任务已完成。'), block.isError && h(Failure, { text: '通信未成功，可在轨迹中查看原因。' })),
      )
    }
    return h('section', { className: 'kode-message-tool' }, h('button', { type: 'button', className: 'kode-tool-heading', onClick: () => setOpen(!open), 'aria-expanded': open }, h(IconPaperPlaneOutlineRegular, { size: 14 }), h('span', null, title), h('span', { className: block.isError ? 'kode-error' : 'kode-secondary' }, status), h(IconChevronDownOutlineRegular, { size: 12 })),
      target && h('div', { className: 'kode-tool-target' }, `${nameOf(undefined, sessionId)}（当前） → `, nameOf(args?.text('node_id'), args?.text('session_id'))),
      toolName === 'kode_sessions_create' && h('div', { className: 'kode-tool-target' }, `新会话：${result?.title ?? args?.text('title') ?? '协作助手'}${args?.text('host') ? ` · ${args.text('host')}` : ''}`),
      open && h('div', { className: 'kode-tool-detail' }, block.isError && h(Failure, { text: '通信未成功，可在轨迹中查看原因。' }), Array.isArray(result?.sessions) && h('ul', null, ...result.sessions.map(s => h('li', { key: `${s.address.node_id}/${s.address.session_id}` }, nameOf(s.address.node_id, s.address.session_id)))), Array.isArray(result?.events) && h('div', null, ...result.events.map((event, index) => h('p', { key: index }, event.message?.content ?? event.content ?? '收到一条投递状态更新')))),
    )
  }
