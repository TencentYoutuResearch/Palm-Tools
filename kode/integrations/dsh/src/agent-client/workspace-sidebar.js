  async function projectCall(body) {
    const response = await fetch(`/api/kode/project-hosts?current=${encodeURIComponent(transport?.current ?? 'local')}`, { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const value = await parseHostJson(response)
    if (!response.ok) throw new Error(value.error || '无法连接主机。')
    if (body?.action === 'save' || body?.action === 'delete') for (const refresh of hostListeners) refresh()
    return value
  }
  const hostListeners = new Set()
  function useProjectHosts() {
    const [data, setData] = useState({ current: 'local', hosts: [{ id: 'local', name: '此计算机' }] }), [error, setError] = useState('')
    useEffect(() => { let alive = true; const refresh = () => { void projectCall().then(value => { if (alive) { setData(value); setError('') } }, error => { if (alive) setError(error.message) }) }; const unsubscribe = transport?.subscribe(refresh); hostListeners.add(refresh); refresh(); return () => { alive = false; unsubscribe?.(); hostListeners.delete(refresh) } }, [])
    return { data, setData, error, setError }
  }
  // Use the shipped native/browse flow without recursing into our project dialog.
  function DirectoryFlow({ slots, ...owner }) {
    const entries = useSyncExternalStore(fn => slots.subscribe('sidebar.workspaces.directoryFlow', fn), () => slots.entries('sidebar.workspaces.directoryFlow'))
    const candidates = entries.filter(entry => entry.component !== ProjectFlow).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
    const flows = candidates.map(entry => ({ entry, bindings: stableDirectoryBindings(entry, transport?.current ?? 'local') }))
    const remote = transport?.current && transport.current !== 'local'
    const flow = flows.find(flow => remote ? typeof flow.bindings.listDirectory === 'function' : typeof flow.bindings.pick === 'function') ?? (!remote ? flows[0] : undefined)
    return flow ? h(flow.entry.component, { ...flow.bindings, ...owner }) : null
  }
  function RemoteHostForm({ open, initial, onClose, onSaved, supportsDeployment }) {
    const [draft, setDraft] = useState({ name: '', host: '', port: '22', accessUrl: '' }), [busy, setBusy] = useState(false), [error, setError] = useState(''), [job, setJob] = useState(null)
    useEffect(() => { if (open) { setDraft({ name: '', host: '', port: '22', accessUrl: '', ...initial }); setError(''); setJob(null); setBusy(false) } }, [open, initial])
    useEffect(() => {
      if (!open || !job?.id) return
      const events = new EventSource(transport ? transport.path(`/api/kode/project-hosts?deployment=${encodeURIComponent(job.id)}&events=1`, 'local') : `/api/kode/project-hosts?deployment=${encodeURIComponent(job.id)}&events=1`)
      events.onmessage = event => {
        const value = JSON.parse(event.data); setJob(value); setError(value.error ?? '')
        if (value.status !== 'running') { events.close(); setBusy(false); for (const refresh of hostListeners) refresh(); void refreshWorkspaceDirectory() }
      }
      events.onerror = () => setError('进度连接暂时中断，正在重连；部署仍在继续。')
      return () => events.close()
    }, [open, job?.id])
    const deploy = async () => { setBusy(true); setError(''); try { setJob(await projectCall({ ...draft, action: 'deploy' })) } catch (error) { setError(error.message); setBusy(false) } }
    const save = async () => { setBusy(true); setError(''); try { const value = await projectCall({ ...draft, action: 'save' }); onSaved(value, value.id) } catch (error) { setError(error.message) } finally { setBusy(false) } }
    const field = (key, label, placeholder, type = 'text') => h('label', { className: 'kode-field' }, label, h('input', { type, disabled: busy, value: draft[key] ?? '', placeholder, autoComplete: 'off', onChange: event => setDraft({ ...draft, [key]: event.target.value }) }))
    const labels = { connect: '连接主机', package: '准备安装包', upload: '上传服务', runtime: '准备运行环境', dependencies: '安装依赖', start: '启动服务', health: '检查服务', pair: '配对会话服务', save: '保存连接' }
    const complete = job?.status === 'done'
    return h(Modal, { open, title: job ? (complete ? 'SSH 主机已就绪' : '连接 SSH 主机') : initial ? '编辑 SSH 主机' : '添加 SSH 主机', closeLabel: '关闭', onClose: () => { if (!busy) onClose() }, className: 'kode-project-dialog', footer: h(React.Fragment, null,
      !job && initial && h(Button, { className: 'kode-delete', disabled: busy, onClick: async () => { setBusy(true); try { const value = await projectCall({ action: 'delete', id: initial.id }); onSaved(value, 'local') } catch (error) { setError(error.message) } finally { setBusy(false) } } }, '移除主机'),
      !job && initial && supportsDeployment && h(Button, { variant: 'outline', disabled: busy || !draft.host.trim(), onClick: deploy }, '部署或更新服务'),
      job && !busy && !complete && h(Button, { variant: 'outline', onClick: () => { setJob(null); setError('') } }, '修改连接'),
      busy && job && !complete ? h(Button, { variant: 'outline', onClick: () => { void projectCall({ action: 'cancel-deployment', deploymentId: job.id }).catch(error => setError(error.message)) } }, '取消部署') : h(Button, { variant: 'outline', onClick: onClose, disabled: busy }, '关闭'),
      complete ? h(Button, { variant: 'primary', disabled: busy, onClick: async () => { setBusy(true); try { await switchHost(job.result.id); onSaved(job.result, job.result.id) } catch (error) { setError(error.message) } finally { setBusy(false) } } }, busy ? '连接中…' : '连接主机') : h(Button, { variant: 'primary', disabled: busy || !draft.name.trim() || !draft.host.trim() || (!supportsDeployment && !initial && !draft.accessUrl.trim()), onClick: supportsDeployment && (job || (!initial && !draft.accessUrl.trim())) ? deploy : save }, busy ? '处理中…' : job ? '重试部署' : initial || draft.accessUrl.trim() || !supportsDeployment ? '保存主机' : '部署并添加')) },
      job ? h('section', { className: 'kode-deployment', 'aria-label': 'SSH 部署进度', 'aria-busy': busy },
        h('p', { className: 'kode-config-note' }, `${draft.name} · ${draft.host}`),
        h('div', { className: 'kode-deployment-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 9, 'aria-valuenow': job.steps.filter(step => step.status === 'done').length, 'aria-label': '部署完成步骤' }, h('span', { style: { transform: `scaleX(${job.steps.filter(step => step.status === 'done').length / 9})` } })),
        h('ol', { className: 'kode-deployment-steps' }, ...job.steps.map(step => h('li', { key: step.step, 'data-status': step.status }, h('span', { className: 'kode-deployment-state', 'aria-label': ({ pending: '等待', running: '进行中', done: '完成', failed: '失败' })[step.status] }, h(StateDot, { state: ({ pending: 'idle', running: 'ongoing', done: 'done', failed: 'error' })[step.status], size: 16, appearance: 'step', className: 'kode-status-dot' })), h('div', null, h('span', null, labels[step.step]), step.message && h('small', null, step.message))))),
        h('p', { role: 'status', 'aria-live': 'polite', className: 'kode-config-note' }, complete ? '服务已就绪。连接后即可选择远端项目。' : job.status === 'running' ? job.steps.find(step => step.status === 'running')?.message ?? '正在准备…' : '可以修正连接信息后重试。')) : h(React.Fragment, null,
        field('name', '主机名称', '例如：开发服务器'), field('host', 'SSH 地址', 'SSH 配置别名或 user@host'), field('port', 'SSH 端口', '22'),
        h('p', { className: 'kode-config-note' }, supportsDeployment ? '使用已有 SSH 密钥和主机信任记录，自动部署 Kode 服务和 dsh，无需复制访问链接。运行中的远端会话会受到保护。' : '当前服务尚不支持自动部署，请更新服务或填写已有远端 dsh 的访问链接。'),
        h(AdvancedSection, { title: '高级连接设置', open: !supportsDeployment }, field('configFile', 'SSH 配置文件（可选）', '留空使用默认 SSH 配置'), field('accessUrl', '已有服务的访问链接（可选）', initial ? '留空保留已有连接' : '仅用于连接已手工部署的 dsh', 'password'))),
      h(Failure, { text: error }))
  }
  function SshSettings({ host, onBusyChange }) {
    const { data, error: loadError } = useProjectHosts()
    const [editing, setEditing] = useState(false), [initial, setInitial] = useState(undefined), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const hosts = data.hosts.filter(row => row.id !== 'local')
    return h('div', { className: 'kode-agent-settings' },
      h(HostServiceStatus, { key: host, host, onBusyChange }),
      h(PowerSettings, { key: host, host }),
      h('div', { className: 'kode-settings-group' }, h('h3', { className: 'kode-settings-group-title' }, 'SSH 连接'),
        h('div', { className: 'kode-settings-card kode-settings-card-padded kode-ssh-hosts-card' },
          data.current !== 'local' && h('div', null, h('p', { className: 'kode-config-note' }, '当前连接的主机需返回此计算机后编辑，其他主机可直接管理。'), h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: async () => { setBusy(true); try { await switchHost('local') } catch (error) { setError(error.message) } finally { setBusy(false) } } }, '返回此计算机')),
          h('ul', { className: 'kode-agent-rows' }, ...hosts.map(host => h('li', { key: host.id, className: 'kode-agent-row' },
            h('div', { className: 'kode-agent-row-head' }, h(RemoteComputerIcon), h('span', { className: 'kode-agent-name' }, host.name), host.id === data.current && h('span', { className: 'kode-agent-tag' }, '当前主机'), h(Button, { size: 'sm', variant: 'outline', className: 'kode-agent-edit', disabled: host.id === data.current, onClick: () => { setInitial(host); setEditing(true) } }, '编辑')),
            h('span', { className: 'kode-secondary' }, `${host.host}:${host.port}`)))),
          h(Button, { variant: 'outline', className: 'kode-agent-add', onClick: () => { setInitial(undefined); setEditing(true) } }, h(IconPlusOutlineRegular, { size: 16 }), '添加 SSH 主机'))),
      h(Failure, { text: error || loadError }),
      h(RemoteHostForm, { open: editing, initial, supportsDeployment: data.deploymentSupported, onClose: () => setEditing(false), onSaved: () => setEditing(false) }))
  }
  let workspaceSnapshot = { current: 'local', hosts: [], error: '' }, workspacePending
  const workspaceListeners = new Set()
  const workspaceDirectoryStore = { subscribe: fn => { workspaceListeners.add(fn); return () => workspaceListeners.delete(fn) }, getSnapshot: () => workspaceSnapshot }
  async function refreshWorkspaceDirectory() {
    if (workspacePending) return workspacePending
    workspacePending = (async () => {
      try {
        const response = await fetch(`/api/kode/project-hosts?view=directory&current=${encodeURIComponent(transport?.current ?? 'local')}`, { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) throw new Error('会话目录暂不可用')
        workspaceSnapshot = { ...await parseHostJson(response), error: '' }
      } catch (error) { workspaceSnapshot = { ...workspaceSnapshot, error: error.message } }
      finally { workspacePending = undefined; for (const listener of workspaceListeners) listener() }
    })()
    return workspacePending
  }
  function useWorkspaceDirectory() {
    const data = useSyncExternalStore(workspaceDirectoryStore.subscribe, workspaceDirectoryStore.getSnapshot)
    useEffect(() => { void refreshWorkspaceDirectory() }, [])
    return data
  }
  const foreignId = (hostId, id) => `kode-host:${encodeURIComponent(hostId)}/${encodeURIComponent(id)}`
  const cssString = value => `"${Array.from(String(value), ch => `\\${ch.codePointAt(0).toString(16)} `).join('')}"`
  const avatarStateRank = { ongoing: 1, done: 2, awaiting: 3 }
  function preferredAvatarState(...states) {
    return states.reduce((preferred, state) => (avatarStateRank[state] ?? 0) > (avatarStateRank[preferred] ?? 0) ? state : preferred, undefined)
  }
  function sessionStateMap(rows, statuses) {
    const states = new Map()
    for (const [id, row] of Object.entries(rows)) {
      const status = statuses.get(id), running = status?.running ?? row.running, completed = status?.completionUnread ?? row.completed, awaiting = status ? status.pendingInteraction : row.pendingInteraction
      // A previous unread completion can remain set after the next turn starts.
      const state = awaiting ? 'awaiting' : running ? 'ongoing' : completed ? 'done' : undefined
      if (state) states.set(id, state)
    }
    return states
  }
  function workspaceStatusSummary(sessionIds, statuses) {
    const summary = { ongoing: 0, done: 0, awaiting: 0 }
    for (const id of sessionIds) {
      const state = statuses.get(id)
      if (state === 'ongoing' || state === 'done' || state === 'awaiting') summary[state]++
    }
    return summary
  }
  function globalSessionActivity(data, catalog, statuses, archived = []) {
    const counts = { ongoing: 0, done: 0, awaiting: 0 }, seen = new Set()
    const hosts = data.hosts?.length ? data.hosts : [{ id: data.current ?? 'local', sessions: [] }]
    for (const host of hosts) {
      if (host.id !== data.current && host.status && host.status !== 'online') continue
      const own = host.id === data.current
      const hidden = new Set([...(host.hiddenSessionIds ?? []), ...(host.archivedSessionIds ?? []), ...(own ? archived : [])])
      const rows = Object.fromEntries((host.sessions ?? []).map(row => [row.id, row]))
      if (own) {
        Object.assign(rows, catalog.byId ?? {})
        // The live status stream may announce a turn before the catalog row.
        for (const [id, status] of statuses) if (!rows[id] && (status.running || status.pendingInteraction || status.completionUnread)) rows[id] = {}
      }
      for (const [id, row] of Object.entries(rows)) {
        const key = `${host.id}:${id}`
        if (hidden.has(id) || (row.blank && !(own && (statuses.get(id)?.running || statuses.get(id)?.pendingInteraction))) || seen.has(key)) continue
        seen.add(key)
        const state = sessionStateMap({ [id]: row }, own ? statuses : new Map()).get(id)
        if (state) counts[state]++
      }
    }
    const state = preferredAvatarState(...Object.keys(counts).filter(key => counts[key])) ?? 'idle'
    const label = [counts.awaiting ? `${counts.awaiting} 个会话等待操作` : '', counts.done ? `${counts.done} 个会话完成未读` : '', counts.ongoing ? `${counts.ongoing} 个会话正在运行` : ''].filter(Boolean).join(' · ') || '所有会话空闲'
    return { state, counts, label: `全局：${label}` }
  }
  function createGlobalActivityStore() {
    let snapshot = { state: 'idle', counts: { ongoing: 0, done: 0, awaiting: 0 }, label: '全局：所有会话空闲' }
    const listeners = new Set()
    return { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot,
      publish(next) { if (JSON.stringify(snapshot) === JSON.stringify(next)) return; snapshot = next; for (const fn of listeners) fn() },
    }
  }
  const globalActivity = createGlobalActivityStore()
  // Observe data independently of React slots: native windows must not depend
  // on a shell overlay being rendered before their global status can update.
  function installGlobalActivitySubscriptions(ctx) {
    let statusSource, workspaceSource
    const catalogSource = ctx.sessions.list
    const publish = () => globalActivity.publish(globalSessionActivity(
      workspaceDirectoryStore.getSnapshot(), catalogSource.getSnapshot(),
      statusSource?.getSnapshot() ?? emptyAvatarSnapshot(), workspaceSource?.getSnapshot()?.archivedSessionIds ?? []))
    ctx.effect(() => {
      const disposers = [catalogSource.subscribe(publish), workspaceDirectoryStore.subscribe(publish)]
      publish(); void refreshWorkspaceDirectory()
      return () => { for (const dispose of disposers) dispose() }
    }, 'kode.global-activity-catalog')
    ctx.inject(['uiSession', 'uiSession.sessionStatus'], scope => scope.effect(() => {
      statusSource = scope.get('uiSession')?.sessionStatus
      const dispose = statusSource?.subscribe(publish)
      publish()
      return () => { dispose?.(); statusSource = undefined; publish() }
    }, 'kode.global-activity-native'))
    ctx.inject(['workspaces'], scope => scope.effect(() => {
      workspaceSource = scope.get('workspaces')?.list
      const dispose = workspaceSource?.subscribe?.(publish)
      publish()
      return () => { dispose?.(); workspaceSource = undefined; publish() }
    }, 'kode.global-activity-workspaces'))
  }
  function SessionStatusAvatars({ root, rows, workspaces = [], statuses = new Map(), archivedSessionIds = [] }) {
    const [targets, setTargets] = useState([]), [workspaceTargets, setWorkspaceTargets] = useState([])
    const profileKey = Object.entries(rows).filter(([, row]) => row.agent).map(([id, row]) => `${id}:${row.agent.type}:${row.agent.avatar?.id}:${row.agent.avatar?.url}`).sort().join('|')
    const workspaceKey = workspaces.map(item => `${item.workspaceId}:${item.sessionIds.join(',')}`).join('|')
    // The native sidebar hides status dots on archived sessions and drafts.
    // Children also live outside the workspace tree, in their parent's view.
    const archived = new Set(archivedSessionIds)
    const trackedRows = Object.fromEntries(Object.entries(rows).filter(([id, row]) => !archived.has(id) && !row.blank && row.origin !== 'subagent'))
    const sessionStates = sessionStateMap(trackedRows, statuses)
    const statusKey = JSON.stringify([...sessionStates].sort())
    useEffect(() => {
      const scope = root.current
      if (!scope || typeof MutationObserver === 'undefined') return
      let frame, disposed = false, decorated = [], decoratedWorkspaces = []
      const scan = () => {
        frame = undefined
        if (disposed) return
        const next = []
        for (const row of scope.querySelectorAll('[data-row-key^="session:"]')) {
          const id = row.getAttribute('data-row-key').slice(8), seat = row.firstElementChild
          const state = sessionStates.get(id)
          if (state && rows[id]?.agent && seat) next.push({ id, seat, state })
        }
        for (const seat of decorated) if (!next.some(item => item.seat === seat)) seat.removeAttribute('data-kode-status-avatar')
        decorated = next.map(item => item.seat)
        for (const seat of decorated) seat.setAttribute('data-kode-status-avatar', '')
        setTargets(previous => previous.length === next.length && previous.every((item, index) => item.seat === next[index].seat && item.state === next[index].state && item.id === next[index].id) ? previous : next)
        const nextWorkspaces = []
        for (const row of scope.querySelectorAll('[data-row-key^="workspace:"]')) {
          const id = row.getAttribute('data-row-key').slice(10), workspace = workspaces.find(item => item.workspaceId === id), seat = row.firstElementChild
          const sessionIds = id ? workspace?.sessionIds : [...sessionStates.keys()].filter(sessionId => !workspaces.some(item => item.sessionIds.includes(sessionId)))
          if (!sessionIds || !seat) continue
          const summary = workspaceStatusSummary(sessionIds, sessionStates)
          if (summary.ongoing + summary.done + summary.awaiting) nextWorkspaces.push({ id, seat, ...summary })
        }
        for (const seat of decoratedWorkspaces) if (!nextWorkspaces.some(item => item.seat === seat)) seat.removeAttribute('data-kode-workspace-status')
        decoratedWorkspaces = nextWorkspaces.map(item => item.seat)
        for (const seat of decoratedWorkspaces) seat.setAttribute('data-kode-workspace-status', '')
        setWorkspaceTargets(previous => previous.length === nextWorkspaces.length && previous.every((item, index) => item.seat === nextWorkspaces[index].seat && item.ongoing === nextWorkspaces[index].ongoing && item.done === nextWorkspaces[index].done && item.awaiting === nextWorkspaces[index].awaiting) ? previous : nextWorkspaces)
      }
      const observer = new MutationObserver(records => {
        if (records.every(record => record.target.closest?.('.kode-status-avatar-overlay,.kode-workspace-status'))) return
        if (frame === undefined) frame = requestAnimationFrame(scan)
      })
      observer.observe(scope, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-row-key'] }); scan()
      return () => { disposed = true; observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); for (const seat of decorated) seat.removeAttribute('data-kode-status-avatar'); for (const seat of decoratedWorkspaces) seat.removeAttribute('data-kode-workspace-status') }
    }, [root, profileKey, workspaceKey, statusKey])
    return h(React.Fragment, null,
      ...targets.filter(item => rows[item.id]?.agent).map((item, index) => createPortal(
        h('span', { className: 'kode-status-avatar-overlay', 'aria-hidden': true }, h('span', { className: 'kode-status-avatar-body', 'data-status': item.state }, h(AgentAvatar, { profile: rows[item.id].agent, size: 20, status: item.state === 'ongoing' ? 'running' : item.state === 'awaiting' ? 'awaiting' : 'done' }))), item.seat, `${item.id}:${index}`)),
      ...workspaceTargets.map(item => {
        const label = [item.awaiting ? `${item.awaiting} 个会话等待审核` : '', item.done ? `${item.done} 个会话已完成` : '', item.ongoing ? `${item.ongoing} 个会话进行中` : ''].filter(Boolean).join(' · ')
        return createPortal(h('span', { className: 'kode-workspace-status', 'data-status': preferredAvatarState(item.ongoing ? 'ongoing' : undefined, item.done ? 'done' : undefined, item.awaiting ? 'awaiting' : undefined), role: 'img', 'aria-label': label, title: label }), item.seat, `workspace:${item.id}`)
      }))
  }
  function FederatedWorkspaceBrowser({ native, slots, ...props }) {
    const treeRoot = React.useRef(null)
    const data = useWorkspaceDirectory(), [error, setError] = useState(''), [notice, setNotice] = useState(null), [busy, setBusy] = useState(false), [resumeTarget, setResumeTarget] = useState(null), [resumeQuery, setResumeQuery] = useState('')
    const noticeSequence = React.useRef(0)
    const notify = (text, warning = false) => setNotice({ text, warning, id: ++noticeSequence.current })
    useEffect(() => { if (data.error) notify(data.error, true) }, [data.error])
    const opening = React.useRef(false)
    useEffect(() => {
      requestNativeRename = props.requestSessionRename
      return () => { if (requestNativeRename === props.requestSessionRename) requestNativeRename = undefined }
    }, [props.requestSessionRename])
    const [nativePage, setNativePage] = useState({ rows: [] })
    const resumeRequest = React.useRef(null)
    const loadNativePage = async (target, cursor) => {
      resumeRequest.current?.abort()
      const request = new AbortController()
      resumeRequest.current = request
      setNativePage(previous => ({ ...(cursor ? previous : { rows: [] }), loading: true, error: '' }))
      try {
        const page = await nativeSessionRequest(target.hostId, { profileId: target.profile.id, cursor, signal: request.signal })
        if (!request.signal.aborted) setNativePage(previous => ({
          rows: [...(cursor ? previous.rows : []), ...(page.sessions ?? [])],
          next: page.nextCursor, supported: page.supported,
        }))
      } catch (error) {
        if (!request.signal.aborted) setNativePage(previous => ({ ...previous, loading: false, error: error.message }))
      }
    }
    const closeResume = () => { resumeRequest.current?.abort(); setResumeTarget(null) }
    useEffect(() => () => resumeRequest.current?.abort(), [])
    const source = props.useSessions(state => state), workspaceSource = props.useWorkspaces(state => state)
    const bots = useBots()
    const accountDevices = useSyncExternalStore(devicesStore.subscribe, devicesStore.getSnapshot)
    const activeRemoteDevice = accountDevices.activeDeviceId
      ? accountDevices.devices.find(d => d.device_id === accountDevices.activeDeviceId) ?? { device_id: accountDevices.activeDeviceId, name: accountDevices.activeDeviceId, online: false }
      : null
    const archivedFilter = props.useStore?.(state => state.archivedFilter) ?? 'default'
    const liveSessionKey = source.ids.filter(id => !source.byId[id]?.blank).join('\0')
    useEffect(() => { void refreshWorkspaceDirectory() }, [workspaceSource.archivedSessionIds, liveSessionKey])
    const sessionStatusSource = avatarContext?.get?.('uiSession')?.sessionStatus
    const sessionStatuses = useSyncExternalStore(sessionStatusSource?.subscribe ?? emptyAvatarSubscribe, sessionStatusSource?.getSnapshot ?? emptyAvatarSnapshot)
    const merged = React.useMemo(() => {
      const own = data.hosts.find(host => host.id === data.current)
      const hidden = new Set(own?.hiddenSessionIds ?? [])
      const byId = Object.fromEntries(Object.entries(source.byId).filter(([id]) => !hidden.has(id)))
      const ids = new Set(source.ids.filter(id => !hidden.has(id)))
      const items = [], routes = new Map(), remoteRows = []
      const archivedSessionIds = new Set(own?.archivedSessionIds ?? workspaceSource.archivedSessionIds)
      const pinnedSessionIds = [...workspaceSource.pinnedSessionIds]
      const addDirectoryRow = (row, hostId, id = row.id) => {
        ids.add(id)
        byId[id] = { ...row, id, updatedAt: row.updatedAt ?? 0, displayTitle: row.title, retainedBy: {}, blank: false, projectionValues: {} }
        routes.set(id, { hostId, id: row.id })
      }
      for (const host of data.hosts) {
        if (host.id === data.current) {
          pinnedSessionIds.push(...(host.pinnedSessionIds ?? []))
          const memberships = new Map((host.workspaces ?? []).map(workspace => [workspace.id, workspace.sessionIds]))
          const accounted = new Set([...memberships.values()].flatMap(ids => ids ?? []))
          const pinned = new Set(pinnedSessionIds)
          for (const row of host.sessions ?? []) {
            if (hidden.has(row.id)) continue
            const listed = row.id.startsWith('saved:') || accounted.has(row.id) || archivedSessionIds.has(row.id) || pinned.has(row.id)
            const live = byId[row.id]
            if (live) {
              if (listed) ids.add(row.id)
              // A newly retained live row may arrive before its history metadata.
              byId[row.id] = { ...live, blank: false, displayTitle: live.displayTitle || row.title, ...(row.agent ? { agent: row.agent } : {}) }
            } else if (listed) {
              // The saved alias can be retired before the live session feed
              // publishes its replacement, including during a history reload.
              addDirectoryRow(row, host.id)
            }
          }
          const workspaces = new Map(workspaceSource.items.map(workspace => [workspace.workspaceId, {
            ...workspace, sessionIds: [...new Set([...workspace.sessionIds, ...(memberships.get(workspace.workspaceId) ?? [])])],
          }]))
          for (const workspace of host.workspaces ?? []) {
            if (!workspaces.has(workspace.id)) workspaces.set(workspace.id, { ...workspace, workspaceId: workspace.id })
          }
          items.push(...groupProjectWorkspaces([...workspaces.values()], host.worktreeParents))
          if (host.id !== 'local') remoteRows.push(...workspaceSource.items.map(w => ({ id: w.workspaceId, name: host.name })))
          continue
        }
        const key = id => foreignId(host.id, id)
        const visibleSessions = remoteSidebarSessions(host)
        for (const session of visibleSessions) addDirectoryRow(session, host.id, key(session.id))
        for (const id of host.archivedSessionIds ?? []) archivedSessionIds.add(key(id))
        for (const workspace of host.workspaces ?? []) {
          const id = key(workspace.id)
          items.push({ ...workspace, workspaceId: id, sessionIds: workspace.sessionIds.map(key) })
          routes.set(id, { hostId: host.id, id: workspace.id })
          if (host.id !== 'local') remoteRows.push({ id, name: host.name })
        }
        const accounted = new Set((host.workspaces ?? []).flatMap(workspace => workspace.sessionIds))
        const ungrouped = visibleSessions.filter(session => !accounted.has(session.id))
        const archived = new Set(host.archivedSessionIds)
        const ungroupedVisible = ungrouped.some(session => archivedFilter !== 'default' || !archived.has(session.id))
        if (!host.workspaces?.length || ungroupedVisible) {
          const id = `kode-host-status:${encodeURIComponent(host.id)}`
          items.push({ workspaceId: id, title: host.name, path: '', sessionIds: ungrouped.map(session => key(session.id)), createdAt: 0, updatedAt: 0 })
          routes.set(id, { hostId: host.id, placeholder: true })
          remoteRows.push({ id, name: host.status === 'online' ? (ungrouped.length ? '未分组' : '添加项目') : host.status === 'connecting' ? '正在连接…' : '连接失败', placeholder: host.status ?? 'offline' })
        }
        pinnedSessionIds.push(...(host.pinnedSessionIds ?? []).map(key))
      }
      if (!data.hosts.length) items.push(...workspaceSource.items)
      // Sidebar presence follows visible conversations; the complete project
      // catalog remains available in the workspace picker and creation flow.
      // Bot conversations live in the 伙伴 group, not under projects.
      const botSessions = new Set((bots.data?.bots ?? []).flatMap(bot => [bot.main_session_id, ...(bot.sessions ?? []).map(row => row.id)]).filter(Boolean))
      const botFolders = new Set((bots.data?.bots ?? []).flatMap(bot => [bot.home, !bot.default_cwd && bot.workspace]).filter(Boolean))
      const populated = items.filter(workspace => !botFolders.has(workspace.path))
        .map(workspace => botSessions.size ? { ...workspace, sessionIds: workspace.sessionIds.filter(id => !botSessions.has(id)) } : workspace)
        .filter(workspace => workspace.sessionIds.some(id => {
          const row = byId[id]
          return row && !row.blank && row.origin !== 'subagent' && (archivedFilter !== 'default' || !archivedSessionIds.has(id))
        }))
      return { sessions: { ...source, ids: [...ids].filter(id => !botSessions.has(id)), byId }, workspaces: { ...workspaceSource, items: populated, archivedSessionIds: [...archivedSessionIds], pinnedSessionIds }, routes, remoteRows }
    }, [source, workspaceSource, data, archivedFilter, bots.data])
    useEffect(() => {
      if (!window.addEventListener) return
      const show = event => { const id = event.detail?.sessionId, profile = merged.sessions.byId[id]?.agent; if (!profile) return; const route = merged.routes.get(id) ?? { id, hostId: data.current }; openAvatarDialog({ profile, sessionId: route.id, host: route.hostId }) }
      const resume = event => {
        const target = event.detail
        if (!target?.profile && !target?.global) return
        setResumeQuery(''); setError('')
        void refreshWorkspaceDirectory()
        if (target.profile) { setResumeTarget(target); void loadNativePage(target); return }
        // The sidebar's resume entry: choose among the CLI Agents installed here.
        void (async () => {
          const hostId = target.hostId ?? data.current, store = directory(undefined, hostId, true)
          await store.load()
          const info = store.getSnapshot().data
          const choices = (info?.profiles ?? []).filter(profile => profile.type !== 'dsh' && (!info?.supportedTypes || info.supportedTypes.includes(profile.type)))
          if (!choices.length) { setError(info ? '没有可恢复会话的 CLI Agent。' : store.getSnapshot().error || 'Agent 列表暂不可用。'); return }
          const remembered = (() => { try { return localStorage.getItem(RESUME_PROFILE_KEY) } catch { return null } })()
          const profile = choices.find(row => row.id === remembered) ?? choices[0]
          const next = { hostId, profile, choices }
          setResumeTarget(next); void loadNativePage(next)
        })().catch(error => setError(error.message))
      }
      window.addEventListener('kode-session-avatar', show)
      window.addEventListener('kode-resume-session', resume)
      return () => { window.removeEventListener('kode-session-avatar', show); window.removeEventListener('kode-resume-session', resume) }
    }, [merged])
    const navigate = async (id, target) => {
      if (opening.current) return false
      opening.current = true
      setBusy(true); setError('')
      const feedback = setTimeout(() => sessionOpening.set(true), 150)
      try {
        avatarContext?.get?.('layout')?.selectPanel?.(null)
        let imported, historyNotice, historyWarning = false
        if (target.selection) imported = await nativeSessionRequest(id, { input: { selection: target.selection } })
        else if (target.sessionId?.startsWith('saved:')) imported = await projectCall({ action: 'import-saved', sessionId: target.sessionId })
        else if (target.refreshNative) {
          try { imported = await nativeSessionRequest(id, { input: { sessionId: target.sessionId } }) }
          catch (error) {
            if (error.code !== 'KODE_SERVICE_UPDATE_REQUIRED') {
              historyNotice = '暂时无法同步原生历史，已打开本地记录。'
              historyWarning = true
            }
          }
        }
        if (imported) {
          id = imported.hostId ?? id
          const shared = imported.sharedSession
          if (shared) {
            if (kodeEmbedded() && id === 'local' && shared.runtime === 'gui') {
              showShared(null)
              window.kodeHost.request('open-session', { session: shared.session_uuid, tab: shared.id })
            } else {
              if ((transport?.current ?? 'local') !== id) await switchHost(id)
              showShared({ session: shared, host: id })
            }
            return true
          }
          showShared(null)
          target = { ...target, sessionId: imported.sessionId }
          if (imported.historyPending) {
            historyNotice = '暂时无法同步全部原生历史，已打开现有会话。'
            historyWarning = true
          } else if (!imported.reloaded && imported.historyWindow?.truncated) {
            historyNotice = `已加载最近 ${imported.historyWindow.count} 条消息`
          }
        }
        await switchHost(id, target)
        if (historyNotice) notify(historyNotice, historyWarning)
        void refreshWorkspaceDirectory()
        return true
      } catch (error) {
        if (target.resume) setError(error.message)
        else notify(error.message, true)
      }
      finally { clearTimeout(feedback); sessionOpening.set(false); opening.current = false; setBusy(false) }
    }
    const open = id => {
      showShared(null)
      const route = merged.routes.get(id), hostId = route?.hostId ?? data.current, sessionId = route?.id ?? id
      const refreshNative = data.hosts.find(host => host.id === hostId)?.sessions.some(row => row.id === sessionId && row.nativeThreadId && !row.running)
      if (route || refreshNative) void navigate(hostId, { sessionId, refreshNative })
      else props.open(id)
    }
    const resumeRows = resumeCandidates(data.hosts, resumeTarget, resumeQuery, nativePage.rows)
    const mutate = async (id, operation, args) => {
      const route = merged.routes.get(id)
      await projectCall({ action: 'host-operation', id: route.hostId, operation, args })
      await refreshWorkspaceDirectory()
    }
    const requestRename = (id, currentTitle) => {
      const route = merged.routes.get(id)
      routedRename = route && { id, hostId: route.hostId, sessionId: route.id }
      props.requestSessionRename(id, currentTitle)
    }
    const sessionOperation = (id, operation) => {
      const route = merged.routes.get(id)
      void mutate(id, operation, { sessionId: route.id }).catch(error => notify(error.message, true))
    }
    const renderSlot = (name, owner, options) => {
      const route = merged.routes.get(owner?.sessionId)
      if (!route || !name.startsWith('sidebar.')) return props.renderSlot(name, owner, options)
      if (name === 'sidebar.session.row.leading') return h(SidebarAgentAvatar, { ...owner, useSessionStatus: props.useSessionStatus })
      if (name === 'sidebar.session.row.hover') return props.renderSlot(name, owner, options)
      if (['sidebar.workspaces.session.menu.item', 'sidebar.workspaces.session.row.action'].includes(name)) {
        // Reuse the shipped action components with host-qualified state and commands.
        // Their icons, hover buttons and menu-close behavior stay identical locally and remotely.
        const allowed = name.endsWith('menu.item') ? ['pin', 'rename', 'kode-avatar', 'archive'] : ['pin', 'archive']
        return h(React.Fragment, null, ...slots.entries(name).filter(entry => allowed.includes(entry.options.id)).map(entry => h(entry.component, {
          ...owner, key: entry.options.id, t: props.t, useShortcuts: props.useShortcuts,
          useSessionAccess: props.useSessionAccess,
          useMenuOpenState: () => options.hookContext,
          usePinned: select => select(new Set(merged.workspaces.pinnedSessionIds)),
          useArchived: select => select(new Set(merged.workspaces.archivedSessionIds)),
          requestSessionRename: requestRename,
          ...Object.fromEntries([['pinSession', 'pin-session'], ['unpinSession', 'unpin-session'], ['archiveSession', 'archive-session'], ['unarchiveSession', 'unarchive-session']].map(([key, operation]) => [key, id => sessionOperation(id, operation)])),
        })))
      }
      return null
    }
    const remoteCss = merged.remoteRows.map(row => {
      const selector = `[data-row-key=${cssString('workspace:'+row.id)}]`
      return `${selector}>span:first-child{position:relative}${selector}>span:first-child>svg{visibility:hidden}${selector}>span:first-child::before{content:"";position:absolute;width:16px;height:16px;background:currentColor;mask:${remoteComputerMask} center/contain no-repeat;-webkit-mask:${remoteComputerMask} center/contain no-repeat}${selector}>span:nth-child(3){flex-direction:row;align-items:center;gap:6px}${selector}>span:nth-child(3)::after{content:${cssString(row.name)};font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:95px;flex-shrink:0}${row.placeholder ? `${selector}>span:last-child>button:first-child{display:none}${row.placeholder === 'connecting' ? `${selector}>span:last-child{visibility:hidden}` : ''}` : ''}`
    }).join('\n')
    const savedCss = [...merged.routes].filter(([id, route]) => route.id?.startsWith('saved:') && !(merged.sessions.byId[id]?.updatedAt > 0)).map(([id]) => {
      const selector = `[data-row-key=${cssString('session:'+id)}]>span:nth-child(3)`
      return `${selector}{font-size:0;visibility:hidden}${selector}::after{content:"已保存";font-size:12px;visibility:visible}`
    }).join('\n')
    return h('div', { className: 'kode-unified-workspaces', 'aria-busy': busy, ref: treeRoot },
      !activeRemoteDevice && h(SessionStatusAvatars, { root: treeRoot, rows: merged.sessions.byId, workspaces: merged.workspaces.items, statuses: sessionStatuses,
        archivedSessionIds: merged.workspaces.archivedSessionIds }),
      !activeRemoteDevice && h('style', null, remoteCss + savedCss),
      notice && h(Toast, { key: notice.id, text: notice.text, icon: notice.warning ? h(IconWarningOutlineRegular) : undefined,
        onDone: () => setNotice(current => current?.id === notice.id ? null : current) }),
      activeRemoteDevice
        ? h(RemoteDeviceSidebar, { device: activeRemoteDevice, wide: props.wide !== false })
        : h(native, { ...props, useSessions: selector => selector(merged.sessions), useWorkspaces: selector => selector(merged.workspaces), open, renderSlot, requestSessionRename: requestRename,
        startSession: (id, options) => {
          const route = merged.routes.get(id)
          if (route?.placeholder) return void navigate(route.hostId, { create: true })
          const workspacePath = merged.workspaces.items.find(workspace => workspace.workspaceId === id)?.path
            ?? data.hosts.find(host => host.id === data.current)?.workspaces?.find(workspace => workspace.id === id)?.path
          const nativeWorkspaces = avatarContext?.get?.('workspaces')?.list?.getSnapshot() ?? workspaceSource
          if (route || (workspacePath && !nativeWorkspaces.items.some(workspace => workspace.workspaceId === id))) {
            return void navigate(route?.hostId ?? data.current, { workspaceId: route?.id ?? id, workspacePath, startSession: true, options })
          }
          props.startSession(id, options)
        },
        renameWorkspace: (id, title) => merged.routes.has(id) ? mutate(id, 'rename-workspace', { workspaceId: merged.routes.get(id).id, title }) : props.renameWorkspace(id, title),
        deleteWorkspace: id => merged.routes.has(id) ? mutate(id, 'delete-workspace', { workspaceId: merged.routes.get(id).id }) : props.deleteWorkspace(id),
        insertWorkspaceBefore: (id, before) => {
          const route = merged.routes.get(id), anchor = merged.routes.get(before)
          if ((route?.hostId ?? data.current) !== (anchor?.hostId ?? data.current) && before) return Promise.reject(new Error('项目排序只能在同一主机内调整。'))
          return route ? mutate(id, 'reorder-workspace', { workspaceId: route.id, beforeWorkspaceId: anchor?.id }) : props.insertWorkspaceBefore(id, before)
        },
        unarchiveSession: id => merged.routes.has(id) ? mutate(id, 'unarchive-session', { sessionId: merged.routes.get(id).id }) : props.unarchiveSession(id),
      }),
      h(Modal, { open: Boolean(resumeTarget), title: '恢复原生会话', closeLabel: '关闭', onClose: closeResume },
        resumeTarget?.choices?.length > 1 && h('label', { className: 'kode-field' }, 'Agent', h('select', { value: resumeTarget.profile.id, disabled: busy, onChange: event => {
          const profile = resumeTarget.choices.find(row => row.id === event.target.value)
          if (!profile) return
          try { localStorage.setItem(RESUME_PROFILE_KEY, profile.id) } catch { /* best effort */ }
          const next = { ...resumeTarget, profile }
          setResumeTarget(next); void loadNativePage(next)
        } }, ...resumeTarget.choices.map(row => h('option', { key: row.id, value: row.id }, row.name)))),
        h('label', { className: 'kode-field' }, '搜索会话', h('input', { autoFocus: true, value: resumeQuery, placeholder: '名称、工作区或原生会话 ID', onChange: event => setResumeQuery(event.target.value) })),
        h('div', { className: 'kode-resume-list', 'aria-busy': Boolean(nativePage.loading) }, ...resumeRows.map(row => h(Button, { key: row.nativeThreadId, variant: 'outline', disabled: busy, onClick: async () => {
          if (await navigate(resumeTarget.hostId, { sessionId: row.id, selection: row.selection, refreshNative: !row.selection, resume: true })) closeResume()
        } }, h('span', null, row.title), h('small', null, row.cwd)))),
        nativePage.loading && h('p', { className: 'kode-config-note', role: 'status' }, '正在读取 Agent 会话…'),
        nativePage.supported === false && h('p', { className: 'kode-config-note' }, '此 Agent 未提供会话列表，当前显示 Kode 已记录的会话。'),
        !nativePage.loading && !nativePage.error && !resumeRows.length && h('p', { className: 'kode-config-note' }, nativePage.next ? '已加载的会话中没有匹配项。' : '没有匹配的历史会话。'),
        nativePage.error && h(Failure, { text: nativePage.error }),
        (nativePage.next || nativePage.error) && h(Button, { variant: 'outline', disabled: busy || nativePage.loading, onClick: () => void loadNativePage(resumeTarget, nativePage.next) }, nativePage.error ? '重试读取' : '加载更多会话'),
        h(Failure, { text: error })),
    )
  }
  function WorkspaceArrival({ uiWorkspace, workspaces, sessions, layout }) {
    const workspacePhase = useSyncExternalStore(React.useCallback(fn => workspaces.list.subscribe(fn), [workspaces]), () => workspaces.list.getSnapshot().phase)
    const sessionPhase = useSyncExternalStore(React.useCallback(fn => sessions.list.subscribe(fn), [sessions]), () => sessions.list.getSnapshot().phase)
    const [error, setError] = useState('')
    // Embedding hosts (Kode desktop) switch sessions by changing the hash.
    const [arrivals, setArrivals] = useState(0)
    useEffect(() => {
      const arrive = () => setArrivals(count => count + 1)
      window.addEventListener('hashchange', arrive)
      return () => window.removeEventListener('hashchange', arrive)
    }, [])
    useEffect(() => {
      if (workspacePhase !== 'ready' || sessionPhase !== 'ready') return
      const match = /^#kode-open-(session|workspace)=(.+)$/.exec(window.location.hash)
      if (!match) return
      let target
      try { target = decodeURIComponent(match[2]) } catch { setError('无法打开此会话链接。'); return }
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
      // Cancel rc.2's asynchronous saved-draft restoration before opening a link.
      layout.beginNavigation()
      // A Kode-owned conversation left on screen would hide the arriving session.
      showShared(null)
      setError('')
      Promise.resolve(match[1] === 'session' ? uiWorkspace.openSession(target) : uiWorkspace.openWorkspace(target)).catch(error => setError(error.message))
    }, [uiWorkspace, workspacePhase, sessionPhase, arrivals])
    return error ? h('div', { className: 'kode-navigation-error', role: 'alert' }, error) : null
  }
  function ProjectFlow({ open, busy: ownerBusy, slots, workspaces, onPicked, onCancel, initialName = '' }) {
    const { data, error: loadError } = useProjectHosts()
    const [selected, setSelected] = useState(null), [name, setName] = useState(initialName), [path, setPath] = useState(''), [picking, setPicking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const hostId = selected ?? data.current
    const manageHosts = () => { try { openSettings(slots, 'kode-ssh'); onCancel() } catch (error) { setError(error.message) } }
    useEffect(() => { if (open) { setSelected(null); setName(initialName); setPath(''); setError('') } }, [open, initialName])
    const add = async () => {
      setError('')
      if (hostId === data.current) { setPicking(true); return }
      setBusy(true)
      try { onCancel(); await switchHost(hostId, { create: true, name }) } catch (error) { setError(error.message) } finally { setBusy(false) }
    }
    const create = async () => {
      setBusy(true); setError('')
      try { const workspace = await workspaces.create({ path }); if (name.trim() && workspace.title !== name.trim()) await workspaces.rename(workspace.workspaceId, name.trim()); await onPicked(path) } catch (error) { setError(error.message) } finally { setBusy(false) }
    }
    return h(React.Fragment, null,
      h(Modal, { open: open && !picking, title: '创建项目', closeLabel: '关闭', onClose: onCancel, className: 'kode-project-dialog', footer: h(React.Fragment, null, h(Button, { variant: 'outline', onClick: onCancel, disabled: busy }, '取消'), h(Button, { variant: 'primary', onClick: create, disabled: busy || ownerBusy || !path || hostId !== data.current }, busy ? '处理中…' : '创建项目')) },
        h('label', { className: 'kode-field' }, '项目名称', h('input', { value: name, placeholder: '项目名称（可选）', onChange: event => setName(event.target.value) })),
        h('div', { className: 'kode-project-source' }, h(SelectField, { label: '源文件夹', value: hostId, options: [...data.hosts.map(row => ({ value: row.id, label: row.id === 'local' ? '在此电脑上添加文件夹' : `在 ${row.name} 上添加文件夹` })), { value: 'manage', label: '管理 SSH 主机…' }], onChange: value => { if (value === 'manage') { manageHosts() } else { setSelected(value); setPath(''); setError('') } }, disabled: busy }),
          path && h('p', { className: 'kode-project-path' }, path), h(Button, { variant: 'outline', onClick: add, disabled: busy || ownerBusy || Boolean(loadError) }, h(IconFolderCloseRegular, { size: 16 }), path ? '更换文件夹' : hostId !== data.current ? '连接并选择文件夹' : '添加文件夹'),
          hostId !== 'local' && h(Button, { variant: 'ghost', onClick: manageHosts, disabled: busy }, '管理 SSH 主机')),
        h(Failure, { text: error || loadError })),
      h(DirectoryFlow, { slots, open: open && picking, busy, onCancel: () => setPicking(false), onError: message => { setPicking(false); setError(message) }, onPicked: path => { setPath(path); setPicking(false); if (!name.trim()) setName(path.split('/').filter(Boolean).at(-1) ?? '') } }),
    )
  }
  // Shared 16px line icon: monitor with a small connection mark.
  const remoteComputerSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4M8 21h8M12 17v4M2 13h20M17 2h5v5M22 2l-7 7"/></svg>'
  const remoteComputerMask = `url("data:image/svg+xml,${encodeURIComponent(remoteComputerSvg)}")`
  function RemoteComputerIcon({ size = 16 }) {
    return h('span', { className: 'kode-remote-computer', 'aria-hidden': true, style: { width: size, height: size, maskImage: remoteComputerMask, WebkitMaskImage: remoteComputerMask } })
  }
  function ProjectHostAppearance() {
    const { data } = useProjectHosts()
    // rc.2 has no workspace-icon slot. Scope to the native project row's
    // leading folder seat; leave its hover chevron and session icons intact.
    return data.current !== 'local' ? h('style', null, `
[data-kode-remote-workspace]>svg:first-child{background:currentColor;mask:${remoteComputerMask} center/contain no-repeat;-webkit-mask:${remoteComputerMask} center/contain no-repeat}
[data-kode-remote-workspace]>svg:first-child>*{visibility:hidden}
`) : null
  }
  function HostControl({ slots, workspaces, uiWorkspace }) {
    const { data, error: loadError } = useProjectHosts(), [open, setOpen] = useState(false), [creating, setCreating] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const label = data.hosts.find(row => row.id === data.current)?.name ?? '选择主机'
    return h(React.Fragment, null, h(Menu, { open, onClose: () => setOpen(false), portal: true, selectedId: data.current, items: data.hosts.map(row => ({ id: row.id, label: row.name })), footer: [{ id: 'new', label: '创建项目…' }, { id: 'manage', label: '管理 SSH 主机…' }],
      anchor: h('button', { type: 'button', className: 'kode-trigger kode-host-location', 'aria-label': `执行位置：${label}`, 'aria-haspopup': 'menu', 'aria-expanded': open, disabled: busy, onClick: () => setOpen(!open) }, busy ? h(StateDot, { state: 'ongoing', size: 16, className: 'kode-status-dot' }) : h(data.current === 'local' ? IconGlobeOutlineRegular : RemoteComputerIcon, { size: 14 }), h('span', { className: 'kode-control-label' }, busy ? '正在连接…' : label), h(IconChevronDownOutlineRegular, { size: 12 })),
      onSelect: async id => { setOpen(false); if (id === 'manage') { try { openSettings(slots, 'kode-ssh') } catch (error) { setError(error.message) } return } if (id === 'new') { setCreating(true); return } if (id === data.current) return; setBusy(true); setError(''); try { await switchHost(id) } catch (error) { setError(error.message) } finally { setBusy(false) } },
    }), h(Failure, { text: error || loadError }), h(ProjectFlow, { open: creating, slots, workspaces, onCancel: () => setCreating(false), onPicked: async path => { const workspace = await workspaces.create({ path }); await uiWorkspace?.openWorkspace(workspace.workspaceId); setCreating(false) } }))
  }
  function ProjectArrival({ slots, workspaces, uiWorkspace }) {
    const [open, setOpen] = useState(() => window.location?.hash?.startsWith('#kode-create-project') ?? false)
    const [initialName, setInitialName] = useState(() => decodeURIComponent(window.location?.hash?.split('=').slice(1).join('=') ?? ''))
    useEffect(() => { if (open) window.history.replaceState(null, '', window.location.pathname + window.location.search) }, [])
    useEffect(() => { const show = event => { setInitialName(event.detail?.name ?? ''); setOpen(true) }; window.addEventListener('kode-create-project', show); return () => window.removeEventListener('kode-create-project', show) }, [])
    return h(ProjectFlow, { open, initialName, slots, workspaces, onCancel: () => setOpen(false), onPicked: async path => { const workspace = await workspaces.create({ path }); await uiWorkspace.openWorkspace(workspace.workspaceId); setOpen(false) } })
  }
  function BranchPicker({ info, value, disabled, onChange }) {
    const [open, setOpen] = useState(false), [query, setQuery] = useState('')
    const selected = info?.branches?.find(row => row.ref === value)
    const matches = (info?.branches ?? []).filter(row => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    const choose = ref => { onChange(ref); setOpen(false) }
    const row = (ref, name, detail) => h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': value === ref, key: ref, className: 'kode-branch-option', onClick: () => choose(ref) },
      h('span', null, h('span', { className: 'kode-branch-name' }, name), h('small', null, detail)), value === ref && h(IconCheckOutlineRegular, { size: 16 }))
    return h('div', { className: 'kode-field' }, h('span', null, '起始分支'), h(Menu, {
      open: open && !disabled, onClose: () => setOpen(false), portal: true, minWidthFromAnchor: true, listClassName: 'kode-branch-popup',
      anchor: h('button', { type: 'button', className: 'kode-branch-trigger', disabled, 'aria-label': '选择起始分支', 'aria-haspopup': 'menu', 'aria-expanded': open && !disabled, onClick: () => { setQuery(''); setOpen(!open) } },
        h('span', null, selected?.name ?? (info ? `当前提交 · ${info.branch || '分离的 HEAD'}` : '正在读取分支…')), h(IconChevronDownOutlineRegular, { size: 14 })),
    }, h('div', { className: 'kode-branch-search' }, h(IconSearchOutlineRegular, { size: 16, 'aria-hidden': true }), h('input', {
      type: 'search', autoFocus: true, value: query, placeholder: '搜索本地或远端分支…', 'aria-label': '搜索起始分支', spellCheck: false,
      onChange: event => setQuery(event.target.value), onKeyDown: event => { if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); event.currentTarget.closest('[role=menu]')?.querySelector('.kode-branch-option')?.focus() } },
    })), h('div', { className: 'kode-branch-results' },
      !query.trim() && row('HEAD', '当前提交', `${info?.branch || '分离的 HEAD'} · ${info?.commit?.slice(0,8) ?? ''}`),
      ...matches.map(branch => row(branch.ref, branch.name, `${branch.ref.startsWith('refs/remotes/') ? '远端' : '本地'} · ${branch.commit.slice(0,8)}`)),
      !matches.length && query.trim() && h('p', { className: 'kode-branch-empty', role: 'status' }, '没有匹配的分支'))))
  }
  function WorktreeForm({ open, workspace, workspaces, onClose, onCreated }) {
    const [info, setInfo] = useState(null), [baseRef, setBaseRef] = useState('HEAD'), [branch, setBranch] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [requestId, setRequestId] = useState('')
    const host = transport?.current ?? 'local'
    const call = async body => {
      const url = body ? '/api/kode/worktrees' : `/api/kode/worktrees?workspaceId=${encodeURIComponent(workspace.workspaceId)}`
      const init = { credentials: 'same-origin', cache: 'no-store', ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }
      const response = await (transport ? transport.fetch(url, init, host) : fetch(url, init))
      if (response.status === 404) throw new Error('当前主机尚未提供 worktree 创建能力，请先更新 Kode 服务。')
      const result = await parseHostJson(response); if (!response.ok) throw new Error(result.error ?? '无法创建 worktree。')
      if ((transport?.current ?? 'local') !== host) throw new Error('执行主机已切换，请在目标主机重新选择项目。')
      return result
    }
    useEffect(() => {
      if (!open || !workspace) return
      let alive = true; setInfo(null); setBaseRef('HEAD'); setBranch(''); setError(''); setLoading(true); setRequestId(crypto.randomUUID())
      void call().then(value => { if (alive) setInfo(value) }, error => { if (alive) setError(error.message) }).finally(() => { if (alive) setLoading(false) })
      return () => { alive = false }
    }, [open, workspace?.workspaceId, host])
    const create = async () => {
      setBusy(true); setError('')
      try {
        const result = await call({ workspaceId: workspace.workspaceId, requestId, branch, baseRef })
        const created = await workspaces.create({ path: result.path })
        await workspaces.rename(created.workspaceId, `${workspace.title} · ${result.branch}`)
        if ((transport?.current ?? 'local') !== host) throw new Error('worktree 已创建；主机已切换，请返回原主机继续。')
        onCreated(created.workspaceId)
      } catch (error) { setError(error.message) } finally { setBusy(false) }
    }
    const base = info?.branches?.find(row => row.ref === baseRef)
    return h(Modal, { open, title: '在 worktree 中新建会话', closeLabel: '关闭', onClose: () => { if (!busy) onClose() }, className: 'kode-project-dialog', footer: h(React.Fragment, null,
      h(Button, { variant: 'outline', onClick: onClose, disabled: busy }, '取消'), h(Button, { variant: 'primary', onClick: create, disabled: busy || loading || !info }, busy ? h(React.Fragment, null, h(StateDot, { state: 'ongoing', size: 16, className: 'kode-status-dot' }), '创建中…') : '创建并进入')) },
      h('p', { className: 'kode-config-note' }, workspace?.title),
      loading && h('p', { role: 'status', className: 'kode-config-note' }, '正在检查 Git 仓库…'),
      info && h('p', { className: 'kode-worktree-base' }, h('span', null, '起点'), h('strong', null, base?.name ?? (info.branch || '分离的 HEAD')), h('code', null, (base?.commit ?? info.commit).slice(0,8))),
      h(BranchPicker, { info, value: baseRef, disabled: busy || loading || !info, onChange: value => { setBaseRef(value); setRequestId(crypto.randomUUID()) } }),
      h('label', { className: 'kode-field' }, '新分支名称（可选）', h('input', { value: branch, disabled: busy || loading, placeholder: '留空自动生成', spellCheck: false, onChange: event => { setBranch(event.target.value); setRequestId(crypto.randomUUID()) } })),
      h('p', { className: 'kode-config-note' }, '从所选分支创建独立工作目录，新会话仍归入当前项目。原目录的未提交改动会保留在原处。'), h(Failure, { text: error }))
  }
  function WorkspacePicker({ open, anchorRef, selectedId, onPick, onClose, workspaces, slots, uiWorkspace, sessionId }) {
    const { data: projectHost } = useProjectHosts()
    useEffect(() => {
      const anchor = anchorRef?.current
      if (!anchor) return
      const row = anchor.parentElement
      row?.classList.add('kode-hero-controls')
      anchor.toggleAttribute('data-kode-remote-workspace', projectHost.current !== 'local')
      return () => { anchor.removeAttribute('data-kode-remote-workspace'); row?.classList.remove('kode-hero-controls') }
    }, [anchorRef, projectHost.current])
    const snapshot = useSyncExternalStore(React.useCallback(fn => workspaces.list.subscribe(fn), [workspaces]), React.useCallback(() => workspaces.list.getSnapshot(), [workspaces]))
    const [query, setQuery] = useState(''), [picking, setPicking] = useState(false), [worktreeOpen, setWorktreeOpen] = useState(false)
    useEffect(() => { if (open) setQuery('') }, [open])
    const projectDirectory = useWorkspaceDirectory(), parents = projectDirectory.hosts.find(host => host.id === projectDirectory.current)?.worktreeParents ?? {}
    const projects = groupProjectWorkspaces(snapshot.items, parents), selectedProject = projects.find(row => row.sessionIds.includes(sessionId)) ?? projects.find(row => row.workspaceId === (parents[selectedId] ?? selectedId))
    const items = projects.filter(w => `${w.title} ${w.path}`.toLowerCase().includes(query.trim().toLowerCase()))
    const pick = id => { const origin = sessionId && directory(sessionId).getSnapshot().data; if (origin?.currentProfile && origin.canChangeAgent) stagedAgent = { host: transport?.current ?? 'local', sourceId: sessionId, profileId: origin.currentProfile.id, model: origin.selection?.model, provider: origin.selection?.provider, at: Date.now() }; onClose(); onPick(id) }
    return h(React.Fragment, null,
      h(HostControl, { slots, workspaces, uiWorkspace }),
      h('button', { type: 'button', className: 'kode-trigger kode-worktree-trigger', disabled: !selectedId, 'aria-label': '在新 worktree 中创建会话', onClick: () => { onClose(); setWorktreeOpen(true) } }, h(IconPlusOutlineRegular, { size: 14 }), '新建 worktree'),
      h(WorktreeForm, { open: worktreeOpen, workspace: selectedProject ?? snapshot.items.find(row => row.workspaceId === selectedId), workspaces, onClose: () => setWorktreeOpen(false), onCreated: id => { const origin = sessionId && directory(sessionId).getSnapshot().data; if (origin?.currentProfile && origin.canChangeAgent) stagedAgent = { host: transport?.current ?? 'local', sourceId: sessionId, profileId: origin.currentProfile.id, model: origin.selection?.model, provider: origin.selection?.provider, at: Date.now() }; setWorktreeOpen(false); pick(id) } }),
      h(Menu, { open, anchor: null, onClose, portal: true, getAnchorRect: () => anchorRef?.current?.getBoundingClientRect() ?? null, listClassName: 'kode-workspace-menu', footer: [{ id: 'create', label: '创建项目…', icon: h(IconPlusOutlineRegular, { size: 16 }) }], onSelect: () => { onClose(); setPicking(true) } },
        h('div', { className: 'kode-workspace-search' }, h(IconSearchOutlineRegular, { size: 16 }), h('input', { autoFocus: true, 'aria-label': '搜索项目', placeholder: '搜索项目', value: query, onChange: e => setQuery(e.target.value) })),
        ...items.map(w => h(MenuItemButton, { key: w.workspaceId, current: w.workspaceId === (selectedProject?.workspaceId ?? selectedId), icon: h(projectHost.current === 'local' ? IconFolderCloseRegular : RemoteComputerIcon, { size: 16 }), onSelect: () => pick(w.workspaceId) }, h('span', { className: 'kode-workspace-option' }, h('span', null, w.title === 'default-workspace' ? '默认工作区' : w.title || '默认工作区'), h('small', { title: w.path }, w.path)))),
        !items.length && h('p', { className: 'kode-menu-note' }, snapshot.phase === 'pending' ? '正在加载项目…' : '没有匹配的项目')),
      h(ProjectFlow, { slots, workspaces, open: picking, onCancel: () => setPicking(false), onPicked: async path => { const workspace = await workspaces.create({ path }); setPicking(false); pick(workspace.workspaceId) } }),
    )
  }
