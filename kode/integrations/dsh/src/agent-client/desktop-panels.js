  const PANEL_GLYPH = 'M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z'
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
  function HandoffDialog({ sessionId, sessions, host, close }) {
    const { data, error: directoryError } = useDirectory(sessionId, sessions, host)
    const [target, setTarget] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const requestId = useRef(null)
    const current = data?.currentProfile?.id ?? data?.selectedProfileId
    const profiles = (data?.profiles ?? []).filter(profile => profile.id !== current && data?.supportedTypes?.includes(profile.type))
    return h(Modal, { open: true, title: '用其他 Agent 继续', className: 'kode-handoff-dialog', closeLabel: '关闭', onClose: () => { if (!busy) close() },
        description: '当前 Agent 会用交接技能整理目标、进度和待办，目标 Agent 将在同一工作区根据交接稿继续。',
        footer: h(React.Fragment, null, h(Button, { variant: 'outline', disabled: busy, onClick: close }, '取消'), h(Button, { disabled: busy || !target, variant: 'primary', onClick: async () => {
          setBusy(true); setError('')
          try {
            requestId.current ??= crypto.randomUUID()
            const result = await hubCall({ action: 'handoff-skill', sessionId, profileId: target, requestId: requestId.current }, host)
            if ((transport?.current ?? 'local') !== host) throw new Error('交接已完成，请切回原主机查看目标会话。')
            await sessions.refresh(); showShared(null); await avatarContext.get('uiWorkspace').openSession(result.sessionId); close()
          } catch (error) { setError(error.message) } finally { setBusy(false) }
        } }, busy ? h(React.Fragment, null, h(StateDot, { state: 'ongoing', size: 16, className: 'kode-status-dot' }), '正在交接…') : '开始交接')) },
        h('div', { className: 'kode-handoff-body', 'aria-busy': busy },
          h(SelectField, { label: '目标 Agent', value: target, disabled: busy || !profiles.length, options: [{ value: '', label: profiles.length ? '选择 Agent' : data ? '暂无可交接的 Agent' : '正在读取 Agent…' }, ...profiles.map(profile => ({ value: profile.id, label: profile.name }))], onChange: value => { setTarget(value); requestId.current = null } }),
          h(Failure, { text: error || directoryError })))
  }
