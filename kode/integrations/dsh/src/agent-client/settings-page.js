  function InterfaceSettingsBody() {
    const service = avatarContext?.get('kodeInterface')
    const empty = React.useMemo(() => ({ tokenIsland: true, tokenPeriod: 'today' }), [])
    const subscribe = React.useCallback(fn => service?.subscribe(fn) ?? (() => {}), [service])
    const snapshot = useSyncExternalStore(subscribe, () => service?.getSnapshot() ?? empty)
    const [error, setError] = useState('')
    return h(React.Fragment, null,
      h('h3', { className: 'kode-settings-group-title' }, '状态与用量'),
      h('div', { className: 'kode-settings-card' },
        h('label', { className: 'kode-integration-row' },
          h('span', null, h('strong', null, '显示 Token 刘海'), h('span', { className: 'kode-config-note' }, '显示 Token 用量与全局会话状态；关闭后立即隐藏，设置保存在当前设备。')),
          h('input', { type: 'checkbox', role: 'switch', checked: snapshot.tokenIsland, disabled: !service, onChange: event => {
            setError(''); try { service.update({ tokenIsland: event.target.checked }) } catch { setError('无法保存显示设置，请检查当前设备的存储权限。') }
          } })),
        h('div', { className: 'kode-integration-row kode-settings-select-row' },
          h('span', null, h('strong', null, '刘海用量范围'), h('span', { className: 'kode-config-note' }, '选择“跟随统计范围”后，刘海显示详情中所选时间范围的用量，包括自定义起止时间。')),
          h('div', { className: 'kode-settings-row-control' }, h(SelectField, { label: '刘海用量范围', showLabel: false, value: snapshot.tokenPeriod ?? 'today', disabled: !service, options: [{ value: 'today', label: '今日 Token' }, { value: 'month', label: '本月 Token' }, { value: 'all', label: '全部 Token' }, { value: 'follow', label: '跟随统计范围' }], onChange: tokenPeriod => {
            setError(''); try { service.update({ tokenPeriod }) } catch { setError('无法保存显示设置，请检查当前设备的存储权限。') }
          } })))),
      h(Failure, { text: error }))
  }
  // Mirrors mature desktop apps: macOS owns authorization and banner style, so the row states who decides, offers the system
  // entry instead of claiming a permission Electron cannot read.
  function notificationState(snapshot) {
    if (snapshot.permission === 'loading') return { tone: 'checking', title: '正在连接通知服务…' }
    if (snapshot.permission === 'unsupported') return { tone: 'off', title: '当前环境不支持系统通知', detail: '请使用 Desktop 或支持通知的浏览器。' }
    if (snapshot.systemSettings) return { tone: snapshot.deliveryError ? 'error' : 'system', title: snapshot.deliveryError ? '系统未能显示通知' : '由 macOS 系统设置管理',
      detail: '在“系统设置 → 通知”中找到 DeepSeek Harness（开发模式为“DeepSeek Harness 开发版”），打开“允许通知”，并把提醒样式设为“横幅”或“提醒”。镜像或共享屏幕时系统可能隐藏横幅。', system: true }
    if (snapshot.permission === 'default') return { tone: 'off', title: '尚未允许通知', detail: '允许后，后台会话完成或等待操作时会提醒你。', enable: true }
    if (snapshot.permission === 'denied') return { tone: 'error', title: '通知已被阻止', detail: '请在浏览器网站设置或 macOS 系统设置 → 通知中允许 DeepSeek Harness，然后返回此页。' }
    return { tone: snapshot.deliveryError ? 'error' : 'on', title: snapshot.deliveryError ? '系统未能显示通知' : '已允许通知', detail: snapshot.deliveryError ? '请检查浏览器与系统的通知设置。' : undefined }
  }
  function NotificationSettingsBody() {
    const service = avatarContext?.get('kodeNotifications')
    const subscribe = React.useCallback(fn => service?.subscribe(fn) ?? (() => {}), [service])
    const empty = React.useMemo(() => ({ permission: 'loading', completed: true, waiting: true }), [])
    const snapshot = useSyncExternalStore(subscribe, () => service?.getSnapshot() ?? empty)
    const [busy, setBusy] = useState(false), [error, setError] = useState('')
    const state = notificationState(snapshot)
    const run = async action => { setBusy(true); setError(''); try { await action() } catch (error) { setError(error.message || '无法打开通知设置，请手动前往系统设置。') } finally { setBusy(false) } }
    const icon = { on: IconCheckOutlineRegular, system: IconCheckOutlineRegular, error: IconWarningOutlineRegular, checking: IconLoadingOutlineRegular }[state.tone]
    return h(React.Fragment, null,
      h('h3', { className: 'kode-settings-group-title' }, '会话通知'),
      h('p', { className: 'kode-config-note' }, '会话完成或等待你操作时提醒你；点击通知可返回对应会话。'),
      h('div', { className: 'kode-settings-card' },
        h('div', { className: 'kode-integration-row kode-notification-permission', 'data-tone': state.tone },
          h('span', { className: 'kode-notification-state' },
            h('strong', { role: 'status' }, icon && h(icon, { size: 14, className: state.tone === 'checking' ? 'kode-spin' : undefined, 'aria-hidden': true }), state.title),
            state.detail && h('span', { className: 'kode-config-note' }, state.detail)),
          (state.enable || state.system) && h('span', { className: 'kode-notification-actions' },
            h(Button, { size: 'sm', variant: state.enable ? 'primary' : 'outline', disabled: busy, onClick: () => void run(() => state.enable ? service.enable() : service.openSettings()) },
              busy ? '正在打开…' : state.enable ? '允许通知' : '前往系统设置'))),
        ...[{ key: 'completed', label: '会话完成', detail: '本轮回答完成且队列为空时提醒。主动停止和执行失败不会触发完成通知。' }, { key: 'waiting', label: '等待操作', detail: 'Agent 请求回答、计划确认或操作审批时提醒。' }].map(item => h('label', { className: 'kode-integration-row', key: item.key }, h('span', null, h('strong', null, item.label), h('span', { className: 'kode-config-note' }, item.detail)), h('input', { type: 'checkbox', role: 'switch', checked: snapshot[item.key], disabled: !service, onChange: event => service.update({ [item.key]: event.target.checked }) })))),
      h('p', { className: 'kode-config-note' }, '通知偏好保存在当前设备。已连接过的 SSH 主机会继续在后台提供提醒。'),
      h(Failure, { text: error }))
  }
  // Broad task categories; small preferences belong in a section within a page.
  const settingsSections = [['general', '常规'], ['appearance', '外观'], ['agents', 'Agent'], ['integrations', '插件与集成'], ['mobile', '手机与同步'], ['ssh', '主机与服务']]
  const settingsSectionAliases = { notifications: 'general', personalization: 'appearance' }
  function resolveSettingsSection(section) {
    const id = settingsSectionAliases[section] ?? section
    return settingsSections.some(([key]) => key === id) ? id : 'general'
  }
  function KodeSettings({ sessions, slots, close }) {
    const { data: hosts, error } = useProjectHosts()
    const [agentHost, setAgentHost] = useState(() => (requestedSettingsSection === 'agents' ? requestedServiceHost : undefined) ?? transport?.current ?? 'local')
    const [serviceHost, setServiceHost] = useState(() => requestedServiceHost ?? 'local')
    const [active, setActive] = useState(() => resolveSettingsSection(requestedSettingsSection))
    const [serviceBusy, setServiceBusy] = useState(false)
    const root = React.useRef(null)
    const selectSection = section => {
      section = resolveSettingsSection(section)
      setActive(section)
      requestAnimationFrame(() => root.current?.querySelector(`#kode-settings-${section}`)?.focus({ preventScroll: true }))
    }
    const navigate = () => {
      if (requestedServiceHost && !serviceBusy) {
        setServiceHost(requestedServiceHost)
        if (requestedSettingsSection === 'agents') setAgentHost(requestedServiceHost)
        requestedServiceHost = undefined
      }
      const section = requestedSettingsSection
      requestedSettingsSection = undefined
      if (section) selectSection(section)
    }
    useEffect(() => { navigate(); window.addEventListener('kode-settings-navigate', navigate); return () => window.removeEventListener('kode-settings-navigate', navigate) }, [serviceBusy])
    const options = hosts.hosts.map(row => ({ value: row.id, label: row.name }))
    if (!options.some(row => row.value === agentHost)) options.push({ value: agentHost, label: '正在读取主机…' })
    const bodies = {
      agents: () => h(React.Fragment, null,
        h('div', { className: 'kode-settings-group' },
          h('h3', { className: 'kode-settings-group-title' }, '配置主机'),
          h('div', { className: 'kode-settings-card kode-settings-card-padded kode-settings-scope' },
            h(SelectField, { label: '配置主机', showLabel: false, value: agentHost, options, onChange: setAgentHost }))),
        h(Failure, { text: error }),
        h(AgentSettingsBody, { key: agentHost, sessions, slots, settingsHost: agentHost })),
      integrations: () => h(IntegrationSettingsBody, { host: 'local', hubHost: agentHost, hosts: hosts.hosts, slots, sessions }),
      general: () => h('div', { className: 'kode-settings-general' },
        h('div', { className: 'kode-settings-group' }, h(SessionBehaviorSettings, { host: 'local', slots })),
        h('div', { className: 'kode-settings-group' }, h(NotificationSettingsBody))),
      appearance: () => h(React.Fragment, null,
        h('div', { className: 'kode-settings-group' }, h(InterfaceSettingsBody)),
        h('div', { className: 'kode-settings-group' }, h('h3', { className: 'kode-settings-group-title' }, '头像与背景'),
          h('div', { className: 'kode-settings-card kode-settings-card-padded' }, h(PersonalizationSettings, { sessions, close })))),
      mobile: () => h(MobileSettingsBody, { host: 'local', slots }),
      ssh: () => h(SshSettings, { host: serviceHost, onBusyChange: setServiceBusy }),
    }
    const title = settingsSections.find(([id]) => id === active)?.[1] ?? '常规'
    return h('div', { ref: root, className: 'kode-settings-page kode-agent-settings' },
      h('header', { className: 'kode-settings-brand' },
        h('span', { className: 'kode-settings-brand-avatar', 'aria-hidden': true }, h('img', { src: '/api/kode/avatars/media?type=kode&state=idle', alt: '', width: 32, height: 32 })),
        h('div', { className: 'kode-settings-brand-meta' }, h('h2', null, 'Kode 设置'), h('p', null, '统一管理 Agent、插件、连接与个性化设置'))),
      h('div', { className: 'kode-settings-layout' },
        h('nav', { className: 'kode-settings-nav', 'aria-label': 'Kode 设置分区' }, ...settingsSections.map(([id, label]) => h('button', { type: 'button', id: `kode-settings-tab-${id}`, 'aria-current': active === id ? 'page' : undefined, 'aria-controls': `kode-settings-${id}`, key: id, onClick: () => selectSection(id) }, label))),
        h('section', { id: `kode-settings-${active}`, className: 'kode-settings-section', tabIndex: -1, 'aria-label': title },
          bodies[active]())))
  }
  function DefaultModelSettings({ data, disabled, onChange }) {
    const selection = data?.defaultModelSelection, models = data?.models ?? []
    if (!selection || !data?.selectedProfileId) return null
    const selected = models.find(model => model.id === selection.model), efforts = selected?.reasoningEfforts ?? []
    const save = patch => onChange({ action: 'set-default-model', profileId: data.selectedProfileId, ...patch })
    return h('section', { className: 'kode-default-models', 'aria-label': '默认模型配置' },
      h(SelectField, { label: '默认模型', labelHeading: true, value: selection.model, disabled, options: models.map(model => ({ value: model.id, label: model.name ?? model.id })), onChange: model => save({ model }) }),
      efforts.length > 0 && h(SelectField, { label: '推理强度', value: selection.reasoningEffort ?? selected?.defaultReasoningEffort ?? '', disabled: disabled || efforts.length < 2, options: efforts.map(effort => ({ value: effort.id, label: effort.name ?? effort.id })), onChange: reasoningEffort => save({ model: selection.model, reasoningEffort, fast: selection.fast }) }),
      selected?.fastCapability && h('div', { className: 'kode-default-fast' }, h('span', null, 'Fast'), h(FastSwitch, { checked: selection.fast, disabled, onChange: fast => save({ model: selection.model, reasoningEffort: selection.reasoningEffort, fast }) })),
      h('p', { className: 'kode-config-note' }, '用于此 Agent 的新会话；已有会话保留当前模型与参数。'))
  }
  function AgentModelDefaults({ profile, settingsHost }) {
    const store = directory(undefined, settingsHost, true, profile.id), { data, busy, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
    useEffect(() => { void store.load() }, [store])
    const save = body => { void store.operate(body).catch(() => {}) }
    return h('div', { className: 'kode-agent-model-editor' },
      h(DefaultModelSettings, { data, disabled: busy || !data, onChange: save }),
      !data && !error && h('p', { className: 'kode-config-note', role: 'status' }, '正在读取此 Agent 的模型…'),
      h(Failure, { text: error || data?.modelError }))
  }
  function useAgentVersions(profiles, host) {
    const cliProfiles = profiles.filter(profile => profile.type !== 'dsh')
    const profileIds = cliProfiles.map(profile => profile.id)
    const profileKey = JSON.stringify(cliProfiles.map(profile => [profile.id, profile.executable, profile.env?.PATH]))
    const [versions, setVersions] = useState(null), [dshVersion, setDshVersion] = useState()
    const [error, setError] = useState(''), [pending, setPending] = useState()
    const desktopUpdates = host === 'local' ? window.dshDesktop?.updates : undefined
    const [desktopStatus, setDesktopStatus] = useState()
    useEffect(() => {
      if (!desktopUpdates) return
      let active = true
      const receive = status => { if (active) setDesktopStatus(status) }
      const dispose = desktopUpdates.subscribe?.(receive)
      desktopUpdates.status?.().then(receive).catch(() => {})
      return () => { active = false; dispose?.() }
    }, [desktopUpdates])
    const receive = value => {
      setVersions(value.versions ?? {})
      setError(value.versionError ?? '')
      if (value.dshVersion) setDshVersion(value.dshVersion)
    }
    useEffect(() => {
      if (!profiles.length) return
      setVersions(null)
      setError('')
      const stop = new AbortController()
      void hubCall({ action: 'agent-versions', profileIds }, host, undefined, stop.signal)
        .then(value => { if (!stop.signal.aborted) receive(value) })
        .catch(error => { if (!stop.signal.aborted) { setVersions({}); setError(error.message || '暂时无法检查 Agent 版本。') } })
      return () => stop.abort()
    }, [host, profileKey, Boolean(profiles.length)])
    // Each row keeps the outcome of its own last check or update, so a failure stays beside the Agent it belongs to.
    const [outcomes, setOutcomes] = useState({})
    const operate = async (id, update) => {
      const before = versions?.[id]?.current
      setPending(id); setError(''); setOutcomes(rows => ({ ...rows, [id]: { phase: update ? 'updating' : 'checking' } }))
      try {
        if (update) await hubCall({ action: 'update-agent', profileId: id }, host)
        const value = await hubCall({ action: 'agent-versions', profileIds, refresh: !update }, host)
        receive(value)
        const after = value.versions?.[id]
        setOutcomes(rows => ({ ...rows, [id]: update ? { phase: 'updated', from: before, to: after?.current } : { phase: 'checked', latest: after?.updateAvailable ? after.latest : undefined } }))
      } catch (error) {
        setOutcomes(rows => ({ ...rows, [id]: { phase: 'failed', update, message: String(error.message ?? '').replace(/^kode backend \(\d+\): /, '') || '操作失败，请重试。' } }))
      } finally { setPending(undefined) }
    }
    return { versions, dshVersion, desktopStatus, desktopUpdates, error, pending, operate, outcomes,
      openDesktop: () => Promise.resolve(desktopUpdates.open()).catch(error => setError(error.message)) }
  }
  function AgentVersionIdentity({ profile, state, type }) {
    const desktop = profile.type === 'dsh'
    const status = state.versions?.[profile.id]
    const current = desktop ? state.dshVersion : status?.current
    const latest = desktop && ['available', 'downloading', 'ready'].includes(state.desktopStatus?.phase)
      ? state.desktopStatus.version : status?.updateAvailable ? status.latest : undefined
    const issue = { missing: '未安装', version: '无法读取版本', manual: '由安装工具管理', registry: '无法检查更新' }[status?.issue]
    const detail = latest ? `可更新到 ${latest}` : issue
    return h('span', { className: 'kode-agent-version-identity' },
      h('span', { className: 'kode-agent-name' }, profile.name),
      h('span', { className: 'kode-agent-version-line' },
        type && h('span', { className: 'kode-agent-version-type' }, type),
        h('span', { className: current ? 'kode-agent-installed-version' : '' }, current ?? (state.versions ? issue ?? '版本未知' : '正在读取版本…')),
        detail && (current || latest) && h('span', { className: 'kode-agent-version-detail', 'data-available': Boolean(latest) }, detail)))
  }
  function AgentUpdateStatus({ profile, state }) {
    const outcome = state.outcomes?.[profile.id]
    if (!outcome || profile.type === 'dsh') return null
    if (outcome.phase === 'failed') return h('p', { className: 'kode-agent-update-status', 'data-phase': 'failed', role: 'alert' },
      h(IconWarningOutlineRegular, { size: 14, 'aria-hidden': true }), h('span', null, h('strong', null, outcome.update ? '更新失败' : '检查失败'), '：', outcome.message.replace(/^(?:更新|检查)失败[，,：:]\s*/, '') || '请重试。'))
    const text = {
      updating: profile.type === 'cursor' ? '正在更新，Cursor 需下载完整安装包，可能需要几分钟…' : '正在更新…',
      checking: '正在检查更新…',
      updated: outcome.to ? `已更新${outcome.from ? `：${outcome.from} → ${outcome.to}` : `到 ${outcome.to}`}` : '已更新',
      checked: outcome.latest ? `可更新到 ${outcome.latest}` : '已是最新版本',
    }[outcome.phase]
    return h('p', { className: 'kode-agent-update-status', 'data-phase': outcome.phase, role: 'status', 'aria-live': 'polite' },
      ['updating', 'checking'].includes(outcome.phase) ? h(IconLoadingOutlineRegular, { size: 14, className: 'kode-spin', 'aria-hidden': true }) : h(IconCheckOutlineRegular, { size: 14, 'aria-hidden': true }), h('span', null, text))
  }
  function AgentUpdateButton({ profile, state }) {
    const desktop = profile.type === 'dsh', status = state.versions?.[profile.id]
    const available = desktop ? ['available', 'downloading', 'ready'].includes(state.desktopStatus?.phase) : status?.updateAvailable
    const retry = !desktop && Boolean(state.versions) && (!status || status.issue === 'registry' || status.issue === 'version' || status.issue === 'missing')
    const runnable = desktop ? Boolean(state.desktopUpdates?.open) : available || retry
    const action = desktop ? '更新' : retry ? '检查更新' : '更新'
    return h(Button, { size: 'sm', variant: available ? 'primary' : 'outline',
      disabled: !runnable || Boolean(state.pending) && !desktop, 'aria-label': `${action} ${profile.name}`,
      title: !runnable && (desktop || status?.issue === 'manual') ? '请通过此 Agent 的安装工具更新' : undefined,
      onClick: () => desktop ? state.openDesktop() : state.operate(profile.id, available) },
    state.pending === profile.id ? (available ? '更新中…' : '检查中…') : action)
  }
  function AgentSettingsBody({ sessions, slots, settingsHost }) {
    const store = directory(undefined, settingsHost, true)
    const { data, busy, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
    useEffect(() => { void store.load() }, [store])
    const [draft, setDraft] = useState(() => newDraft()), [saved, setSaved] = useState(false), [formError, setFormError] = useState(''), [deleting, setDeleting] = useState(false), [editing, setEditing] = useState(false)
    const [defaultBusy, setDefaultBusy] = useState(false), [modelProfileId, setModelProfileId] = useState()
    const versionState = useAgentVersions(data?.profiles ?? [], settingsHost)
    const harness = data?.profiles?.find(profile => profile.type === 'dsh')
    const customProfiles = (data?.profiles ?? []).filter(p => p.origin !== 'builtin' && p.type !== 'dsh')
    const identity = (profile, type) => h(AgentVersionIdentity, { profile, state: versionState, type })
    const updateButton = profile => h(AgentUpdateButton, { profile, state: versionState })
    const updateStatus = profile => h(AgentUpdateStatus, { profile, state: versionState })
    const edit = profile => { setEditing(true); setSaved(false); setFormError(''); setDraft({ ...profile, argsText: JSON.stringify(profile.args ?? []), envText: JSON.stringify(profile.env ?? {}, null, 2) }) }
    const change = patch => { setSaved(false); setDraft(value => ({ ...value, ...patch })) }
    const field = (label, key, props = {}) => h('label', { className: 'kode-field' }, h('span', null, label), h('input', { value: draft[key] ?? '', onChange: e => change({ [key]: e.target.value }), ...props }))
    const modelButton = profile => h(Button, { size: 'sm', variant: 'outline', 'aria-label': `设置 ${profile.name} 默认模型`, 'aria-expanded': modelProfileId === profile.id, onClick: () => setModelProfileId(value => value === profile.id ? undefined : profile.id) }, '默认模型')
    const modelEditor = profile => modelProfileId === profile.id && h(AgentModelDefaults, { key: profile.id, profile, settingsHost })
    useEffect(() => { if (requestedProfile && data) { const profile = data.profiles.find(p => p.id === requestedProfile); if (profile) setDraft({ ...profile, argsText: JSON.stringify(profile.args ?? []), envText: JSON.stringify(profile.env ?? {}, null, 2) }); requestedProfile = undefined } }, [data])
    const editor = h(React.Fragment, null, h('form', { id: 'kode-agent-form', className: 'kode-config-form', onSubmit: e => {
          e.preventDefault(); setSaved(false); setFormError('')
          const { argsText, envText, ...profile } = draft
          try {
            const value = { ...profile, ...(profile.defaultModel ? {} : { defaultModel: undefined }), ...(profile.type === 'dsh' ? {} : { args: JSON.parse(argsText), env: JSON.parse(envText) }) }
            void store.operate({ action: 'save', profile: value }).then(result => { if (result) { edit(result.profile); setSaved(true); setEditing(false) } }).catch(() => {})
          } catch { setFormError('参数或环境变量的 JSON 格式有误，请检查后重试。') }
        } },
          field('名称', 'name', { required: true, placeholder: '例如：Codex / Tcodex', autoComplete: 'off' }),
          h(SelectField, { label: 'Agent 类型', value: draft.type, options: Object.entries(data?.types ?? {}).map(([value, spec]) => ({ value, label: spec.name })), onChange: type => change({ type, executable: data.types[type].executable ?? '', argsText: '[]', protocol: type === 'custom' ? 'acp' : undefined }) }),
          draft.type !== 'dsh' && field('可执行文件', 'executable', { required: true, placeholder: data?.types[draft.type]?.executable, spellCheck: false }),
          draft.type === 'custom' && h(SelectField, { label: '通信协议', value: draft.protocol ?? 'acp', options: [{ value: 'acp', label: 'ACP' }, { value: 'codex', label: 'Codex app-server' }], onChange: protocol => change({ protocol }) }),
          h('p', { className: 'kode-config-note' }, '模型从 Agent 自动读取，工作区跟随当前会话。', ['claude', 'codebuddy', 'cursor', 'antigravity', 'custom'].includes(draft.type) && draft.protocol !== 'codex' ? '操作审批已接入；文件隔离范围由 Agent 自身能力决定。' : '访问模式应用于执行沙箱。'),
          h(AdvancedSection, { title: '高级设置' },
            draft.type !== 'dsh' && field('启动参数（JSON 数组）', 'argsText', { spellCheck: false }),
            draft.type !== 'dsh' && h('label', { className: 'kode-field' }, h('span', null, '环境变量（JSON 对象）'), h('textarea', { rows: 4, spellCheck: false, value: draft.envText, onChange: e => change({ envText: e.target.value }) })),
          ), h('p', { className: 'kode-config-note' }, '配置修改用于新会话，已有会话保留启动配置。'),
          h(Failure, { text: formError || error }),
        ),
      h('div', { className: 'kode-settings-footer' }, draft.id && customProfiles.some(p => p.id === draft.id) && h(Button, { variant: 'outline', className: 'kode-delete', disabled: busy, onClick: () => setDeleting(true) }, '删除配置'), h(Button, { variant: 'outline', disabled: busy, onClick: () => setEditing(false) }, '取消'), h(Button, { variant: 'primary', type: 'submit', form: 'kode-agent-form', disabled: busy }, busy ? '保存中…' : '保存配置')))
    return h('section', { className: 'kode-agent-settings', 'aria-label': 'Agent 设置' },
      h('div', { className: 'kode-settings-group' }, h('h3', { className: 'kode-settings-group-title' }, '默认 Agent'),
        h('div', { className: 'kode-settings-card kode-settings-card-padded' }, h('div', { className: 'kode-settings-scope' },
          h(SelectField, { label: '默认 Agent', showLabel: false, value: data?.configuredDefaultProfileId ?? data?.profiles?.find(profile => `kode-agent-${profile.id}` === data?.selection?.provider)?.id ?? '', disabled: busy || defaultBusy || !data, options: [{ value: '', label: '自动选择' }, ...(data?.profiles ?? []).map(profile => ({ value: profile.id, label: profile.name }))], onChange: profileId => { setSaved(false); setFormError(''); setDefaultBusy(true); void saveDefaultAgent(settingsHost, profileId ? data.profiles.find(profile => profile.id === profileId) : null).then(async () => { await store.load(); setSaved(true) }).catch(error => setFormError(error.message)).finally(() => setDefaultBusy(false)) } })))),
      !data && !error && h('p', { className: 'kode-config-note', role: 'status' }, '正在连接并读取 Agent 配置…'),
      error && h(Button, { variant: 'outline', onClick: () => store.load(), disabled: busy }, '重试连接'),
      saved && h('p', { className: 'kode-config-note', role: 'status' }, '已保存'),
      h(Failure, { text: !editing ? formError || error || versionState.error : '' }),
      h('div', { className: 'kode-settings-group' }, h('h3', { className: 'kode-settings-group-title' }, '内置 Agent'),
        data && h('div', { className: 'kode-settings-card kode-agent-list-card' }, h('ul', { className: 'kode-agent-rows' },
        ...(data?.profiles ?? []).filter(profile => profile.origin === 'builtin' && profile.type !== 'dsh').map(profile => h('li', { className: 'kode-agent-row', key: profile.id },
          h('div', { className: 'kode-agent-row-head' },
            h('button', { type: 'button', className: 'kode-session-avatar-button', 'aria-label': `设置 ${profile.name} 默认头像`, onClick: () => openAvatarDialog({ profile, host: settingsHost }) }, h(EditableAgentAvatar, { profile, host: settingsHost })),
            identity(profile), h('div', { className: 'kode-agent-row-actions' }, modelButton(profile), updateButton(profile))), updateStatus(profile), modelEditor(profile))),
        harness && h('li', { className: 'kode-agent-row' },
          h('div', { className: 'kode-agent-row-head' },
            h('button', { type: 'button', className: 'kode-session-avatar-button', 'aria-label': '设置 DeepSeek Harness 默认头像', onClick: () => openAvatarDialog({ profile: harness, host: settingsHost }) }, h(EditableAgentAvatar, { profile: harness, host: settingsHost })),
            identity(harness), h('div', { className: 'kode-agent-row-actions' },
              modelButton(harness), settingsHost === (transport?.current ?? 'local') && h(Button, { size: 'sm', variant: 'outline', 'aria-label': '编辑 DeepSeek Harness', onClick: () => openSettings(slots, 'models') }, '模型设置'), updateButton(harness))), modelEditor(harness)),
      ))),
      h('div', { className: 'kode-settings-group' }, h('h3', { className: 'kode-settings-group-title' }, '自定义 Agent'),
        customProfiles.length > 0 && h('div', { className: 'kode-settings-card kode-agent-list-card' }, h('ul', { className: 'kode-agent-rows' },
        ...customProfiles.map(p => h('li', { className: 'kode-agent-row', key: p.id },
          h('div', { className: 'kode-agent-row-head' },
            h('button', { type: 'button', className: 'kode-session-avatar-button', 'aria-label': `设置 ${p.name} 默认头像`, onClick: () => openAvatarDialog({ profile: p, host: settingsHost }) }, h(EditableAgentAvatar, { profile: p, host: settingsHost })),
            identity(p, data.types[p.type]?.name), h('div', { className: 'kode-agent-row-actions' }, modelButton(p),
              h(Button, { size: 'sm', variant: 'outline', disabled: busy, 'aria-label': `编辑 ${p.name}`, 'aria-expanded': editing && draft.id === p.id, onClick: () => editing && draft.id === p.id ? setEditing(false) : edit(p) }, editing && draft.id === p.id ? '收起' : '编辑'), updateButton(p))),
          updateStatus(p), modelEditor(p), editing && draft.id === p.id && h('div', { className: 'kode-agent-editor' }, editor))),
      ))),
      h(Button, { variant: 'outline', className: 'kode-agent-add', disabled: busy || !data, onClick: () => edit(newDraft(data?.types)) }, h(IconPlusOutlineRegular, { size: 16 }), '添加 Agent'),
      editing && !draft.id && h('div', { className: 'kode-agent-editor' }, editor),
      h(Modal, { open: deleting, title: `删除 ${draft.name}？`, className: 'kode-confirm-dialog', closeLabel: '关闭', onClose: () => setDeleting(false), description: '此配置将从 Agent 列表移除。已有会话和启动配置会保留。', footer: h(React.Fragment, null, h(Button, { variant: 'outline', onClick: () => setDeleting(false) }, '取消'), h(Button, { variant: 'primary', disabled: busy, onClick: () => { void store.operate({ action: 'remove', profileId: draft.id }).then(async result => { if (result) { if (data?.selection?.provider === `kode-agent-${draft.id}`) await saveDefaultAgent(settingsHost, null); await store.load(); setDeleting(false); setEditing(false); setSaved(false) } }).catch(error => setFormError(error.message)) } }, '删除配置')) }, h(Failure, { text: error })),
    )
  }
