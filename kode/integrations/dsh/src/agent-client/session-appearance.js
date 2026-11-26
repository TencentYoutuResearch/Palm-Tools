  let avatarSnapshot = { avatars: [], loaded: false, error: '' }, avatarPending
  const avatarListeners = new Set(), avatarSubscribe = fn => { avatarListeners.add(fn); return () => avatarListeners.delete(fn) }
  const avatarSnapshotOf = () => avatarSnapshot
  async function loadAvatars(force = false) {
    if (force && avatarPending) await avatarPending
    if (avatarPending) return avatarPending
    if (avatarSnapshot.loaded && !force) return avatarSnapshot
    avatarPending = (async () => {
      try {
        const response = await fetchHost('/api/kode/avatars', { credentials: 'same-origin', cache: 'no-store' }, 'local')
        const value = await parseHostJson(response); if (!response.ok) throw new Error(value.error)
        avatarSnapshot = { avatars: value.avatars, loaded: true, canRename: value.canRename === true, error: '' }
      } catch (error) { avatarSnapshot = { ...avatarSnapshot, loaded: true, error: error.message } }
      finally { avatarPending = undefined; for (const listener of avatarListeners) listener() }
      return avatarSnapshot
    })()
    return avatarPending
  }
  function useAvatarLibrary(enabled = true) {
    const value = useSyncExternalStore(avatarSubscribe, avatarSnapshotOf)
    useEffect(() => { if (enabled) void loadAvatars() }, [enabled])
    return value
  }
  function backgroundDisplay() {
    try {
      const value = localStorage.getItem('kode.avatar-background')
      if (value === 'off' || value === 'motion') return value
    } catch {}
    return 'still'
  }
  function useBackgroundPreference() {
    const [display, setDisplay] = useState(backgroundDisplay)
    useEffect(() => {
      const update = () => setDisplay(backgroundDisplay())
      window.addEventListener('kode-avatar-background', update)
      window.addEventListener('storage', update)
      return () => {
        window.removeEventListener('kode-avatar-background', update)
        window.removeEventListener('storage', update)
      }
    }, [])
    return [display, value => {
      try { localStorage.setItem('kode.avatar-background', value === 'still' ? 'on' : value) } catch {}
      setDisplay(value)
      window.dispatchEvent(new Event('kode-avatar-background'))
    }]
  }
  const emptyAvatarStatuses = new Map(), emptyAvatarSnapshot = () => emptyAvatarStatuses, emptyAvatarList = { byId: {} }, emptyAvatarListSnapshot = () => emptyAvatarList, emptyAvatarSubscribe = () => () => {}
  function useAvatarStatus(sessionId, useSessionStatus) {
    const rendered = useSessionStatus?.(snapshot => snapshot.get(sessionId))
    const source = avatarContext?.get?.('uiSession')?.sessionStatus
    const status = useSyncExternalStore(source?.subscribe ?? emptyAvatarSubscribe, source?.getSnapshot ?? emptyAvatarSnapshot).get(sessionId)
    const catalog = avatarContext?.sessions?.list
    const catalogRunning = useSyncExternalStore(catalog?.subscribe ?? emptyAvatarSubscribe, catalog?.getSnapshot ?? emptyAvatarListSnapshot).byId[sessionId]?.running
    const running = rendered?.running ?? catalogRunning ?? status?.running
    return (rendered?.pendingInteraction ?? status?.pendingInteraction) ? 'awaiting' : running === true ? 'running' : running === false ? 'idle' : undefined
  }
  function avatarAnimationStatus(status) { return status === 'running' ? 'awaiting' : status }
  function AgentAvatar({ profile, host, size = 20, status = 'idle', preview = false }) {
    const [failed, setFailed] = useState(false), [frame, setFrame] = useState(0), [moving, setMoving] = useState(false), element = React.useRef(null)
    const library = useAvatarLibrary(Boolean(profile?.avatar?.id))
    const artwork = library.avatars.find(row => row.id === profile?.avatar?.id || row.aliases?.includes(profile?.avatar?.id))
    const animationStatus = avatarAnimationStatus(status), frames = artwork?.animations?.[animationStatus] ?? artwork?.animations?.idle ?? []
    const frameKey = frames.join('|')
    useEffect(() => {
      const motion = window.matchMedia('(prefers-reduced-motion: reduce)'); let visible = true
      const update = () => setMoving(visible && !document.hidden && !motion.matches)
      const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update() }) : undefined
      if (element.current) observer?.observe(element.current)
      update(); document.addEventListener('visibilitychange', update); motion.addEventListener('change', update)
      return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); motion.removeEventListener('change', update) }
    }, [])
    useEffect(() => {
      setFrame(0)
      if (!moving || (!preview && animationStatus === 'idle') || frames.length < 2) return
      for (const src of frames) { const image = new Image(); image.src = transport ? transport.path(src, 'local') : src }
      const timer = setInterval(() => setFrame(value => (value + 1) % frames.length), 180)
      return () => clearInterval(timer)
    }, [frameKey, moving, preview, animationStatus])
    const source = frames[frame % (frames.length || 1)] ?? profile?.avatar?.url ?? (profile?.type && profile.type !== 'custom' ? `/api/kode/avatars/media?type=${encodeURIComponent(profile.type)}&state=idle` : null)
    useEffect(() => setFailed(false), [profile?.avatar?.id, profile?.type])
    const url = source && (transport ? transport.path(source, 'local') : source)
    const art = source && !failed ? !profile?.avatar?.id && profile?.type === 'cursor' ? h('span', { className: 'kode-agent-mask', style: { maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` } }) : h('img', { src: url, alt: '', loading: 'lazy', onError: () => setFailed(true) }) : h(profile?.type === 'dsh' ? FishLogo : IconAgentPresetOutlineRegular, { size })
    // The face clips the artwork to a circle and carries the state ring; the dot sits beside it so the clip never hides it.
    const marked = status === 'running' || status === 'awaiting' || status === 'done'
    return h('span', { ref: element, className: 'kode-agent-avatar', style: { width: size, height: size, '--kode-avatar-dot': `${size <= 24 ? 7 : size <= 32 ? 9 : 11}px` }, 'data-avatar-state': status, 'data-avatar-artwork': profile?.avatar?.id ? 'gallery' : 'icon', 'aria-hidden': true },
      h('span', { className: 'kode-agent-avatar-face' }, h('span', { className: 'kode-agent-avatar-art' }, art)), marked && h('span', { className: 'kode-agent-avatar-dot' }))
  }
  async function stageAvatarPrompt(sessionId, host, backgroundOnly, avatarId, forBot) {
    if ((host ?? transport?.current ?? 'local') !== 'local' || (transport?.current ?? 'local') !== 'local') throw new Error('请先切换到此计算机的会话；头像和背景保存在此计算机的共享素材库。')
    const sessions = avatarContext.sessions
    const sourceId = sessionId ?? Object.values(sessions.list.getSnapshot().byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
    // A bot's artwork is made in the bot's own folder, with its Agent, and
    // the session is listed under the bot rather than in a project.
    const bot = forBot ?? botOfSession(botsSnapshot.data, sourceId)
    if (bot) return stageBotAvatarPrompt(bot, backgroundOnly, avatarId)
    if (!sourceId || sourceId.startsWith('saved:')) throw new Error('请先打开此计算机的工作区，再创建素材生成会话。')
    const ui = avatarContext.get('uiWorkspace')
    if (!ui) throw new Error('工作区尚未就绪，请稍后重试。')
    const response = await fetchHost(`/api/kode/avatars/generation-prompt${backgroundOnly ? `?mode=background&avatar=${encodeURIComponent(avatarId)}` : ''}`, { credentials: 'same-origin', cache: 'no-store' }, 'local')
    const value = await parseHostJson(response); if (!response.ok) throw new Error(value.error ?? '无法读取头像生成提示词。')
    const sourceData = directory(sourceId).getSnapshot().data ?? await call(undefined, sourceId, false, 'local', true)
    const profile = sourceData.currentProfile ?? sourceData.profiles?.find(row => row.id === sourceData.selectedProfileId)
    if (!profile) throw new Error('请先为工作区选择一个可用的 Agent。')
    const previous = sessions.list.getSnapshot().byId[sourceId]
    const workspace = avatarContext.get('workspaces')?.list.getSnapshot().items.find(row => row.sessionIds.includes(sourceId))
    if ((transport?.current ?? 'local') !== 'local') throw new Error('执行主机已切换，请返回此计算机后重试。')
    const id = await sessions.create({ ...(workspace ? { workspaceId: workspace.workspaceId } : previous?.cwd ? { cwd: previous.cwd } : {}), agentPreset: 'kode-native' })
    if ((transport?.current ?? 'local') !== 'local') throw new Error('执行主机已切换，新建素材会话已保留在此计算机。')
    await call({ action: 'select', sessionId: id, profileId: profile.id, model: sourceData.selection?.model, reasoningEffort: sourceData.selection?.reasoningEffort }, id, false, 'local')
    await projectCall({ action: 'host-operation', id: 'local', operation: 'rename-session', args: { sessionId: id, title: backgroundOnly ? '生成头像背景' : '生成头像与背景' } })
    await ui.openSession(id)
    await new Promise(resolve => requestAnimationFrame(resolve))
    const binding = sessions.binding(id), input = binding?.ctx.get('conversation')?.input
    if (!input) throw new Error('素材会话已创建，输入框尚未就绪，请稍后重试。')
    const result = input.requestDraftInitialization(binding, { prompt: value.prompt, clearPreviousDraft: false })
    if (result !== 'applied') throw new Error('素材会话已创建，但暂时无法填入提示词，请稍后重试。')
    await refreshWorkspaceDirectory()
    input.for(binding.ctx).focus()
  }
  async function stageBotAvatarPrompt(bot, backgroundOnly, avatarId) {
    if (!bot.agent_id) throw new Error(`伙伴使用的 Agent（${bot.backend_key}）在这台电脑的 dsh 里不可用`)
    const sessions = avatarContext.sessions, ui = avatarContext.get('uiWorkspace')
    if (!ui) throw new Error('工作区尚未就绪，请稍后重试。')
    const qs = new URLSearchParams()
    if (backgroundOnly) { qs.set('mode', 'background'); if (avatarId) qs.set('avatar', avatarId) }
    if (bot.name) qs.set('bot_name', bot.name)
    if (bot.persona) qs.set('bot_persona', bot.persona.slice(0, 240))
    const query = qs.toString() ? `?${qs.toString()}` : ''
    const response = await fetchHost(`/api/kode/avatars/generation-prompt${query}`, { credentials: 'same-origin', cache: 'no-store' }, 'local')
    const value = await parseHostJson(response); if (!response.ok) throw new Error(value.error ?? '无法读取头像生成提示词。')
    const home = await botsCall({ action: 'home', id: bot.id })
    await refreshWorkspaceDirectory()
    const id = await sessions.create({ ...(home.workspace_id ? { workspaceId: home.workspace_id } : { cwd: home.path }), agentPreset: 'kode-native' })
    await call({ action: 'select', sessionId: id, profileId: bot.agent_id, ...(bot.model ? { model: bot.model } : {}) }, id, false, 'local')
    await projectCall({ action: 'host-operation', id: 'local', operation: 'rename-session', args: { sessionId: id, title: `${bot.name} · ${backgroundOnly ? '生成头像背景' : '生成头像与背景'}` } })
    await ui.openSession(id)
    await new Promise(resolve => requestAnimationFrame(resolve))
    const binding = sessions.binding(id), input = binding?.ctx.get('conversation')?.input
    if (!input) throw new Error('素材会话已创建，输入框尚未就绪，请稍后重试。')
    const result = input.requestDraftInitialization(binding, { prompt: value.prompt, clearPreviousDraft: false })
    if (result !== 'applied') throw new Error('素材会话已创建，但暂时无法填入提示词，请稍后重试。')
    await refreshWorkspaceDirectory()
    void refreshBots()
    input.for(binding.ctx).focus()
  }
  function BackgroundVideo({ src, poster, animate, onFailure }) {
    const ref = React.useRef(null), [ready, setReady] = useState(false)
    useEffect(() => {
      const video = ref.current
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
      let visible = true
      const update = () => {
        if (animate && visible && !document.hidden && !reduced.matches) void video.play().catch(() => {})
        else video.pause()
      }
      const observer = typeof IntersectionObserver === 'function' && new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting
        update()
      })
      observer && observer.observe(video)
      document.addEventListener('visibilitychange', update)
      reduced.addEventListener('change', update)
      update()
      return () => {
        observer && observer.disconnect()
        document.removeEventListener('visibilitychange', update)
        reduced.removeEventListener('change', update)
        video.pause()
      }
    }, [src, animate])
    return h('video', { ref, src, poster, muted: true, loop: true, playsInline: true, preload: poster ? 'metadata' : 'auto', 'aria-hidden': true, 'data-frame-ready': ready || undefined,
      onLoadedData: () => setReady(true), onError: () => { setReady(false); onFailure?.() } })
  }
  function localArtworkUrl(url) { return url && (transport ? transport.path(url, 'local') : url) }
  function ConversationBackground({ sessionId, sessions }) {
    const { data } = useDirectory(sessionId, sessions), library = useAvatarLibrary(), [display] = useBackgroundPreference(), directory = useWorkspaceDirectory()
    const [root, setRoot] = useState(null)
    const row = directory.hosts.find(host => host.id === directory.current)?.sessions?.find(row => row.id === sessionId)
    // Every session of a bot wears the bot's scene.
    const bot = botOfSession(useBotsData(), sessionId)
    const avatarId = bot?.avatar ?? (row?.agent?.avatar ?? data?.currentProfile?.avatar)?.id
    const artwork = display !== 'off' && library.avatars.find(row => row.id === avatarId || row.aliases?.includes(avatarId))
    const background = localArtworkUrl(artwork?.background), video = localArtworkUrl(artwork?.backgroundVideo)
    const anchorRef = useCallback(node => setRoot(node?.closest('[data-conversation-content]') ?? null), [])
    useEffect(() => {
      if (!root || (!background && !video)) return
      if (background) root.style.setProperty('--kode-scene-image', `url(${JSON.stringify(background)})`)
      root.setAttribute('data-kode-scene', '')
      return () => { root.style.removeProperty('--kode-scene-image'); root.removeAttribute('data-kode-scene') }
    }, [root, background, video])
    const showVideo = root && video && (display === 'motion' || !background)
    return h(React.Fragment, null,
      h('span', { ref: anchorRef, hidden: true, 'aria-hidden': true }),
      showVideo && createPortal(h('div', { className: 'kode-scene-video', 'aria-hidden': true },
        h(BackgroundVideo, { key: video, src: video, poster: background, animate: display === 'motion' })), root))
  }
