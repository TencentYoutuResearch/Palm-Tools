  function AvatarChoices({ profile, host, sessionId, onChoose, onGenerated, onCancel, canApply = true }) {
    const library = useAvatarLibrary(), avatars = library.loaded ? library.avatars : null
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [background, setBackground] = useBackgroundPreference()
    const [selectedId, setSelectedId] = useState(profile.avatar?.id ?? null), [display, setDisplay] = useState(background)
    const [renaming, setRenaming] = useState(false), [nameDraft, setNameDraft] = useState('')
    const [clip, setClip] = useState(null), [failedVideo, setFailedVideo] = useState(null), picker = useRef(null)
    useEffect(() => { void loadAvatars(true) }, [])
    useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url) }, [clip])
    const apply = async () => {
      if (busy || clipFailed) return
      setBusy(true); setError('')
      try {
        if (clip && selected) {
          const response = await fetchHost(`/api/kode/avatars/background?avatar=${encodeURIComponent(selected.id)}`, {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'video/mp4' }, body: clip.file,
          }, 'local')
          if (!response.ok) throw new Error((await parseHostJson(response)).error ?? '无法保存背景视频。')
          await loadAvatars(true)
          setClip(null)
        }
        await onChoose(selected?.id ?? selectedId)
        setBackground(display)
      } catch (error) { setError(error.message) } finally { setBusy(false) }
    }
    const generate = async backgroundOnly => { setBusy(true); setError(''); try { await stageAvatarPrompt(sessionId, host, backgroundOnly, selected?.id ?? selectedId); onGenerated?.() } catch (error) { setError(error.message) } finally { setBusy(false) } }
    const local = (host ?? transport?.current ?? 'local') === 'local' && (transport?.current ?? 'local') === 'local'
    const selected = avatars?.find(row => row.id === selectedId || row.aliases?.includes(selectedId)), previewProfile = { ...profile, avatar: selected ?? (selectedId === profile.avatar?.id ? profile.avatar : null) }
    const still = localArtworkUrl(selected?.background)
    const video = clip?.url ?? localArtworkUrl(selected?.backgroundVideo)
    const mode = display === 'motion' && !video ? 'still' : display
    const clipFailed = Boolean(clip && failedVideo === clip.url)
    const previewVideo = mode !== 'off' && video && (mode === 'motion' || !still) && failedVideo !== video
    const previewStill = mode !== 'off' && still
    const select = id => {
      if (selectedId !== id) { setClip(null); setFailedVideo(null) }
      setSelectedId(id); setRenaming(false); setError('')
    }
    const selectClip = event => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (!file || !selected) return
      if (!/\.mp4$/i.test(file.name) || file.size === 0 || file.size > 100 * 1024 * 1024) {
        setError('请选择 100 MB 以内的 MP4 视频。')
        return
      }
      setClip({ file, url: URL.createObjectURL(file) }); setFailedVideo(null); setDisplay('motion'); setError('')
    }
    const reportClipFailure = () => {
      setFailedVideo(video)
      setError('背景视频无法播放，请使用 H.264 编码的 MP4。')
    }
    const renameSelected = async event => {
      event.preventDefault(); if (busy || !selected) return
      setBusy(true); setError('')
      try {
        const response = await fetchHost('/api/kode/avatars/rename', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ avatarId: selected.id, name: nameDraft }) }, 'local')
        const value = await parseHostJson(response); if (!response.ok) throw new Error(value.error ?? '重命名失败，请重试。')
        setSelectedId(value.id); setRenaming(false); await loadAvatars(true); await refreshWorkspaceDirectory()
        for (const entry of stores.values()) void entry.load()
      } catch (error) { setError(error.message) } finally { setBusy(false) }
    }
    return h('div', { className: 'kode-avatar-editor' },
      h('div', { className: 'kode-avatar-content' },
        h('div', { className: 'kode-avatar-preview-identity' }, h(AgentAvatar, { profile: previewProfile, host, size: 48, preview: true }), renaming ? h('form', { className: 'kode-avatar-rename', onSubmit: event => void renameSelected(event) }, h('input', { autoFocus: true, required: true, maxLength: 80, 'aria-label': '头像名称', value: nameDraft, disabled: busy, onChange: event => setNameDraft(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(false) } } }), h(Button, { type: 'submit', size: 'sm', variant: 'outline', disabled: busy || !nameDraft.trim() }, '保存'), h(Button, { type: 'button', size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setRenaming(false) }, '取消')) : h('span', { className: 'kode-avatar-preview-name' }, h('span', null, selected?.name ?? '默认图标'), selected && library.canRename && h('button', { type: 'button', className: 'kode-avatar-name-edit', 'aria-label': '重命名头像', title: '重命名头像文件夹', disabled: busy, onClick: () => { setNameDraft(selected.name); setRenaming(true) } }, h(IconEditOutlineRegular, { size: 14 })))),
        h('div', { className: 'kode-avatar-preview', role: 'img', 'aria-label': `${selected?.name ?? '默认图标'}的背景预览`, 'data-has-background': Boolean(previewVideo || previewStill) },
          previewVideo ? h(BackgroundVideo, { key: video, src: video, poster: still, animate: mode === 'motion', onFailure: reportClipFailure })
            : previewStill ? h('img', { src: still, alt: '', 'aria-hidden': true })
              : h('span', null, mode === 'off' ? '背景显示已关闭' : '此头像暂无配套背景')),
        h('div', { className: 'kode-background-controls' },
          h('div', { className: 'kode-background-mode', role: 'group', 'aria-label': '背景显示模式' },
            ...[['off', '关闭'], ['still', '静态'], ['motion', '动态']].map(([id, label]) =>
              h('button', { key: id, type: 'button', 'aria-pressed': mode === id, disabled: busy || (id === 'motion' && !video), onClick: () => setDisplay(id) }, label))),
          selected && h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => picker.current?.click(), title: 'H.264 MP4，最大 100 MB' }, video ? '替换视频' : '导入视频'),
          h('input', { ref: picker, type: 'file', hidden: true, accept: 'video/mp4,.mp4', onChange: selectClip })),
        clip && h('p', { className: 'kode-config-note kode-background-filename', title: clip.file.name }, clip.file.name),
        h('div', { className: 'kode-avatar-grid', 'aria-label': '会话头像' },
          h('button', { type: 'button', className: 'kode-avatar-choice', 'aria-pressed': !selectedId, disabled: busy, onClick: () => select(null) }, h(AgentAvatar, { profile: { ...profile, avatar: null }, host, size: 36 }), h('span', { className: 'kode-avatar-caption' }, '默认图标')),
          ...(avatars ?? []).map(avatar => h('button', { type: 'button', key: avatar.id, className: 'kode-avatar-choice', 'aria-pressed': selected?.id === avatar.id, disabled: busy, title: avatar.name, onClick: () => select(avatar.id) }, h(AgentAvatar, { profile: { ...profile, avatar }, host, size: 36, preview: true }), h('span', { className: 'kode-avatar-caption' }, h('span', null, avatar.name), (avatar.background || avatar.backgroundVideo) && h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, role: 'img', 'aria-label': '有配套背景' }, h('title', null, '有配套背景'), h('rect', { x: 1.5, y: 2, width: 13, height: 12, rx: 2 }), h('path', { d: 'm2 11 3.5-3.5L9 11l2-2 3 3M10 5.5h.01', strokeLinecap: 'round', strokeLinejoin: 'round' })))))),
        !avatars && !error && h('p', { className: 'kode-config-note', role: 'status' }, '正在读取头像…'),
        avatars?.length === 0 && h('p', { className: 'kode-config-note' }, '还没有自定义头像，可创建头像与背景。'),
        h('div', { className: 'kode-avatar-actions' }, h(Button, { variant: 'outline', disabled: busy || !local, onClick: () => void generate(false) }, h(IconPlusOutlineRegular, { size: 16 }), '创建头像与背景'), selected && h(Button, { variant: 'ghost', disabled: busy || !local, onClick: () => void generate(true) }, '生成背景'), h(Button, { variant: 'ghost', disabled: busy, onClick: () => void loadAvatars(true) }, '刷新')),
        !local && h('p', { className: 'kode-config-note' }, '生成素材请先切换到此计算机上的会话；SSH 会话也可使用此处的头像与背景。'),
        h(Failure, { text: error || library.error })),
      h('div', { className: 'kode-avatar-footer' }, h(Button, { variant: 'outline', disabled: busy, onClick: onCancel }, '取消'), h(Button, { variant: 'primary', disabled: busy || clipFailed || !canApply || !library.loaded || Boolean(library.error), onClick: () => void apply() }, busy ? '应用中…' : '确认应用')))
  }
  function openAvatarDialog(target) {
    window.dispatchEvent(new CustomEvent('kode-avatar-dialog', { detail: target }))
  }
  async function saveAvatarChoice(target, avatarId) {
    if (target.sessionId) await projectCall({ action: 'host-operation', id: target.host, operation: 'session-avatar', args: { sessionId: target.sessionId, avatarId } })
    else await call({ action: 'agent-avatar', profileId: target.profile.id, avatarId }, undefined, false, target.host)
    await refreshWorkspaceDirectory()
    for (const entry of stores.values()) void entry.load()
  }
  function AvatarDialog() {
    const [target, setTarget] = useState(null)
    useEffect(() => { const show = event => setTarget(event.detail); window.addEventListener('kode-avatar-dialog', show); return () => window.removeEventListener('kode-avatar-dialog', show) }, [])
    const close = () => setTarget(null)
    return h(Modal, { open: Boolean(target), title: target?.sessionId ? '会话头像与背景' : `${target?.profile?.name ?? 'Agent'} 默认外观`, className: 'kode-avatar-dialog', closeLabel: '关闭', onClose: close }, target && h(AvatarChoices, { key: `${target.host}:${target.sessionId ?? target.profile.id}`, profile: target.profile, sessionId: target.sessionId, host: target.host, onChoose: async avatarId => { await saveAvatarChoice(target, avatarId); close() }, onCancel: close, onGenerated: close }))
  }
  function EditableAgentAvatar({ profile, host }) {
    return h('span', { className: 'kode-editable-avatar' }, h(AgentAvatar, { profile, host, size: 24 }), h('span', { className: 'kode-avatar-edit-mark', 'aria-hidden': true }, h(IconEditOutlineRegular, { size: 8 })))
  }
  function PersonalizationSettings({ sessions, close }) {
    const directoryState = useWorkspaceDirectory(), catalog = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot)
    const current = Object.values(catalog.byId).find(row => (row.retainedBy?.mainView ?? 0) > 0), host = directoryState.current
    const row = directoryState.hosts.find(row => row.id === host)?.sessions?.find(row => row.id === current?.id)
    const store = directory(current?.id, host), state = useSyncExternalStore(store.subscribe, store.getSnapshot)
    const profile = row?.agent ?? state.data?.currentProfile
    const [revision, setRevision] = useState(0), [notice, setNotice] = useState('')
    useEffect(() => { if (current?.id) void store.load() }, [store, current?.id])
    const target = { sessionId: current?.id, host, profile }
    return h('section', { className: 'kode-agent-settings kode-personalization', 'aria-label': '个性化' },
      !current && h('p', { className: 'kode-config-note' }, '打开会话后即可应用头像与背景。'),
      profile && h('div', { className: 'kode-personalization-session' },
        h('span', { className: 'kode-personalization-session-label' }, '当前会话'),
        h('strong', null, current?.title || row?.title || '未命名会话')),
      h(Failure, { text: state.error }), notice && h('p', { className: 'kode-config-note', role: 'status' }, notice),
      (!current || profile) && h(AvatarChoices, { key: `${current?.id}:${revision}`, profile: profile ?? { type: 'dsh', name: 'DeepSeek Harness' }, sessionId: current?.id, host, canApply: Boolean(current?.id && profile), onChoose: async avatarId => { await saveAvatarChoice(target, avatarId); setNotice('已应用头像与背景') }, onCancel: () => { setRevision(value => value + 1); setNotice('') }, onGenerated: close }))
  }
  function AgentIdentity({ sessionId, sessions, useSessionStatus, panel, dismissOverlay }) {
    const { data } = useDirectory(sessionId, sessions), status = useAvatarStatus(sessionId, useSessionStatus)
    const workspaceDirectory = useWorkspaceDirectory(), currentSession = workspaceDirectory.hosts.find(host => host.id === workspaceDirectory.current)?.sessions?.find(row => row.id === sessionId)
    const host = workspaceDirectory.current
    const roster = useBotsData(), bot = host === 'local' ? botOfSession(roster, sessionId) : undefined
    const base = data?.currentProfile
    if (!base || catalogBlank(sessions, sessionId)) return null
    const sessionAvatar = currentSession?.agent?.avatar ?? base.avatar
    const profile = { ...base, name: bot?.name ?? base.name, avatar: bot?.avatar ? { id: bot.avatar } : sessionAvatar }
    const type = data.types?.[profile.type]?.name ?? profile.type
    const choose = () => {
      dismissOverlay?.()
      if (bot) {
        requestedBotEdit = bot.id
        openBotsPage?.()
        window.dispatchEvent(new CustomEvent('kode-bot-edit'))
      } else {
        openAvatarDialog({ sessionId, host, profile })
      }
    }
    const avatar = h(AgentAvatar, { profile, host, size: panel ? 28 : 24, status: status ?? (currentSession?.running ? 'running' : 'idle') })
    if (panel) {
      return h(SessionIdentitySection, null, h('div', { className: 'kode-environment-identity' },
        h(SessionPanelRow, { icon: avatar, label: profile.name, detail: profile.name === type ? undefined : type,
          actionLabel: bot ? `编辑伙伴 ${bot.name}` : `设置 ${profile.name} 的头像与背景`,
          trailing: h(IconEditOutlineRegular, { size: 14, 'aria-hidden': true }), onClick: choose }),
        h(HandoffAction, { sessionId, sessions, panel: true, dismissOverlay })))
    }
    return h('span', { className: 'kode-agent-identity', title: bot ? `${bot.name} · 伙伴（${base.name}）` : `${profile.name} · ${type}` },
      h('button', { type: 'button', className: 'kode-session-avatar-button', 'aria-label': bot ? '编辑伙伴' : '设置会话头像与背景', onClick: choose }, avatar), h('span', null, profile.name))
  }
  // DSH only offers rows inside 环境, but identity belongs to the session, not its environment.
  // Lift it into a sibling just before that section of this panel instance; stay inline in hosts of another shape.
  function SessionIdentitySection({ children }) {
    const anchor = useRef(null), [seat, setSeat] = useState(null), useSeatEffect = React.useLayoutEffect ?? useEffect
    useSeatEffect(() => {
      const environment = anchor.current?.closest?.('[data-session-panel-section=environment]')
      if (!environment?.parentElement?.matches?.('[data-session-panel]')) return
      const node = environment.ownerDocument.createElement('section')
      node.className = 'kode-session-identity'
      node.setAttribute('aria-label', '会话 Agent')
      node.setAttribute('data-kode-session-identity', '')
      environment.before(node)
      setSeat(node)
      return () => { node.remove(); setSeat(null) }
    }, [])
    return h(React.Fragment, null, h('span', { ref: anchor, hidden: true }), seat ? createPortal(children, seat) : children)
  }
  function SessionAvatarMenuItem({ sessionId, useMenuOpenState }) {
    const [, setOpen] = useMenuOpenState()
    return h(MenuItemButton, { icon: h(IconAgentPresetOutlineRegular, { size: 16 }), onSelect: () => { setOpen(false); window.dispatchEvent(new CustomEvent('kode-session-avatar', { detail: { sessionId } })) } }, '设置会话头像')
  }
  function SavedSessionHover({ sessionId }) {
    const data = useWorkspaceDirectory()
    const row = data.hosts.flatMap(host => (host.sessions ?? []).map(row => ({ ...row, viewId: host.id === data.current ? row.id : foreignId(host.id, row.id) }))).find(row => row.viewId === sessionId)
    return row && !(row.updatedAt > 0) ? h('span', { className: 'kode-unknown-time' }, '保存时间未知') : null
  }
  function SidebarAgentAvatar({ sessionId, useSessionStatus }) {
    const data = useWorkspaceDirectory(), status = useAvatarStatus(sessionId, useSessionStatus)
    const roster = useBotsData(), bot = data.current === 'local' ? botOfSession(roster, sessionId) : undefined
    if (bot) return h(AgentAvatar, { profile: botProfile(bot), host: 'local', size: 20, status: status ?? 'idle' })
    for (const host of data.hosts) {
      const row = host.sessions?.find(row => (host.id === data.current ? row.id : foreignId(host.id, row.id)) === sessionId)
      if (row?.agent) return h(AgentAvatar, { profile: row.agent, host: host.id, size: 20, status: status ?? (row.running ? 'running' : 'idle') })
    }
    return null
  }
  // Model and effort open as native submenus beside one stable root list, so choosing never swaps panes or moves focus.
  function ModelControl({ sessionId, sessions }) {
    const { data, busy, error, store, id } = useDirectory(sessionId, sessions), [open, setOpen] = useState(false), chosen = useRef(null)
    useEffect(() => { setOpen(false) }, [id])
    // The native submenu can replay a stale "focus first child" when its rows change after a choice; keep focus on the chosen row.
    ;(React.useLayoutEffect ?? useEffect)(() => {
      const row = chosen.current
      if (!row) return
      if (open && row.isConnected && document.activeElement !== row && row.closest('[role=menu]')?.contains(document.activeElement)) row.focus()
      if (!busy || !open) chosen.current = null
    })
    const current = data?.currentProfile ?? data?.profiles.find(p => p.id === data.selectedProfileId)
    const models = data?.models ?? []
    const selected = selectedCatalogModel(models, data?.selection)
    const efforts = selected?.reasoningEfforts ?? [], effort = data?.selection?.reasoningEffort ?? selected?.defaultReasoningEffort
    const effortLabel = efforts.find(row => row.id === effort)?.name ?? effort
    const label = [selected?.name ?? selected?.id ?? (data ? '选择模型' : '正在读取模型…'), effortLabel, data?.fast && !/\bfast\b/i.test(selected?.name ?? '') ? 'Fast' : undefined].filter(Boolean).join(' · ')
    const close = () => setOpen(false)
    const operate = body => { if (busy) return; void store.operate({ action: 'select', profileId: current.id, sessionId: id, ...body }).catch(() => {}) }
    const option = (name, value) => h('span', { className: 'kode-option' }, h('span', null, name), h('span', { className: 'kode-secondary' }, value))
    const choice = (id, name, checked) => ({ id, icon: checked ? h(IconCheckOutlineRegular, { size: 16, 'aria-hidden': true }) : h('span', { className: 'kode-model-choice-mark' }),
      label: h('span', { className: 'kode-model-choice', 'aria-current': checked ? 'true' : undefined }, name) })
    const modelRows = models.map((model, index) => choice(`model:${index}`, model.name ?? model.id, model === selected))
    const items = [{ id: 'models', label: option('模型', selected?.name ?? selected?.id ?? '未选择'),
      submenu: modelRows.length ? modelRows : [{ id: 'empty', disabled: true, label: h('span', { className: 'kode-model-choice' }, data?.modelError ? '模型读取失败' : '暂无可用模型') }] }]
    if (efforts.length) items.push({ id: 'effort', disabled: efforts.length < 2, label: option('推理强度', effortLabel ?? '默认'),
      submenu: efforts.map(row => choice(`effort:${row.id}`, row.name ?? row.id, row.id === effort)) })
    if (selected?.fastCapability) items.push({ id: 'fast', label: h('span', { className: 'kode-option' }, h('span', null, 'Fast'), h(FastSwitch, { checked: data?.fast, disabled: busy, onChange: fast => operate({ provider: selected.provider, model: selected.id, reasoningEffort: effort, fast }) })) })
    items.push({ type: 'separator' }, { id: 'reload', label: '重新读取模型' })
    return h('div', { className: 'kode-model-control' }, h(Menu, { open, onClose: close, items, side: 'top', align: 'end', portal: true, listClassName: 'kode-model-menu', submenuBackLabel: '模型与参数',
      onSelect: value => {
        if (value === 'reload') { close(); void store.load(true); return }
        chosen.current = document.activeElement?.getAttribute?.('role') === 'menuitem' ? document.activeElement : null
        if (value.startsWith('model:')) { const model = models[Number(value.slice(6))]; if (model && model !== selected) operate({ provider: model.provider, model: model.id }); return }
        if (value.startsWith('effort:') && value.slice(7) !== effort) operate({ provider: selected.provider, model: selected.id, reasoningEffort: value.slice(7) })
      },
      anchor: h(Trigger, { model: true, label, open, disabled: busy || !id || !current, onClick: () => setOpen(!open) }),
      footer: error || data?.modelError ? [{ id: 'model-error', disabled: true, label: h('div', { className: 'kode-menu-note', role: 'alert' }, error || '请检查 Agent 的安装与登录状态。') }] : undefined,
    }), h(Failure, { text: error }))
  }
  function selectedCatalogModel(models, selection) {
    const model = selection?.model
    const selected = models.find(row => row.id === model && (!row.provider || row.provider === selection?.provider))
    return selected ?? (model === 'default' ? models.find(row => row.isDefault) ?? models[0] : undefined)
  }
