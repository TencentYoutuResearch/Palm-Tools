  const PANEL_GLYPH = 'M1.75 1.75h5.25v5.25H1.75zM9 1.75h5.25v5.25H9zM1.75 9h5.25v5.25H1.75zM9 9h5.25v5.25H9z'
  // A Kode extension panel (team channels, …). Kode draws the panel's own
  // page over this area; dsh only lends the space and reports where it is.
  function KodePanelPage({ panel }) {
    const area = useRef(null)
    useEffect(() => {
      const node = area.current
      let frame = 0, last = ''
      const report = () => {
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => {
          const box = node.getBoundingClientRect()
          const rect = { x: box.left, y: box.top, width: box.width, height: box.height }
          const key = JSON.stringify(rect)
          if (key === last) return
          last = key
          window.kodeHost.request('panel-show', { extension: panel.extension, panel: panel.id, rect })
        })
      }
      report()
      const observer = new ResizeObserver(report)
      observer.observe(node)
      window.addEventListener('resize', report)
      return () => {
        cancelAnimationFrame(frame)
        observer.disconnect()
        window.removeEventListener('resize', report)
        window.kodeHost.request('panel-hide', { extension: panel.extension, panel: panel.id })
      }
    }, [panel.extension, panel.id])
    return h('div', { ref: area, className: 'kode-panel-host', 'aria-label': panel.title })
  }
  function KodeLeavePage({ layout }) {
    useEffect(() => {
      window.kodeHost.request('leave')
      const timer = setTimeout(() => layout?.selectPanel(null), 600)
      return () => clearTimeout(timer)
    }, [])
    return h('div', { className: 'kode-leave-page' }, '正在返回 Kode…')
  }
  function HandoffAction({ sessionId, sessions, panel, dismissOverlay }) {
    if (catalogBlank(sessions, sessionId)) return null
    const open = () => {
      dismissOverlay?.()
      window.dispatchEvent(new CustomEvent('kode-handoff-dialog', { detail: { sessionId, host: transport?.current ?? 'local' } }))
    }
    const icon = h(IconPaperPlaneOutlineRegular, { size: 16, 'aria-hidden': true })
    return panel ? h(Button, { className: 'kode-environment-handoff', variant: 'ghost', size: 'sm', 'aria-label': '交接会话到其他 Agent', title: '交接会话', onClick: open }, icon, h('span', { className: 'kode-environment-handoff-label' }, '交接')) :
      h(Button, { variant: 'outline', className: 'kode-handoff-trigger', 'aria-label': '交接会话到其他 Agent', title: '交接会话', onClick: open }, icon, '交接')
  }
  function HandoffOverlay({ sessions }) {
    const [request, setRequest] = useState(null)
    useEffect(() => {
      const show = event => setRequest(event.detail)
      window.addEventListener('kode-handoff-dialog', show)
      return () => window.removeEventListener('kode-handoff-dialog', show)
    }, [])
    return request && h(HandoffDialog, { key: `${request.host}:${request.sessionId}`, ...request, sessions, close: () => setRequest(null) })
  }
  // The target Agent's own configuration store lists the models it publishes and its default selection.
  // Model and effort start from that default; a choice survives only while the target still offers it.
  function handoffModelChoice(data, picked = {}) {
    const models = data?.models ?? [], fallback = data?.defaultModelSelection
    const model = models.find(row => row.id === picked.model) ?? models.find(row => row.id === fallback?.model) ?? models[0]
    const efforts = model?.reasoningEfforts ?? []
    const effortIds = efforts.map(row => row.id)
    const inherited = model?.id === fallback?.model ? fallback?.reasoningEffort : undefined
    const effort = [picked.model === model?.id ? picked.reasoningEffort : undefined, inherited, model?.defaultReasoningEffort].find(id => id && effortIds.includes(id))
    return { models, model, efforts, effort }
  }
  function HandoffDialog({ sessionId, sessions, host, close }) {
    const { data, error: directoryError } = useDirectory(sessionId, sessions, host)
    const [target, setTarget] = useState(''), [picked, setPicked] = useState({}), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const requestId = useRef(null)
    const current = data?.currentProfile?.id ?? data?.selectedProfileId
    const profiles = (data?.profiles ?? []).filter(profile => profile.id !== current && data?.supportedTypes?.includes(profile.type))
    const store = target ? directory(undefined, host, true, target) : null
    const empty = React.useMemo(() => ({ data: undefined, busy: false, error: '' }), [])
    const subscribe = React.useCallback(fn => store?.subscribe(fn) ?? (() => {}), [store])
    const targetState = useSyncExternalStore(subscribe, () => store?.getSnapshot() ?? empty)
    useEffect(() => { if (store) void store.load() }, [store])
    // The store is keyed by profile, but a fast switch can still render the previous target for a frame.
    const targetData = targetState.data && (targetState.data.selectedProfileId ?? target) === target ? targetState.data : undefined
    const { models, model, efforts, effort } = handoffModelChoice(targetData, picked)
    const loadingModels = Boolean(target && !targetData && !targetState.error)
    const choose = patch => { setPicked(previous => ({ ...previous, ...patch })); requestId.current = null }
    const submit = async () => {
      setBusy(true); setError('')
      const onScreen = transport?.current ?? 'local'
      try {
        requestId.current ??= crypto.randomUUID()
        const result = await hubCall({ action: 'handoff-skill', sessionId, profileId: target, requestId: requestId.current,
          ...(model ? { model: model.id } : {}), ...(model && effort ? { reasoningEffort: effort } : {}) }, host)
        // If the person moved to another host while the handoff ran, leave them there.
        if ((transport?.current ?? 'local') !== onScreen) throw new Error('交接已完成，请切回原主机查看目标会话。')
        // Otherwise open the target on the host that ran the handoff through the transport's cold-session
        // navigation chain, which reconnects when needed and admits sessions the local catalog has not seen.
        showShared(null)
        if (transport) await switchHost(host, { sessionId: result.sessionId })
        else { await sessions.refresh(); await avatarContext.get('uiWorkspace').openSession(result.sessionId) }
        close()
      } catch (error) { setError(error.message) } finally { setBusy(false) }
    }
    return h(Modal, { open: true, title: '用其他 Agent 继续', className: 'kode-handoff-dialog', closeLabel: '关闭', onClose: () => { if (!busy) close() },
        description: '当前 Agent 会用交接技能整理目标、进度和待办，目标 Agent 将在同一工作区根据交接稿继续。',
        footer: h(React.Fragment, null, h(Button, { variant: 'outline', disabled: busy, onClick: close }, '取消'),
          h(Button, { disabled: busy || !target || loadingModels, variant: 'primary', onClick: () => void submit() },
            busy ? h(React.Fragment, null, h(StateDot, { state: 'ongoing', size: 16, className: 'kode-status-dot' }), '正在交接…') : '开始交接')) },
        h('div', { className: 'kode-handoff-body', 'aria-busy': busy },
          h(SelectField, { label: '目标 Agent', value: target, disabled: busy || !profiles.length, options: [{ value: '', label: profiles.length ? '选择 Agent' : data ? '暂无可交接的 Agent' : '正在读取 Agent…' }, ...profiles.map(profile => ({ value: profile.id, label: profile.name }))],
            onChange: value => { if (value === target) return; setTarget(value); setPicked({}); requestId.current = null } }),
          target && (loadingModels
            ? h('p', { className: 'kode-config-note', role: 'status' }, '正在读取此 Agent 的模型…')
            : models.length > 0 && h('div', { className: 'kode-handoff-model' },
              h(SelectField, { label: '模型', value: model?.id ?? '', disabled: busy, options: models.map(row => ({ value: row.id, label: (row.name ?? row.id) + (row.id === targetData?.defaultModelSelection?.model ? '（默认）' : '') })),
                onChange: id => choose({ model: id, reasoningEffort: undefined }) }),
              efforts.length > 0 && h(SelectField, { label: '推理强度', value: effort ?? '', disabled: busy || efforts.length < 2, options: efforts.map(row => ({ value: row.id, label: row.name ?? row.id })),
                onChange: id => choose({ model: model.id, reasoningEffort: id }) }))),
          target && !loadingModels && !models.length && !targetState.error && h('p', { className: 'kode-config-note' }, '此 Agent 未公布可选模型，将使用它的默认模型。'),
          h(Failure, { text: error || directoryError || (target && (targetState.error || targetData?.modelError)) })))
  }
