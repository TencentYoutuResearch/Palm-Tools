  function useIntegrationSettings(host) {
    const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const [recoveryNeeded, setRecoveryNeeded] = useState(false), [reload, setReload] = useState(0)
    const writing = React.useRef(false), revision = React.useRef(0)
    const request = async (body, signal) => {
      const options = body ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin' }
      options.signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
      const response = await fetchHost('/api/kode/integrations', options, host)
      const value = await parseHostJson(response)
      if (!response.ok) throw Object.assign(new Error(value.error ?? '无法读取设置，请重试。'), { code: value.code, status: response.status })
      return value
    }
    useEffect(() => {
      let alive = true, pending = false
      const refresh = async () => {
        if (pending || writing.current) return
        pending = true
        const before = revision.current
        try { const value = await request(); if (alive && !writing.current && revision.current === before) { setData(value); setError(''); setRecoveryNeeded(false) } }
        catch (error) { if (alive && !writing.current && revision.current === before) { setError(error.message); setRecoveryNeeded(error.code === 'KODE_SERVICE_UPDATE_REQUIRED') } }
        finally { pending = false }
      }
      void refresh(); const timer = setInterval(() => { void refresh() }, 5000)
      return () => { alive = false; clearInterval(timer) }
    }, [host, reload])
    const update = async body => {
      revision.current++; writing.current = true; setBusy(true); setError('')
      try { const value = await request(body); if (value.settings) setData(prior => ({ ...prior, settings: value.settings })); return value }
      catch (error) { setError(error.message); setRecoveryNeeded(error.code === 'KODE_SERVICE_UPDATE_REQUIRED'); return null }
      finally { writing.current = false; setBusy(false) }
    }
    return { data, busy, error, update, recoveryNeeded, retry: () => setReload(value => value + 1), request }
  }
  function ServiceRecovery({ host, settings, status, onBusyChange }) {
    const { data: hosts } = useProjectHosts()
    const [busy, setBusy] = useState(false), [job, setJob] = useState(null), [error, setError] = useState(''), [success, setSuccess] = useState(false)
    const [warning, setWarning] = useState(null)
    const task = React.useRef(null)
    useEffect(() => () => task.current?.abort(), [])
    useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false) }, [busy, onBusyChange])
    const supported = host === 'local' ? hosts.localRecoverySupported === true : hosts.deploymentSupported !== false
    const hintId = React.useId()
    const recover = async confirmedSessions => {
      if (task.current) return
      const controller = new AbortController(); task.current = controller
      setBusy(true); setError(''); setSuccess(false)
      try {
        setWarning(null)
        const result = await recoverHostService(host, {
          confirmedSessions,
          signal: controller.signal, progress: setJob, readSettings: () => settings.request(undefined, controller.signal),
          request: async (body, id) => {
            const response = await fetch(`/api/kode/project-hosts?current=local${id ? `&${host === 'local' ? 'recovery' : 'deployment'}=${encodeURIComponent(id)}` : ''}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal, ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
            let value
            try { value = await parseHostJson(response) } catch (error) { if (error.code === 'KODE_SERVICE_UPDATE_REQUIRED') throw new Error('此计算机的 Host 尚不支持自动恢复，请先更新并重启 Web Host 和 Kode 服务。'); throw error }
            if (!response.ok) throw new Error(value.error === '未知项目操作。' ? '此计算机的 Host 尚不支持自动恢复，请先更新并重启 Web Host 和 Kode 服务。' : value.error || '无法恢复服务，请重试。')
            return value
          },
          delay: (ms, signal) => new Promise((resolve, reject) => {
            const done = () => { signal.removeEventListener('abort', abort); resolve() }
            const timer = setTimeout(done, ms)
            const abort = () => { clearTimeout(timer); reject(signal.reason) }
            signal.addEventListener('abort', abort, { once: true })
          }),
        })
        if (result?.status === 'confirmation-required') { if (!controller.signal.aborted) setWarning(result.sessions); return }
        if (!controller.signal.aborted) { setSuccess(true); settings.retry() }
      } catch (error) { if (!controller.signal.aborted) setError(error.message) }
      finally { if (!controller.signal.aborted) setBusy(false); task.current = null }
    }
    const hint = host !== 'local' ? '通过 SSH 更新并重启所选主机的服务。'
      : supported ? '重启期间会话通信会短暂断开，服务就绪后会自动重连。'
        : hosts.localRecoverySupported === false ? '此启动方式不支持在这里重启本机服务，请在服务部署处重启后重新连接。' : ''
    // One service row: state and what the buttons do on the left, the buttons themselves aligned on the right.
    return h('div', { className: 'kode-service-recovery', 'aria-busy': busy },
      h('div', { className: 'kode-service-row' },
        h('div', { className: 'kode-service-row-main' }, status,
          hint && h('p', { id: hintId, className: 'kode-config-note kode-service-hint' }, hint)),
        h('div', { className: 'kode-service-recovery-actions' },
          supported && h(Button, { size: 'sm', variant: 'outline', 'aria-describedby': hintId, disabled: busy, onClick: () => void recover() }, busy ? host === 'local' ? '正在重启…' : '正在更新部署…' : host === 'local' ? '重启服务' : '更新并部署服务'),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => { setSuccess(false); settings.retry() } }, '重新连接'))),
      (busy || success) && h('p', { className: 'kode-config-note kode-service-progress', role: 'status', 'aria-live': 'polite' },
        success ? (host === 'local' ? '服务已重启' : '服务已更新并连接')
          : job?.steps?.find(step => step.status === 'running')?.message || (host === 'local' ? '正在等待服务重新启动…' : job?.status === 'done' ? '部署完成，正在检查接口…' : '正在准备部署…')),
      warning && h(Modal, { open: true, title: '中断会话并重启？', closeLabel: '关闭', className: 'kode-confirm-dialog',
        onClose: () => setWarning(null), description: '此启动方式还需要重启 Web Host。当前执行会中断，已保存的对话和排队消息会保留。',
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', onClick: () => setWarning(null) }, '取消'),
          h(Button, { className: 'kode-delete', onClick: () => void recover(warning.map(row => row.id)) }, '中断并重启')) },
        h('ul', null, ...warning.map(row => h('li', { key: row.id }, row.title)))),
      h(Failure, { text: error }))
  }
  function ServiceRecoveryLink({ host, slots }) {
    const [error, setError] = useState('')
    const open = () => {
      try { requestedServiceHost = host; openSettings(slots, 'kode-ssh') }
      catch (error) { requestedServiceHost = undefined; setError(error.message) }
    }
    return h('div', null,
      h(Button, { variant: 'outline', onClick: open }, '前往主机与服务'),
      h(Failure, { text: error }))
  }
  function HostServiceStatus({ host, onBusyChange }) {
    const settings = useIntegrationSettings(host)
    return h('section', { className: 'kode-settings-group', 'aria-label': '服务状态' },
      h('h3', { className: 'kode-settings-group-title' }, '服务状态'),
      h('div', { className: 'kode-settings-card kode-host-service' },
        h(ServiceRecovery, { host, settings, onBusyChange, status: h('p', { className: 'kode-service-status', role: 'status', 'data-state': settings.error ? 'error' : settings.data ? 'connected' : 'checking' },
          settings.error ? h(IconWarningOutlineRegular, { size: 14, className: 'kode-service-error-icon', 'aria-hidden': true })
            : settings.data ? h(IconCheckOutlineRegular, { size: 14, className: 'kode-service-connected-icon', 'aria-hidden': true }) : h(IconLoadingOutlineRegular, { size: 14, className: 'kode-spin', 'aria-hidden': true }),
          h('strong', null, settings.error ? '服务连接异常' : settings.data ? '服务已连接' : '正在检查服务状态…')) }),
        h(Failure, { text: settings.error })))
  }
  function IntegrationSettingsBody({ host, hubHost, hosts, slots, sessions }) {
    const settings = useIntegrationSettings(host), { data, busy, error, update } = settings
    const integration = (key, label, detail) => h('label', { className: 'kode-integration-row' },
      h('span', null, h('strong', null, label), h('span', { className: 'kode-config-note' }, detail)),
      h('input', { type: 'checkbox', role: 'switch', checked: data.settings[key], disabled: busy, onChange: event => void update({ action: 'configure', settings: { [key]: event.target.checked } }) }))
    const namingPrompt = data?.settings.session_naming_prompt
    return h(React.Fragment, null,
      h('div', { className: 'kode-settings-group', 'aria-label': '内置能力' },
        h('h3', { className: 'kode-settings-group-title' }, '内置能力'),
        !data && !error && h('p', { role: 'status', className: 'kode-config-note' }, '正在读取集成配置…'),
        data && h('div', { className: 'kode-settings-card' },
          h('div', { className: 'kode-messaging-settings', role: 'group', 'aria-label': '会话通信' },
            integration('messaging_enabled', '会话通信', '允许 Agent 发现其他会话、发送任务和接收回复。'),
            typeof namingPrompt === 'string' ? h(SessionNamingSettings, { prompt: namingPrompt, defaultPrompt: data.sessionNaming?.defaultPrompt, maxWords: data.sessionNaming?.maxWords, busy, update })
              : h('div', { className: 'kode-session-naming' },
                h('strong', null, 'Agent 会话命名'),
                h('p', { className: 'kode-config-note' }, '当前 Kode 服务不支持自定义命名。更新服务后即可设置。'),
                h(ServiceRecoveryLink, { host, slots }))),
          integration('memory_enabled', '共享记忆', '允许 Agent 搜索已审核的记忆并提交待审核提议。'),
          typeof openMemoryPage === 'function' && h('div', { className: 'kode-memory-settings-link' },
            h('span', { className: 'kode-config-note' }, 'Agent 提交的记忆需人工审批后才会入库，批准后自动全额返还能量。'),
            h(Button, { type: 'button', variant: 'outline', onClick: () => openMemoryPage?.() }, '打开记忆审批'))),
        h(Failure, { text: error }), settings.recoveryNeeded && h(ServiceRecoveryLink, { host, slots })),
      h(HubSettings, { key: hubHost, host: hubHost, hosts, sessions, slots }))
  }
  // The effective rule is always visible; editing is a separate state so 保存/恢复默认 never sit beside a read-only view.
  function SessionNamingSettings({ prompt, defaultPrompt, maxWords = 4, busy, update }) {
    const [draft, setDraft] = useState(null), [saved, setSaved] = useState(false), field = useRef(null), editButton = useRef(null)
    const custom = prompt.trim(), effective = custom || defaultPrompt || ''
    const editing = draft !== null, value = draft ?? effective
    const next = value.trim() === (defaultPrompt ?? '').trim() ? '' : value.trim()
    const dirty = editing && next !== custom
    useEffect(() => { if (editing) field.current?.focus() }, [editing])
    const finish = () => { setDraft(null); requestAnimationFrame(() => editButton.current?.focus()) }
    const save = async text => {
      setSaved(false)
      if (await update({ action: 'configure', settings: { session_naming_prompt: text } })) { finish(); setSaved(true) }
    }
    const note = `适用于 Agent 通过会话通信创建的会话。标题最多 ${maxWords} 个词，含意图前缀。`
    if (!editing) return h('div', { className: 'kode-session-naming' },
      h('div', { className: 'kode-session-naming-head' },
        h('span', { className: 'kode-session-naming-title' }, h('strong', { id: 'kode-session-naming-label' }, 'Agent 会话命名'),
          h('span', { className: 'kode-session-naming-tag', 'data-custom': Boolean(custom) }, custom ? '自定义' : '默认')),
        saved && h('span', { className: 'kode-saved', role: 'status' }, '已保存'),
        h(Button, { ref: editButton, size: 'sm', variant: 'outline', disabled: busy, onClick: () => { setSaved(false); setDraft(effective) } }, '编辑规则')),
      h('p', { className: 'kode-config-note' }, note),
      effective ? h('pre', { className: 'kode-session-naming-rule', 'aria-labelledby': 'kode-session-naming-label', tabIndex: 0 }, effective)
        : h('p', { className: 'kode-config-note' }, '使用此主机 Kode 服务内置的默认规则。'))
    return h('form', { className: 'kode-session-naming', 'data-editing': '', onSubmit: event => { event.preventDefault(); if (dirty && !busy && value.trim()) void save(next) },
      onKeyDown: event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); finish() } } },
      h('label', { className: 'kode-field' },
        h('span', { className: 'kode-session-naming-title' }, h('strong', null, '编辑 Agent 会话命名'),
          h('span', { className: 'kode-session-naming-tag', 'data-custom': Boolean(custom) }, custom ? '自定义' : '默认')),
        h('span', { className: 'kode-config-note' }, note, ' 用自然语言描述格式、语言和示例；与默认规则相同即视为使用默认。'),
        h('textarea', { ref: field, rows: Math.min(10, Math.max(4, value.split('\n').length + 1)), value, maxLength: 2000, disabled: busy, spellCheck: false,
          onChange: event => { setDraft(event.target.value); setSaved(false) } })),
      h('div', { className: 'kode-session-naming-actions' },
        custom && h(Button, { type: 'button', variant: 'outline', className: 'kode-session-naming-reset', disabled: busy, onClick: () => void save('') }, '恢复默认'),
        h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: finish }, '取消'),
        h(Button, { type: 'submit', variant: 'primary', disabled: busy || !dirty || !value.trim() }, busy ? '保存中…' : '保存规则')))
  }
  function SessionBehaviorSettings({ host, slots }) {
    const settings = useIntegrationSettings(host), { data, busy, error, update } = settings
    return h(React.Fragment, null,
      h('h3', { className: 'kode-settings-group-title' }, '会话行为'),
      h('p', { className: 'kode-config-note' }, '此计算机的会话行为；远端主机保留各自的配置。'),
      !data && !error && h('p', { role: 'status', className: 'kode-config-note' }, '正在读取会话配置…'),
      data && h('div', { className: 'kode-settings-card' },
        h('label', { className: 'kode-integration-row' },
          h('span', null, h('strong', null, '重启后自动续接'), h('span', { className: 'kode-config-note' }, '自动继续因应用重启或异常退出而中断的任务；已完成、主动停止及已归档的会话不会续接。')),
          h('input', { type: 'checkbox', role: 'switch', checked: data.settings.auto_resume_interrupted, disabled: busy, onChange: event => void update({ action: 'configure', settings: { auto_resume_interrupted: event.target.checked } }) }))),
      h(Failure, { text: error }), settings.recoveryNeeded && h(ServiceRecoveryLink, { host, slots }))
  }
  function MobileSettingsBody({ host, slots }) {
    const settings = useIntegrationSettings(host), { data, busy, error, update } = settings
    const [server, setServer] = useState(''), [pairing, setPairing] = useState(null)
    const initialized = React.useRef(false)
    useEffect(() => {
      if (data && !initialized.current) { initialized.current = true; setServer(data.cloud.server_url ?? '') }
    }, [data])
    const pair = async () => {
      setPairing(null)
      const value = await update({ action: 'pair', server_url: server.trim() })
      if (value?.pairing) setPairing(value.pairing)
    }
    return h('div', { className: 'kode-settings-group' },
      h('h3', { className: 'kode-settings-group-title' }, '手机配对'),
      h('p', { className: 'kode-config-note' }, '配对后可在手机上查看、创建和继续会话。填写手机可访问的同步服务地址，再使用 Kode 手机 App 扫码。'),
      !data && !error && h('p', { role: 'status', className: 'kode-config-note' }, '正在读取手机与同步配置…'),
      data && h('section', { className: 'kode-settings-card kode-mobile-pairing', 'aria-label': '手机配对' },
        h('form', { className: 'kode-mobile-pairing-form', onSubmit: event => { event.preventDefault(); if (!busy && server.trim()) void pair() } },
          h('label', { className: 'kode-field' }, h('span', null, '同步服务地址'), h('input', { type: 'url', value: server, disabled: busy, placeholder: 'https://sync.example.com', onChange: event => { setServer(event.target.value); setPairing(null) } })),
          h('div', { className: 'kode-mobile-pairing-actions' },
            data.cloud.connected && h('span', { className: 'kode-config-note kode-service-status', role: 'status' }, h(IconCheckOutlineRegular, { size: 14, className: 'kode-service-connected-icon', 'aria-hidden': true }), '同步服务已连接'),
            h(Button, { type: 'submit', variant: 'primary', disabled: busy || !server.trim() }, busy ? '正在生成…' : pairing ? '重新生成配对二维码' : '生成配对二维码'))),
        pairing && h(MobilePairingInvite, { key: pairing.uri, pairing })),
      h(Failure, { text: error }), settings.recoveryNeeded && h(ServiceRecoveryLink, { host, slots }))
  }
  function MobilePairingInvite({ pairing }) {
    const expiresAt = Number(pairing.expires_at)
    const [expired, setExpired] = useState(() => Number.isFinite(expiresAt) && expiresAt <= Date.now())
    const [imageFailed, setImageFailed] = useState(false)
    useEffect(() => {
      if (!Number.isFinite(expiresAt)) return
      const timer = setTimeout(() => setExpired(true), Math.max(0, expiresAt - Date.now()))
      return () => clearTimeout(timer)
    }, [expiresAt])
    if (expired) return h('p', { className: 'kode-config-note kode-pairing-result', role: 'status' }, '配对码已过期，请重新生成。')
    return h('div', { className: 'kode-pairing-result' },
      pairing.qr_data_url && !imageFailed
        ? h('figure', { className: 'kode-pairing-qr' },
          h('img', { src: pairing.qr_data_url, alt: 'Kode 手机 App 一次性配对二维码', width: 280, height: 280, onError: () => setImageFailed(true) }),
          h('figcaption', { className: 'kode-config-note' }, '打开 Kode 手机 App，使用扫码功能扫描此二维码。'))
        : h('p', { className: 'kode-config-note', role: 'status' }, pairing.qr_error || '二维码暂不可用，请使用下方配对链接，或更新所选主机的 dsh 插件。'),
      h('label', { className: 'kode-field' }, h('span', null, '手动配对链接'), h('textarea', { readOnly: true, value: pairing.uri, rows: 4, onFocus: event => event.target.select() }), h('span', { className: 'kode-config-note' }, '也可将链接粘贴到手机 App 的手动配对页面。')),
      h('p', { className: 'kode-config-note' }, `二维码和链接仅可使用一次${Number.isFinite(expiresAt) ? `，有效期至 ${new Date(expiresAt).toLocaleTimeString()}` : ''}；使用后或过期后请重新生成。`))
  }
