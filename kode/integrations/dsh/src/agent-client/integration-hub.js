  async function hubCall(body, host, sessionId, signal) {
    const response = await fetchHost('/api/kode/agent-hub' + (sessionId ? '?session_id=' + encodeURIComponent(sessionId) : ''), {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }, host)
    const value = await parseHostJson(response)
    if (!response.ok) {
      if (body?.action === 'handoff-skill' && value.error === 'Unknown operation') throw new Error('更新此主机的 Kode 插件后即可执行技能交接。')
      throw new Error(value.error || '操作失败，请重试。')
    }
    return value
  }
  function PowerSettings({ host }) {
    const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
    useEffect(() => {
      const stop = new AbortController()
      setData(null); setError('')
      void hubCall(undefined, host, undefined, stop.signal).then(setData).catch(error => { if (!stop.signal.aborted) setError(error.message) })
      return () => stop.abort()
    }, [host])
    const update = async enabled => {
      setBusy(true); setError('')
      try { setData(await hubCall({ action: 'power', enabled }, host)) }
      catch (error) { setError(error.message) }
      finally { setBusy(false) }
    }
    return h('div', { className: 'kode-settings-group kode-power-settings' },
      h('h3', { className: 'kode-settings-group-title' }, '电源'),
      h('div', { className: 'kode-settings-card' },
        !data && !error && h('p', { className: 'kode-config-note', role: 'status' }, '正在读取电源设置…'),
        data && h(React.Fragment, null,
          h('label', { className: 'kode-integration-row' }, h('span', null, h('strong', null, '息屏后继续运行'), h('span', { className: 'kode-config-note' }, '阻止此主机自动休眠，屏幕仍可熄灭。停止 Kode 后端后释放；合盖和手动休眠由系统控制。')),
            h('input', { type: 'checkbox', role: 'switch', checked: data.keepAwake, disabled: busy || !data.power.supported, onChange: event => void update(event.target.checked) })),
          h('p', { className: 'kode-config-note', role: 'status' }, data.power.error || (data.power.active ? '主机正在保持唤醒。' : data.power.supported ? '主机使用系统默认休眠设置。' : '此主机暂不支持保持唤醒。'))),
        h(Failure, { text: error })))
  }
  const hubTargetNames = { dsh: 'DeepSeek Harness', codex: 'Codex', claude: 'Claude Code', codebuddy: 'CodeBuddy', cursor: 'Cursor', antigravity: 'Antigravity', tcodex: 'TCodex', tclaude: 'TClaude' }
  function sourceProfileTarget(profile, data) {
    if (!profile) return
    if (data?.profileTargets) return data.profileTargets[profile.id] ?? (profile.type === 'dsh' ? 'dsh' : undefined)
    // Older services only accept their original fixed targets.
    const override = { claude: 'CLAUDE_CONFIG_DIR', codebuddy: 'CODEBUDDY_CONFIG_DIR', codex: 'CODEX_HOME' }[profile.type]
    if (profile.env?.KODE_SKILLS_DIR || profile.env?.[override] || /(?:^|\/)(?:tclaude|tcodex)(?:\.exe)?$/.test(profile.executable ?? '')) return
    if (Object.hasOwn(data?.targets ?? {}, profile.type)) return profile.type
  }
  function sourceTargetOptions(profiles, data) {
    const options = new Map(), unavailable = []
    for (const profile of profiles) {
      const target = sourceProfileTarget(profile, data)
      if (!target) { unavailable.push(profile.name); continue }
      if (!options.has(target)) options.set(target, { id: target, names: [], path: data.targets[target] })
      const names = options.get(target).names
      if (!names.includes(profile.name)) names.push(profile.name)
    }
    return { options, unavailable }
  }
  function sourceTargetLabel(target, options) {
    return options?.get(target)?.names.join(' / ') ?? hubTargetNames[target] ?? '已变更的技能目录'
  }
  const MCP_STATUS_LABELS = {
    'login-required': '需要登录', authorized: '已授权', connected: '已连接',
    'not-required': '无需授权', manual: '需手动配置', unknown: '状态未知',
  }
  const mcpStatusKey = (sourceId, profileId) => `${sourceId}\0${profileId}`
  const mcpRowKey = (sourceId, profileId, row) => `${sourceId}\0${profileId}\0${row.packageKey}\0${row.name}`
  // Services advertising packageToggle key path-only records by their relative path inside the source.
  const sourcePackageKey = (pkg, packageToggle) => pkg?.key ?? (packageToggle ? pkg?.path : undefined)
  function sourceMcpProfiles(source, data, profiles) {
    if (!source?.updatedAt || !(source.packages ?? []).some(pkg => pkg.mcp?.length)) return []
    return profiles.flatMap(profile => {
      const target = sourceProfileTarget(profile, data)
      if (!target || !(source.targets ?? []).includes(target)) return []
      const synced = Array.isArray(source.syncedTargets) ? source.syncedTargets.includes(target) : true
      return synced ? [{ profile, target }] : []
    })
  }
  function HubSettings({ host, hosts = [], sessions, slots }) {
    const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
    const [mcpStatuses, setMcpStatuses] = useState({}), [mcpErrors, setMcpErrors] = useState({}), [mcpPending, setMcpPending] = useState({})
    const [draft, setDraft] = useState(null)
    const [previewId, setPreviewId] = useState(null), [previewPackagePath, setPreviewPackagePath] = useState(null)
    const store = directory(undefined, host, true)
    const { data: agents, error: agentError } = useSyncExternalStore(store.subscribe, store.getSnapshot)
    const listed = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
    useEffect(() => { void store.load() }, [store])
    useEffect(() => {
      if (busy) return
      const stop = new AbortController()
      const read = async () => {
        try { const next = await hubCall(undefined, host, undefined, stop.signal); if (!stop.signal.aborted) setData(next) }
        catch (error) { if (!stop.signal.aborted) setError(error.message) }
      }
      void read()
      const timer = setInterval(() => { if (!document.hidden) void read() }, 5000)
      return () => { stop.abort(); clearInterval(timer) }
    }, [host, busy])
    const choices = agents?.profiles ?? []
    const current = (transport?.current ?? 'local') === host
      ? Object.values(listed.byId).find(row => row.retainedBy?.mainView > 0)?.projectionValues : undefined
    const model = current?.modelSelection
    const provider = (model?.pending ?? model?.next ?? model?.lastUsed)?.provider
    const activeId = current?.kodeAgent?.profileId ?? choices.find(profile => provider === 'kode-agent-' + profile.id)?.id
    const { options, unavailable } = sourceTargetOptions(choices, data)
    const preferred = [activeId, agents?.configuredDefaultProfileId, agents?.selectedProfileId]
      .map(id => sourceProfileTarget(choices.find(profile => profile.id === id), data)).find(Boolean)
    const sources = data?.sources ?? []
    const readMcpStatus = async (source, profileId, signal) => {
      const key = mcpStatusKey(source.id, profileId)
      setMcpStatuses(current => ({ ...current, [key]: { ...current[key], busy: true, error: '' } }))
      try {
        const result = await hubCall({ action: 'mcp-status', id: source.id, profileId }, host, undefined, signal)
        if (!signal?.aborted) setMcpStatuses(current => ({ ...current, [key]: { ...current[key], rows: result.rows ?? [], busy: false, error: '' } }))
        return result
      } catch (error) {
        if (!signal?.aborted) setMcpStatuses(current => ({ ...current, [key]: { ...current[key], busy: false, error: error.message } }))
        return undefined
      }
    }
    const loginMcp = async (source, profileId, row) => {
      const statusKey = mcpStatusKey(source.id, profileId), rowKey = mcpRowKey(source.id, profileId, row)
      setMcpPending(current => ({ ...current, [rowKey]: true }))
      setMcpErrors(current => { const next = { ...current }; delete next[rowKey]; return next })
      try {
        const result = await hubCall({ action: 'mcp-login', id: source.id, profileId, packageKey: row.packageKey, name: row.name }, host)
        setMcpStatuses(current => ({ ...current, [statusKey]: { ...current[statusKey], rows: result.rows ?? [], busy: false, error: '' } }))
        return true
      } catch (error) {
        setMcpErrors(current => ({ ...current, [rowKey]: error.message }))
        return false
      } finally {
        setMcpPending(current => { const next = { ...current }; delete next[rowKey]; return next })
      }
    }
    const completeMcpLogins = async (next, body) => {
      if (host !== 'local') return
      const source = next.sources?.find(row => row.id === body.id)
      if (!source) return
      for (const { profile } of sourceMcpProfiles(source, next, choices)) {
        const result = await readMcpStatus(source, profile.id)
        const pending = (result?.rows ?? []).filter(row => row.status === 'login-required' && (!body.packageKey || row.packageKey === body.packageKey))
        for (const row of pending) await loginMcp(source, profile.id, row)
      }
    }
    const operate = async body => {
      setBusy(true); setError('')
      try {
        const next = await hubCall(body, host)
        if (body.action === 'sync-source' || (body.action === 'set-package-enabled' && body.enabled)) await completeMcpLogins(next, body)
        setData(next); return true
      } catch (error) { setError(error.message); return false }
      finally { setBusy(false) }
    }
    useEffect(() => {
      if (!data || !agents) return
      const stop = new AbortController()
      for (const source of sources) for (const { profile } of sourceMcpProfiles(source, data, choices)) void readMcpStatus(source, profile.id, stop.signal)
      return () => stop.abort()
    }, [host, data, agents])
    const field = (label, key, placeholder) => h('label', { className: `kode-field kode-source-field-${key}` }, label,
      h('input', { required: key !== 'subdir', readOnly: key === 'id' && draft.editing, value: draft[key], placeholder,
        onChange: event => setDraft({ ...draft, [key]: event.target.value }) }))
    const previewSource = sources.find(source => source.id === previewId)
    const previewProfiles = previewSource ? sourceMcpProfiles(previewSource, data, choices) : []
    const openPreview = id => { setPreviewPackagePath(null); setPreviewId(id) }
    const edit = source => setDraft({ id: source.id, kind: source.kind, location: source.location, subdir: source.subdir ?? '.',
      targets: source.targets, expectedTargets: source.targets, editing: true })
    const add = () => setDraft({ id: '', kind: 'git', location: '', subdir: '.', targets: preferred ? [preferred] : options.size === 1 ? [...options.keys()] : [] })
    const toggle = target => setDraft(value => ({ ...value, targets: value.targets.includes(target)
      ? value.targets.filter(row => row !== target) : [...value.targets, target] }))
    const packageToggle = Boolean(data?.capabilities?.packageToggle)
    const togglePackage = (source, pkg, enabled) => {
      const packageKey = sourcePackageKey(pkg, packageToggle)
      if (!packageKey) { setError('此主机的 Kode 服务版本较旧，更新 Kode 服务后才能逐项启停插件。'); return }
      void operate({ action: 'set-package-enabled', id: source.id, packageKey, enabled, release: source.release })
    }
    const updateService = () => {
      setPreviewId(null)
      try { requestedServiceHost = host; openSettings(slots, 'kode-ssh') }
      catch (error) { requestedServiceHost = undefined; setError(error.message) }
    }
    const save = event => {
      event.preventDefault()
      const { editing, expectedTargets, ...source } = draft
      if (!source.targets.length) { setError('请选择至少一个同步目标。'); return }
      if (!editing && sources.some(row => row.id === source.id.trim())) { setError('此来源标识已在使用，请更换标识。'); return }
      void operate({ action: 'save-source', intent: editing ? 'edit' : 'create', ...(editing ? { expectedTargets } : {}), source }).then(ok => { if (ok) setDraft(null) })
    }
    const editorTargets = draft ? [...new Set([...options.keys(), ...draft.targets])] : []
    const targetHelp = data?.profileTargets
      ? '在 Agent 设置中用 KODE_SKILLS_DIR 指定 CLI 读取技能的绝对路径。'
      : '更新此主机的 Kode 服务后可识别更多 CLI 配置。'
    const form = draft && h('form', { className: 'kode-agent-editor kode-source-editor', onSubmit: save },
      field('来源标识', 'id', 'team-skills'),
      h(SelectField, { label: '来源类型', value: draft.kind, options: [{ value: 'git', label: 'Git 仓库' }, { value: 'local', label: '本地目录' }], onChange: kind => setDraft({ ...draft, kind }) }),
      field(draft.kind === 'git' ? 'Git 地址' : '绝对路径', 'location', draft.kind === 'git' ? 'https://example.com/team/skills.git' : '/path/to/skills'),
      field('子目录', 'subdir', '.'),
      h('fieldset', { className: 'kode-source-target-picker', disabled: busy },
        h('legend', null, '同步到'),
        h('div', { className: 'kode-source-target-options' }, ...editorTargets.map(target => {
          const selected = draft.targets.includes(target), option = options.get(target)
          return h('button', { type: 'button', key: target, className: 'kode-source-target-option', 'aria-pressed': selected,
            title: option?.path, onClick: () => toggle(target) },
          h(selected ? IconCheckOutlineRegular : IconPlusOutlineRegular, { size: 14, 'aria-hidden': true }),
          sourceTargetLabel(target, options))
        })),
        unavailable.length > 0 && h('p', { className: 'kode-config-note' },
          `${unavailable.join('、')} 暂不可选。${targetHelp}`)),
      h('div', { className: 'kode-source-editor-actions' },
        h(Button, { variant: 'outline', disabled: busy, onClick: () => setDraft(null) }, '取消'),
        h(Button, { type: 'submit', variant: 'primary', disabled: busy || !draft.targets.length }, busy ? '保存中…' : draft.editing ? '保存修改' : '添加来源')))
    return h('div', { className: 'kode-settings-group kode-hub-settings' },
      h('h3', { className: 'kode-settings-group-title' }, 'Plugin / Skills 来源'),
      host !== 'local' && h('p', { className: 'kode-config-note' }, '配置主机 · ' + (hosts.find(row => row.id === host)?.name ?? host)),
      h(Failure, { text: error || agentError }),
      (!data || !agents) && !error && !agentError && h('p', { className: 'kode-config-note', role: 'status' }, '正在读取 Agent 和来源…'),
      data && agents && sources.length > 0 && h('div', { className: 'kode-settings-card kode-agent-list-card kode-hub-sources-card' },
        h('ul', { className: 'kode-agent-rows' }, ...sources.map(source => {
          const presentation = sourcePresentation(source), packages = Array.isArray(source.packages) ? source.packages : []
          const needsSync = !source.updatedAt || (Array.isArray(source.syncedTargets) &&
            (source.syncedTargets.length !== source.targets.length || source.targets.some(target => !source.syncedTargets.includes(target))))
          const failed = Object.values(source.nativeStatus ?? {}).some(status => typeof status === 'string' && status.startsWith('failed:'))
          const mcpFailed = Object.keys(mcpErrors).some(key => key.startsWith(source.id + '\0'))
          const editing = Boolean(draft?.editing && draft.id === source.id)
          const meta = [
            packages.length > 1 ? `${packages.filter(pkg => pkg.enabled ?? true).length}/${packages.length} 个插件已启用` : null,
            source.targets.map(target => sourceTargetLabel(target, options)).join('、'),
            needsSync ? '待同步' : failed ? '原生插件同步失败' : mcpFailed ? 'MCP 登录失败' : null,
          ].filter(Boolean)
          return h('li', { className: 'kode-agent-row kode-source-card', key: source.id },
            h('div', { className: 'kode-agent-row-head' },
              h('button', { type: 'button', className: 'kode-source-summary', 'aria-label': '查看 ' + presentation.name + ' 详情', 'aria-haspopup': 'dialog', 'aria-expanded': previewId === source.id, onClick: () => openPreview(source.id) },
                h(SourceLogo, { source, host, name: presentation.name }),
                h('span', { className: 'kode-source-copy' },
                  h('span', { className: 'kode-agent-name' }, presentation.name),
                  h('span', { className: 'kode-source-description' }, presentation.description),
                  h('span', { className: 'kode-agent-version-line kode-source-meta' }, meta.join(' · ')))),
              h('div', { className: 'kode-agent-row-actions kode-source-actions' },
                h(Button, { size: 'sm', variant: 'outline', 'aria-label': `查看 ${presentation.name} 详情`, onClick: () => openPreview(source.id) }, '详情'),
                h(Button, { size: 'sm', variant: 'outline', disabled: busy || Boolean(draft && !editing), 'aria-label': `编辑 ${presentation.name}`, 'aria-expanded': editing,
                  onClick: () => editing ? setDraft(null) : edit(source) }, editing ? '收起' : '编辑'),
                h(Button, { size: 'sm', variant: 'outline', disabled: busy || Boolean(draft), 'aria-label': `更新并同步 ${presentation.name}`, onClick: () => void operate({ action: 'sync-source', id: source.id }) }, '同步'),
                h(Button, { size: 'sm', variant: 'outline', className: 'kode-source-remove', disabled: busy || Boolean(draft), 'aria-label': `移除 ${presentation.name}`,
                  onClick: () => void operate({ action: 'remove-source', id: source.id }).then(ok => { if (ok && previewId === source.id) setPreviewId(null) }) },
                '移除'))),
            h(Failure, { text: source.error }),
            editing && form)
        }))),
      data && agents && !sources.length && !draft && h('p', { className: 'kode-config-note' }, options.size
        ? '尚未添加来源。可添加 Git 仓库或本地目录。' : '此主机暂无可同步的 Agent。'),
      data && agents && !draft && !options.size && unavailable.length > 0 && h('p', { className: 'kode-config-note' }, targetHelp),
      data && agents && h(Button, { variant: 'outline', className: 'kode-agent-add', disabled: busy || Boolean(draft) || !options.size, onClick: add }, h(IconPlusOutlineRegular, { size: 16 }), '添加来源'),
      draft && !draft.editing && form,
      h(Modal, { open: Boolean(previewSource), title: previewSource ? sourcePresentation(previewSource).name : '插件详情', className: 'kode-source-dialog', closeLabel: '关闭', onClose: () => setPreviewId(null) },
        previewSource && h(Failure, { text: error }),
        previewSource && h(SourcePreview, {
          source: previewSource, packagePath: previewPackagePath, onPackageChange: setPreviewPackagePath, host, targetOptions: options,
          busy, packageToggle, onTogglePackage: togglePackage, onUpdateService: updateService,
          mcpProfiles: previewProfiles, mcpStatuses, mcpErrors, mcpPending,
          mcpHostName: hosts.find(row => row.id === host)?.name ?? host,
          onRefreshMcp: readMcpStatus, onRetryMcp: loginMcp,
        })))
  }
  function sourcePresentation(source) {
    const packages = Array.isArray(source.packages) ? source.packages : []
    if (packages.length === 1) return {
      name: packages[0].displayName || packages[0].name || source.id,
      description: packages[0].description || packages[0].longDescription || '查看插件包含的 Skills、Commands 和 MCP。',
    }
    if (packages.length > 1) return { name: source.id, description: `包含 ${packages.length} 个插件，点击查看详情。` }
    return { name: source.id, description: source.location || '点击查看来源详情。' }
  }
  function SourceLogo({ source, packageIndex = 0, host, name }) {
    const packages = Array.isArray(source.packages) ? source.packages : []
    const current = packages[packageIndex] ?? packages[0]
    const url = current?.logo ? '/api/kode/agent-hub?logo=' + encodeURIComponent(source.id) + '&package=' + packageIndex + '&v=' + encodeURIComponent(source.updatedAt ?? '') : null
    return h('span', { className: 'kode-source-avatar', 'aria-hidden': true },
      h('span', { className: 'kode-source-avatar-fallback' }, (name?.trim()[0] || 'P').toUpperCase()),
      url && h('img', { key: url, src: transport ? transport.path(url, host) : url, alt: '', loading: 'lazy', decoding: 'async', onLoad: event => { event.currentTarget.style.display = '' }, onError: event => { event.currentTarget.style.display = 'none' } }))
  }
  function SourcePreviewSection({ title, items, command = false, sync = false, empty }) {
    return h('section', { className: 'kode-source-preview-section' },
      h('h3', null, title, h('span', null, items.length)),
      items.length ? h('ul', { className: 'kode-source-preview-list' + (sync ? ' kode-source-sync-list' : '') }, ...items.map(item => h('li', { key: item.name },
        h('strong', null, sync && h(item.pending ? IconClockOutlineRegular : IconCheckOutlineRegular, { size: 14, className: 'kode-source-sync-icon' + (item.pending ? ' is-pending' : ''), 'aria-hidden': true }), command ? '/' + item.name : item.name),
        (item.description || item.type) && h('p', null, item.description || item.type))))
        : h('p', { className: 'kode-config-note' }, empty))
  }
  function McpList({ source, current, packageKey, host, mcpHostName, mcpProfiles = [], mcpStatuses = {}, mcpErrors = {}, mcpPending = {}, onRefreshMcp, onRetryMcp, empty }) {
    const declared = current.mcp ?? []
    const rowsFor = profile => packageKey ? (mcpStatuses[mcpStatusKey(source.id, profile.id)]?.rows ?? []).filter(row => row.packageKey === packageKey) : []
    const names = [...new Set([...declared.map(item => item.name), ...mcpProfiles.flatMap(({ profile }) => rowsFor(profile).map(row => row.name))])]
    const note = !names.length ? empty
      : !packageKey ? '更新 Kode 服务后可读取各 CLI 的实际授权状态。'
        : !mcpProfiles.length ? '将来源同步到可用 Agent 后读取各 CLI 的实际授权状态。' : null
    return h('section', { className: 'kode-source-preview-section kode-mcp-authorization' },
      h('h3', null, 'MCP', h('span', null, names.length)),
      note && h('p', { className: 'kode-config-note' }, note),
      names.length > 0 && h('ul', { className: 'kode-source-preview-list kode-mcp-list' }, ...names.map(name => {
        const spec = declared.find(item => item.name === name)
        return h('li', { key: name, className: 'kode-mcp-item' },
          h('div', { className: 'kode-mcp-item-head' }, h('strong', null, name), (spec?.description || spec?.type) && h('span', null, spec.description || spec.type)),
          packageKey && mcpProfiles.length > 0 && h('ul', { className: 'kode-mcp-cli-list' }, ...mcpProfiles.map(({ profile }) => {
            const statusKey = mcpStatusKey(source.id, profile.id), state = mcpStatuses[statusKey]
            const row = rowsFor(profile).find(item => item.name === name)
            if (!row) return h('li', { key: profile.id, className: 'kode-mcp-status-row', 'data-status': state?.error ? 'error' : 'unknown' },
              h('span', { className: 'kode-mcp-cli-name' }, profile.name),
              h('span', { className: 'kode-mcp-status-label', 'data-status': state?.error ? 'error' : 'unknown' }, state?.busy ? '读取中…' : state?.error ? '读取失败' : '未报告'),
              state?.error && h('span', { className: 'kode-mcp-status-detail' }, h(Failure, { text: state.error })),
              state?.error && h(Button, { size: 'sm', variant: 'outline', onClick: () => void onRefreshMcp(source, profile.id) }, '重试读取'))
            const rowKey = mcpRowKey(source.id, profile.id, row), failure = mcpErrors[rowKey], pending = mcpPending[rowKey]
            const manual = row.status === 'manual' || (host !== 'local' && row.status === 'login-required')
            const detail = failure || (row.status === 'login-required' && host === 'local' ? '下次同步或开启此插件时发起登录' : '')
            return h('li', { key: profile.id, className: 'kode-mcp-status-row', 'data-status': row.status ?? 'unknown' },
              h('span', { className: 'kode-mcp-cli-name' }, profile.name),
              h('span', { className: 'kode-mcp-status-label', 'data-status': row.status ?? 'unknown' }, MCP_STATUS_LABELS[row.status] ?? row.status ?? MCP_STATUS_LABELS.unknown),
              detail && h('span', { className: 'kode-mcp-status-detail', 'data-failed': Boolean(failure) }, detail),
              failure && host === 'local' && h(Button, { size: 'sm', variant: 'outline', disabled: pending, onClick: () => void onRetryMcp(source, profile.id, row) }, pending ? '登录中…' : '重试登录'),
              manual && h('details', { className: 'kode-mcp-manual' },
                h('summary', null, '手动配置'),
                h('p', null, `请在 ${mcpHostName ?? host} 的 ${profile.name} 配置中完成 ${row.name} 授权。${host !== 'local' ? '浏览器不会跨主机自动登录。' : ''}`),
                h(Button, { size: 'sm', variant: 'outline', onClick: () => void onRefreshMcp(source, profile.id) }, '刷新状态')))
          })))
      })))
  }
  function SourcePreview({ source, packagePath, onPackageChange, host, targetOptions, busy = false, packageToggle = false, onTogglePackage = () => {}, onUpdateService = () => {}, ...mcp }) {
    const packages = Array.isArray(source.packages) ? source.packages : []
    const selectedIndex = Math.max(0, packages.findIndex(row => row.path === packagePath))
    const current = packages[selectedIndex] ?? {
      name: source.id, displayName: source.id,
      skills: (source.skills ?? []).map(name => ({ name })), agents: [], commands: [], mcp: [],
    }
    const keyOf = pkg => sourcePackageKey(pkg, packageToggle)
    const sync = (source.targets ?? []).map(target => {
      const status = source.nativeStatus?.[target]
      const failed = status?.startsWith('failed:')
      return { name: sourceTargetLabel(target, targetOptions), pending: !status || failed,
        description: failed ? '原生插件安装失败，可重新更新并同步' : ({ ready: '已同步，下次启动会话时加载', installed: '已安装并完成同步', 'skills-only': 'Skills 已同步' }[status] ?? '等待更新并同步') }
    })
    const about = [
      ['版本', current.version], ['作者', current.author], ['分类', current.category],
      ['来源标识', source.id], ['来源类型', source.kind === 'git' ? '远程 Git' : '本地目录'],
      ['来源位置', source.location], ['子目录', source.subdir], ['同步目标', (source.targets ?? []).join('、')],
      ['Revision', source.revision], ['更新时间', Number.isFinite(source.updatedAt) ? new Date(source.updatedAt).toLocaleString() : '尚未同步'],
    ].filter(([, value]) => value !== null && value !== undefined && value !== '')
    const empty = source.updatedAt ? '此插件未声明可用内容。' : '更新并同步后可查看完整详情。'
    const contents = [
      { title: 'Skills', items: current.skills ?? [] }, { title: 'Subagents', items: current.agents ?? [] },
      { title: 'Hooks', items: current.hooks ?? [] }, { title: 'Commands', items: current.commands ?? [], command: true },
      { title: 'Rules', items: current.rules ?? [] },
    ]
    const undeclared = [...contents.filter(row => !row.items.length).map(row => row.title), ...((current.mcp ?? []).length ? [] : ['MCP'])]
    return h('div', { className: 'kode-source-preview', 'data-layout': packages.length > 1 ? 'split' : 'single' },
      packages.length > 0 && h('section', { className: 'kode-source-preview-section kode-package-inventory' },
        h('h3', null, '插件', h('span', null, packages.length)),
        packages.some(pkg => !keyOf(pkg)) && h('div', { className: 'kode-package-sync-note', role: 'status' },
          h('span', { className: 'kode-config-note' }, '此主机的 Kode 服务版本较旧，暂不支持逐项启停插件。'),
          h(Button, { size: 'sm', variant: 'outline', onClick: onUpdateService }, '更新 Kode 服务')),
        h('ul', { className: 'kode-package-list' }, ...packages.map((pkg, index) => {
          const name = pkg.displayName || pkg.name || pkg.path || pkg.key, enabled = pkg.enabled ?? true, key = keyOf(pkg)
          return h('li', { key: pkg.path ?? pkg.key ?? index, className: 'kode-package-item', 'data-selected': index === selectedIndex ? 'true' : 'false', 'data-enabled': enabled ? 'true' : 'false' },
            h('button', { type: 'button', className: 'kode-package-select', 'aria-pressed': index === selectedIndex, onClick: () => onPackageChange(pkg.path) },
              h('strong', null, name),
              (pkg.description || pkg.path) && h('span', null, pkg.description || pkg.path)),
            h('label', { className: 'kode-package-toggle' },
              h('span', null, key ? (enabled ? '已启用' : '已停用') : '需更新服务'),
              h('input', { type: 'checkbox', role: 'switch', checked: enabled, disabled: busy || !key,
                'aria-label': `${enabled ? '停用' : '启用'} ${name}`, title: key ? undefined : '更新此主机的 Kode 服务后可启停',
                onChange: event => onTogglePackage(source, pkg, event.target.checked) })))
        }))),
      h('div', { className: 'kode-source-preview-detail' },
        h('div', { className: 'kode-source-preview-header' },
          h(SourceLogo, { source, packageIndex: selectedIndex, host, name: current.displayName || current.name }),
          h('div', null, h('strong', null, current.displayName || current.name || source.id),
            (current.longDescription || current.description) && h('p', null, current.longDescription || current.description))),
        ...contents.filter(row => row.items.length).map(row => h(SourcePreviewSection, { key: row.title, ...row, empty })),
        (current.mcp ?? []).length > 0 && h(McpList, { source, current, packageKey: keyOf(current), host, empty, ...mcp }),
        undeclared.length > 0 && h('p', { className: 'kode-config-note kode-source-undeclared' },
          undeclared.length === contents.length + 1 ? empty : `未声明 ${undeclared.join('、')}。`),
        h(SourcePreviewSection, { title: 'Agent 同步（来源）', items: sync, sync: true, empty: '尚未选择同步 Agent。' }),
        h('section', { className: 'kode-source-preview-section kode-source-about' }, h('h3', null, '关于'),
          h('dl', null, ...about.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))))))
  }
