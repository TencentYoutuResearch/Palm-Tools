  function AdvancedSection({ title, open, children }) {
    const [expanded, setExpanded] = useState(Boolean(open))
    const [panelId] = useState(() => `kode-advanced-${Math.random().toString(36).slice(2)}`)
    return h('section', { className: 'kode-disclosure', 'data-open': expanded },
      h('button', { type: 'button', className: 'kode-disclosure-toggle', 'aria-expanded': expanded, 'aria-controls': panelId, onClick: () => setExpanded(value => !value) }, h('span', null, title), h(IconChevronDownOutlineRegular, { size: 16, className: 'kode-disclosure-chevron', 'aria-hidden': true })),
      h('div', { className: 'kode-disclosure-panel', id: panelId, 'aria-hidden': !expanded, inert: expanded ? undefined : '' }, h('div', { className: 'kode-disclosure-clip' }, h('div', { className: 'kode-disclosure-content' }, children))))
  }
  function LineGlyph({ kind = 'command', size = 16, ...props }) {
    const paths = { command: 'm4 6 5 6-5 6m8 0h8', skill: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5', model: 'M5 5h14v14H5zM9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3', info: 'M12 11v6m0-10h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', compact: 'M4 9h16M4 15h16m-8-9V2m0 20v-4m-3-1 3-3 3 3M9 7l3 3 3-3', permission: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6' }
    return h('svg', { ...props, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: paths[kind] ?? paths.command }))
  }
  const CommandGlyph = props => h(LineGlyph, { ...props, kind: 'command' }), SkillGlyph = props => h(LineGlyph, { ...props, kind: 'skill' })
  const ModelGlyph = props => h(LineGlyph, { ...props, kind: 'model' }), InfoGlyph = props => h(LineGlyph, { ...props, kind: 'info' }), CompactGlyph = props => h(LineGlyph, { ...props, kind: 'compact' }), PermissionGlyph = props => h(LineGlyph, { ...props, kind: 'permission' })
  function Trigger({ label, open, onClick, disabled, agent = false, model = false, profile }) {
    return h('button', { type: 'button', className: `kode-trigger${agent ? ' kode-agent-trigger' : ''}`, 'aria-label': agent ? `Agent：${label}` : `模型：${label}`, 'aria-haspopup': open === undefined ? undefined : 'menu', 'aria-expanded': open, disabled, onClick },
      agent && h(AgentAvatar, { profile, size: 18 }), model && h(ModelGlyph, { size: 14 }), h('span', null, label), open !== undefined && h(IconChevronDownOutlineRegular, { size: 12, className: open ? 'kode-chevron-open' : '' }))
  }
  function Failure({ text }) { return text ? h('p', { className: 'kode-error', role: 'alert' }, text) : null }
  function SelectField({ label, labelHeading = false, showLabel = true, value, options, onChange, disabled = false }) {
    const [open, setOpen] = useState(false)
    return h('div', { className: 'kode-field' }, showLabel && h(labelHeading ? 'h3' : 'span', labelHeading ? { className: 'kode-settings-group-title' } : null, label), h(Menu, {
      open, onClose: () => setOpen(false), portal: true, selectedId: value,
      items: options.map(option => ({ id: option.value, label: option.label })),
      onSelect: id => { setOpen(false); onChange(id) },
      anchor: h('button', { type: 'button', className: 'kode-field-select', disabled, 'aria-label': label, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(!open) }, h('span', null, options.find(option => option.value === value)?.label ?? value), h(IconChevronDownOutlineRegular, { size: 14 })),
    }))
  }
  function FastSwitch({ checked, disabled = false, onChange, label = 'Fast' }) {
    return h('button', { type: 'button', role: 'switch', 'aria-checked': Boolean(checked), 'aria-label': label, className: 'kode-fast-switch', disabled, onClick: event => { event.preventDefault(); event.stopPropagation(); onChange(!checked) }, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() } }, h('span', { className: 'kode-fast-switch-thumb', 'aria-hidden': true }))
  }
  function DshModeControl({ id, sessions, remote, canChange }) {
    const listed = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
    const [roster, setRoster] = useState([]), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
    useEffect(() => { let alive = true; remote.agentPresets.list().then(result => { if (!alive) return; if (result.ok) setRoster(result.value.presets); else setError(result.error.message) }, error => { if (alive) setError(error.message) }); return () => { alive = false } }, [remote])
    const names = { standard: '标准模式', minimal: '极简模式', ptc: 'PTC 模式', cordis: '插件开发模式' }
    const recorded = listed.byId[id]?.projectionValues?.agentPreset
    const current = recorded && recorded !== 'kode-native' ? recorded : roster.find(p => p.id === 'standard')?.id
    const label = p => p?.name ?? names[p?.id] ?? p?.id ?? '选择模式'
    return h('span', { className: 'kode-mode-control' }, h(Menu, { open, onClose: () => setOpen(false), portal: true, selectedId: current,
      items: roster.filter(p => p.id !== 'kode-native').map(p => ({ id: p.id, label: label(p), disabled: Boolean(p.broken) || !canChange || busy })),
      footer: !canChange ? [{ id: 'mode-selection-note', disabled: true, label: '当前会话已开始，新建会话后可切换模式' }] : undefined,
      onSelect: preset => { setOpen(false); setBusy(true); setError(''); remote.agentPresets.select(id, preset).then(result => { if (!result.ok) setError(result.error.message) }, error => setError(error.message)).finally(() => setBusy(false)) },
      anchor: h('button', { type: 'button', className: 'kode-trigger', disabled: !id || !roster.length || busy, 'aria-label': `dsh 模式：${label(roster.find(p => p.id === current))}`, 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(!open) }, h('span', { className: 'kode-control-label' }, label(roster.find(p => p.id === current))), h(IconChevronDownOutlineRegular, { size: 12 })),
    }), h(Failure, { text: error }))
  }
  const newDraft = types => ({ name: '', type: 'codex', executable: types?.codex.executable ?? 'codex', argsText: '[]', envText: '{}' })
  // Kode owns a native main panel; unrelated native sections still use the settings shell.
  function openSettings(slots, section = 'kode-agents') {
    if (section.startsWith('kode-')) {
      if (!openKodeSettings) throw new Error('Kode 设置面板尚未就绪，请稍后重试。')
      openKodeSettings(section.slice(5))
      return
    }
    const shell = slots.entries('sidebar.settings').find(entry => entry.store?.create)
    const actions = shell?.store.create().actions
    if (!actions?.openSection) throw new Error('设置尚未就绪，请稍后重试。')
    actions.openSection(section)
  }
  let requestedProfile, requestedServiceHost, requestedSettingsSection, openKodeSettings, closeKodePanel, openBotsPage, openBotChat, openMemoryPage, requestedBotStart, requestedBotWatches, requestedBotEdit, requestedBotProfile, requestedBotConnectors, requestedBotTasks
  function AgentControl({ sessionId, sessions, remote, slots }) {
    const { data, busy, error, store, id } = useDirectory(sessionId, sessions)
    const [open, setOpen] = useState(false), [navigationError, setNavigationError] = useState('')
    useEffect(() => setOpen(false), [id])
    const current = data?.currentProfile ?? data?.profiles.find(p => p.id === data.selectedProfileId)
    const rows = data?.profiles ?? [], firstCustom = rows.findIndex(profile => profile.origin !== 'builtin')
    const items = rows.flatMap((p, index) => [...(index === firstCustom && index > 0 ? [{ type: 'separator' }] : []), { id: p.id, disabled: busy || !id || (!data.canChangeAgent && p.id !== current?.id) || !data.supportedTypes.includes(p.type), label: h('span', { className: 'kode-agent-option' }, h(AgentAvatar, { profile: p }), h('span', { className: 'kode-option' }, h('span', null, p.name), p.origin !== 'builtin' && h('span', { className: 'kode-secondary' }, data.types[p.type]?.name))) }])
    items.push({ type: 'separator' }, { id: 'configure', label: '自定义 Agent…' })
    return h(React.Fragment, null,
      h(Menu, { open, onClose: () => setOpen(false), selectedId: current?.id, items, side: 'bottom', portal: true,
        footer: !data?.canChangeAgent && current ? [{ id: 'agent-selection-note', disabled: true, label: '新建会话后可切换 Agent' }] : undefined,
        onSelect: profileId => { setOpen(false); if (profileId === 'configure') { requestedProfile = current?.origin !== 'builtin' ? current?.id : undefined; try { openSettings(slots) } catch (e) { setNavigationError(e.message) } } else void store.operate({ action: 'select', profileId, sessionId: id }).catch(() => {}) },
        anchor: h(Trigger, { agent: true, profile: current, label: current?.name ?? (error ? '重试加载 Agent' : '正在加载 Agent…'), open: data ? open : undefined, disabled: busy || (!data && !error), onClick: () => data ? setOpen(!open) : void store.load() }),
      }),
      current?.type === 'dsh' && h(DshModeControl, { id, sessions, remote, canChange: data.canChangeAgent }),
      h(Failure, { text: navigationError || error }),
    )
  }
