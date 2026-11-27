  // Bots ("伙伴"): named agents shared with Kode. A bot's contact opens its
  // main conversation; the first message starts it with the bot's persona.
  const BOT_CEILINGS = [{ value: 'plan', label: '只做计划' }, { value: 'default', label: '改动前询问' }, { value: 'acceptEdits', label: '可以改文件' }, { value: 'bypassPermissions', label: '完全访问' }]
  async function botsCall(body) {
    const response = await fetchHost('/api/kode/bots', body ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin', cache: 'no-store' })
    const value = await parseHostJson(response)
    if (!response.ok) throw new Error(value.error ?? '伙伴暂不可用')
    return value
  }
  // One roster for the sidebar section and the Bots page.
  let botsSnapshot = { data: null, error: '' }, botsPending
  const botsListeners = new Set()
  const botsStore = { subscribe: fn => { botsListeners.add(fn); return () => botsListeners.delete(fn) }, getSnapshot: () => botsSnapshot }
  function publishBots(next) { botsSnapshot = next; for (const listener of botsListeners) listener() }
  async function refreshBots() {
    if (botsPending) return botsPending
    botsPending = botsCall().then(data => publishBots({ data, error: '' }), error => publishBots({ ...botsSnapshot, error: error.message })).finally(() => { botsPending = undefined })
    return botsPending
  }
  // Avatars change outside this view (Kode settings, a generation session,
  // another window): a bot wearing one the library has not seen reloads it,
  // and coming back to the window rereads both the roster and the library.
  let botsWatchingFocus = false, botsFocusAt = 0
  function followBotsFreshness() {
    if (botsWatchingFocus) return
    botsWatchingFocus = true
    const reread = () => {
      if (document.hidden || Date.now() - botsFocusAt < 5000) return
      botsFocusAt = Date.now()
      void refreshBots()
      void loadAvatars(true)
    }
    window.addEventListener?.('focus', reread)
    document.addEventListener?.('visibilitychange', reread)
  }
  botsListeners.add(() => {
    const bots = botsSnapshot.data?.bots ?? []
    if (avatarSnapshot.loaded && !avatarPending && bots.some(bot => bot.avatar && !avatarSnapshot.avatars.some(row => row.id === bot.avatar || row.aliases?.includes(bot.avatar)))) void loadAvatars(true)
  })
  // Rows that only decorate a session read the roster without fetching it;
  // the sidebar's 伙伴 group keeps it fresh.
  function useBotsData() { return useSyncExternalStore(botsStore.subscribe, botsStore.getSnapshot).data }
  function useBots() {
    const snapshot = useSyncExternalStore(botsStore.subscribe, botsStore.getSnapshot)
    useEffect(() => { followBotsFreshness(); void refreshBots() }, [])
    return snapshot
  }
  // Lucide Heart, Users and Plug, rendered at the sidebar's native icon size.
  const companionIcon = size => navIcon(size, h('path', { d: 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5' }))
  const teamIcon = size => navIcon(size, h('path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3.128a4 4 0 0 1 0 7.744 M22 21v-2a4 4 0 0 0-3-3.87' }), h('circle', { cx: 9, cy: 7, r: 4 }))
  function navIcon(size = 16, ...children) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, ...children)
  }
  const pluginMask = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5 M15 8V2 M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z M9 8V2"/></svg>')
  // Lucide Timer (ISC), https://lucide.dev/icons/timer
  const automationMask = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>')
  // Mount the roster below the whole navigation entry, including its pin control.
  function BotsNavGlyph({ size, openSession }) {
    const seat = useRef(null), [host, setHost] = useState(null)
    const wide = size === 16
    useEffect(() => {
      if (!wide) return
      let item = seat.current?.closest('button')
      const nav = item?.closest('nav')
      if (!nav) return
      while (item.parentElement !== nav) item = item.parentElement
      const box = document.createElement('div')
      box.className = 'kode-bots-nest'
      item.after(box)
      setHost(box)
      return () => { box.remove(); setHost(null) }
    }, [wide])
    return h(React.Fragment, null,
      h('span', { ref: seat, className: 'kode-bots-glyph' }, companionIcon(size)),
      host && createPortal(h(BotsNest, { openSession }), host))
  }
  // Sidebar nameplate & card banner presets.
  const BOT_BANNER_PRESETS = [
    { id: 'preset:blurple', label: '靛蓝星云', css: 'linear-gradient(105deg, rgba(88,101,242,.22) 0%, rgba(88,101,242,.42) 52%, rgba(168,85,247,.52) 100%)' },
    { id: 'preset:aurora', label: '极光青翠', css: 'linear-gradient(105deg, rgba(16,185,129,.18) 0%, rgba(20,184,166,.36) 55%, rgba(56,189,248,.48) 100%)' },
    { id: 'preset:cyber', label: '霓虹赛博', css: 'linear-gradient(105deg, rgba(236,72,153,.20) 0%, rgba(139,92,246,.42) 55%, rgba(34,211,238,.48) 100%)' },
    { id: 'preset:sunset', label: '日落琥珀', css: 'linear-gradient(105deg, rgba(249,115,22,.18) 0%, rgba(244,63,94,.38) 55%, rgba(168,85,247,.44) 100%)' },
    { id: 'preset:forest', label: '幽林翡翠', css: 'linear-gradient(105deg, rgba(34,197,94,.16) 0%, rgba(16,185,129,.34) 55%, rgba(5,150,105,.46) 100%)' },
    { id: 'preset:sakura', label: '樱花暮粉', css: 'linear-gradient(105deg, rgba(244,114,182,.18) 0%, rgba(251,113,133,.36) 55%, rgba(192,132,252,.44) 100%)' },
    { id: 'preset:ocean', label: '深海湛蓝', css: 'linear-gradient(105deg, rgba(37,99,235,.20) 0%, rgba(14,165,233,.36) 55%, rgba(6,182,212,.48) 100%)' },
    { id: 'preset:amber', label: '鎏金暖阳', css: 'linear-gradient(105deg, rgba(245,158,11,.18) 0%, rgba(234,88,12,.34) 55%, rgba(217,119,6,.46) 100%)' },
  ]
  const BOTS_COLLAPSED_KEY = 'kode.dsh.botsCollapsed'
  let botsCollapsed = (() => { try { return typeof localStorage !== 'undefined' && localStorage.getItem(BOTS_COLLAPSED_KEY) === '1' } catch { return false } })()
  const botsCollapseListeners = new Set()
  const botsCollapseStore = { subscribe: fn => { botsCollapseListeners.add(fn); return () => botsCollapseListeners.delete(fn) }, getSnapshot: () => botsCollapsed }
  function setBotsCollapsed(next) {
    botsCollapsed = Boolean(next)
    try { localStorage?.setItem(BOTS_COLLAPSED_KEY, botsCollapsed ? '1' : '0') } catch { /* ignore */ }
    for (const listener of botsCollapseListeners) listener()
  }
  function useBotsCollapsed() { return useSyncExternalStore(botsCollapseStore.subscribe, botsCollapseStore.getSnapshot) }
  /** Everything waiting for you across bots: plans, drafted messages, tasks
   *  and runs that need you. */
  function inboxItems(watches) {
    if (!watches) return []
    const tasks = (watches.tasks ?? []).filter(task => task.status === 'needs_user').map(task => ({ key: task.id, kind: task.kind, bot: task.bot, time: task.updated, task }))
    const runs = (watches.runs ?? []).filter(run => run.status === 'needs_user').map(run => ({ key: run.id, kind: 'run', bot: run.bot, time: run.started, run }))
    return [...tasks, ...runs].sort((a, b) => b.time - a.time)
  }
  function BotsNavTrailing(props) {
    const wide = props?.wide ?? true
    const collapsed = useBotsCollapsed()
    const { data } = useBots()
    const watches = useWatches().data
    const totalUnseen = Object.values(watches?.unseen ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0) + inboxItems(watches).length
    const count = data?.bots?.length ?? 0
    const anchor = useRef(null)
    // The host row owns its own click; only the "伙伴" title text toggles the nested list.
    useEffect(() => {
      if (!wide) return
      const title = anchor.current?.closest('[class*="panelRow"]')?.querySelector('[class*="panelTitle"]')
      if (!title) return
      const toggle = event => { event.stopPropagation(); event.preventDefault(); setBotsCollapsed(!botsCollapsed) }
      title.addEventListener('click', toggle)
      title.classList.add('kode-bots-title')
      return () => { title.removeEventListener('click', toggle); title.classList.remove('kode-bots-title') }
    }, [wide])
    if (!wide) {
      return totalUnseen > 0
        ? h('span', { className: 'kode-bot-badge', title: `${totalUnseen} 条新动态或待你处理的事` }, totalUnseen > 99 ? '99+' : String(totalUnseen))
        : null
    }
    return h('span', { ref: anchor, className: 'kode-bots-trailing' },
      collapsed && totalUnseen > 0 && h('span', { className: 'kode-bot-badge', title: `${totalUnseen} 条新动态或待你处理的事` }, totalUnseen > 99 ? '99+' : String(totalUnseen)),
      h('span', {
        role: 'button',
        tabIndex: 0,
        className: 'kode-bots-collapse',
        'aria-expanded': !collapsed,
        'aria-label': collapsed ? '展开伙伴列表' : '折叠伙伴列表',
        title: collapsed ? `展开伙伴（${count}）` : '折叠伙伴',
        onClick: event => { event.stopPropagation(); event.preventDefault(); setBotsCollapsed(!collapsed) },
        onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); event.preventDefault(); setBotsCollapsed(!collapsed) } },
      }, h(IconChevronDownOutlineRegular, { size: 12 })))
  }
  function botBannerStyle(library, bot) {
    const raw = (bot?.banner ?? '').trim()
    if (raw === 'none') return null
    if (raw.startsWith('preset:')) {
      const preset = BOT_BANNER_PRESETS.find(item => item.id === raw)
      if (preset) return { kind: 'gradient', css: preset.css }
    }
    if (/^color:#[0-9a-fA-F]{6}$/.test(raw)) {
      const hex = raw.slice(6)
      return { kind: 'gradient', css: `linear-gradient(105deg, color-mix(in srgb, ${hex} 18%, transparent) 0%, color-mix(in srgb, ${hex} 42%, transparent) 60%, color-mix(in srgb, ${hex} 58%, transparent) 100%)` }
    }
    const art = botArtwork(library, bot)
    const img = art?.banner ?? art?.background
    if (img) return { kind: 'image', url: sceneUrl(img) }
    return null
  }
  // A bot wears a Kode avatar (animated by its main conversation's state),
  // else its Agent's icon.
  function botArtwork(library, bot) { return bot?.avatar ? library.avatars.find(row => row.id === bot.avatar || row.aliases?.includes(bot.avatar)) : undefined }
  function sceneUrl(path) { return path && (transport ? transport.path(path, 'local') : path) }
  function botOfSession(data, sessionId) { return sessionId ? data?.bots.find(bot => bot.main_session_id === sessionId || bot.sessions?.some(row => row.id === sessionId)) : undefined }
  function botProfile(bot) { return { type: bot.agent_type ?? 'custom', avatar: bot.avatar ? { id: bot.avatar } : null } }
  function BotAvatar({ bot, size = 32, preview = false }) {
    const status = useAvatarStatus(bot.main_session_id ?? '__none__')
    return h(AgentAvatar, { profile: botProfile(bot), host: 'local', size, status: status ?? 'idle', preview })
  }
  function BotAvatarPicker({ draft, bot, busy, onChange }) {
    const library = useAvatarLibrary(), [display, setDisplay] = useBackgroundPreference(), showBackground = display !== 'off', [assetError, setAssetError] = useState('')
    const profile = botProfile(draft), art = botArtwork(library, draft), background = art?.banner ?? art?.background
    const banner = botBannerStyle(library, draft)
    const bannerValue = draft.banner ?? 'auto'
    const customColor = /^color:#[0-9a-fA-F]{6}$/.test(bannerValue) ? bannerValue.slice(6) : '#5865f2'
    const nameplateStyle = banner?.kind === 'image'
      ? { '--kode-bot-banner-img': `url(${JSON.stringify(banner.url)})` }
      : banner?.kind === 'gradient' ? { '--kode-bot-banner-bg': banner.css } : undefined
    return h('div', { className: 'kode-field kode-bot-media-field' },
      h('div', { className: 'kode-bot-asset-previews' },
      h('div', { className: 'kode-bot-nameplate-preview-wrap' },
        h('div', { className: `kode-bot-row kode-bot-nameplate-preview${banner ? ` has-banner is-${banner.kind}` : ''}`, style: nameplateStyle },
          h('span', { className: 'kode-bot-avatar-frame' }, h(AgentAvatar, { profile, host: 'local', size: 32, preview: true })),
          h('span', { className: 'kode-bot-meta' },
            h('span', { className: 'kode-bot-name' }, draft.name?.trim() || '伙伴预览'),
            h('span', { className: 'kode-bot-sub' }, banner?.kind === 'image' ? '头像配套横幅' : banner?.kind === 'gradient' ? '自定义主题背景' : '简洁背景')))),
      h('div', { className: 'kode-avatar-preview kode-bot-scene-preview', 'data-has-background': Boolean(background && showBackground) },
        background && showBackground ? h('img', { src: sceneUrl(background), alt: '', 'aria-hidden': true }) : h('span', null, background ? '背景显示已关闭' : draft.avatar ? '这个头像没有配套背景，可选下方主题或让 AI 生成' : '选一个带背景的头像，或在下方挑选主题背景'),
        h('span', { className: 'kode-bot-scene-avatar' }, h(AgentAvatar, { profile, host: 'local', size: 44, preview: true })))),
      h('div', { className: 'kode-bot-banner-picker', 'aria-label': '侧边栏背景风格' },
        h('button', { type: 'button', className: 'kode-banner-chip', 'aria-pressed': !draft.banner || draft.banner === 'auto', disabled: busy, onClick: () => onChange({ ...draft, banner: null }) }, '跟随头像背景'),
        h('button', { type: 'button', className: 'kode-banner-chip', 'aria-pressed': draft.banner === 'none', disabled: busy, onClick: () => onChange({ ...draft, banner: 'none' }) }, '无背景'),
        ...BOT_BANNER_PRESETS.map(preset => h('button', {
          type: 'button',
          key: preset.id,
          className: 'kode-banner-chip kode-banner-swatch',
          'aria-pressed': draft.banner === preset.id,
          disabled: busy,
          title: preset.label,
          style: { backgroundImage: preset.css },
          onClick: () => onChange({ ...draft, banner: preset.id }),
        }, preset.label)),
        h('label', { className: 'kode-banner-chip kode-banner-color', title: '自定义主题色' },
          h('input', { type: 'color', value: customColor, disabled: busy, onChange: event => onChange({ ...draft, banner: `color:${event.target.value}` }) }),
          h('span', null, '自定义色'))),
      h('div', { className: 'kode-bot-subhead' }, '头像'),
      h('div', { className: 'kode-avatar-grid kode-bot-avatar-grid', 'aria-label': '伙伴头像' },
        h('button', { type: 'button', className: 'kode-avatar-choice', 'aria-pressed': !draft.avatar, disabled: busy, onClick: () => onChange({ ...draft, avatar: null }) }, h(AgentAvatar, { profile: { ...profile, avatar: null }, host: 'local', size: 36 }), h('span', { className: 'kode-avatar-caption' }, 'Agent 图标')),
        ...library.avatars.map(avatar => h('button', { type: 'button', key: avatar.id, className: 'kode-avatar-choice', 'aria-pressed': draft.avatar === avatar.id, disabled: busy, title: avatar.name, onClick: () => onChange({ ...draft, avatar: avatar.id }) }, h(AgentAvatar, { profile: { ...profile, avatar }, host: 'local', size: 36, preview: true }), h('span', { className: 'kode-avatar-caption' }, h('span', null, avatar.name))))),
      bot && h('div', { className: 'kode-bot-asset-actions' },
        h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => void stageAvatarPrompt(undefined, 'local', false, null, bot).catch(error => setAssetError(error.message)) }, 'AI 生成头像与背景'),
        draft.avatar && h(Button, { type: 'button', variant: 'ghost', disabled: busy, onClick: () => void stageAvatarPrompt(undefined, 'local', true, draft.avatar, bot).catch(error => setAssetError(error.message)) }, '只生成背景与横幅'),
        h('span', { className: 'kode-config-note' }, `在伙伴自己的文件夹里开一个会话，同步生成头像、会话背景和横幅，完成后回来选`)),
      h(Failure, { text: assetError }),
      h('label', { className: 'kode-avatar-background-toggle' }, h('input', { type: 'checkbox', checked: showBackground, onChange: event => setDisplay(event.target.checked ? 'still' : 'off') }), '在对话里显示背景（所有会话共用这个开关）'),
      !library.avatars.length && h('span', { className: 'kode-config-note' }, library.loaded ? '还没有自定义头像。可以在 Kode 设置 → 个性化 里创建头像、动画和背景，回来就能选。' : '正在读取头像…'),
      h(Failure, { text: library.error }))
  }
  function BotsNest({ openSession }) {
    const collapsed = useBotsCollapsed()
    const { data } = useBots(), watches = useWatches().data, [expanded, setExpanded] = useState({})
    const library = useAvatarLibrary(Boolean(data?.bots?.some(bot => bot.avatar)))
    if (!data || collapsed) return null
    const start = bot => { requestedBotStart = bot?.id ?? null; openBotsPage?.() }
    return h('div', { className: 'kode-bots-list', onClick: event => event.stopPropagation() },
      ...data.bots.flatMap(bot => {
        const main = bot.main_session_id
        // The bot's other sessions (assets, dispatched subtasks, watch runs) sit under it.
        const others = (bot.sessions ?? []).filter(row => row.id !== main)
        const open = expanded[bot.id] ?? false
        const banner = botBannerStyle(library, bot)
        const bannerStyle = banner?.kind === 'image'
          ? { '--kode-bot-banner-img': `url(${JSON.stringify(banner.url)})` }
          : banner?.kind === 'gradient' ? { '--kode-bot-banner-bg': banner.css } : undefined
        const isBusy = watches?.runs.some(run => run.bot === bot.id && ['starting', 'running', 'needs_user'].includes(run.status))
        return [h('div', { key: bot.id, className: 'kode-bot-line' }, h('button', {
          type: 'button',
          className: `kode-bot-row kode-bot-item${banner ? ` has-banner is-${banner.kind}` : ''}`,
          style: bannerStyle,
          title: bot.persona || bot.name,
          onClick: () => main ? openSession(main) : start(bot),
        },
          h('span', { className: 'kode-bot-avatar-frame' }, h(BotAvatar, { bot, size: 32 })),
          h('span', { className: 'kode-bot-meta' },
            h('span', { className: 'kode-bot-name' }, bot.name),
            (bot.tagline || bot.agent || !main) && h('span', { className: 'kode-bot-sub' }, bot.tagline || (!main ? '点击开始对话' : bot.agent))),
          data.default_bot === bot.id && h('span', { className: 'kode-bot-tag' }, '默认'),
          (() => {
            const waiting = inboxItems(watches).filter(item => item.bot === bot.id).length, count = (watches?.unseen?.[bot.id] ?? 0) + waiting
            return count > 0 && h('span', { className: 'kode-bot-badge', title: waiting ? `${waiting} 件事等你处理` : '有新的关注动态', onClick: event => { event.stopPropagation(); if (!waiting) requestedBotWatches = bot.id; openBotsPage?.(); if (!waiting) window.dispatchEvent(new CustomEvent('kode-bot-watches')) } }, count)
          })(),
          isBusy && h('span', { className: 'kode-bot-busy', title: '正在处理关注的事' })),
          others.length > 0 && h('button', { type: 'button', className: 'kode-bot-more', 'aria-expanded': open, title: open ? '收起子任务与其他会话' : `子任务与会话 ${others.length} 个`, onClick: () => setExpanded({ ...expanded, [bot.id]: !open }) }, open ? '−' : others.length)),
          ...(open ? others.slice(0, 8).map(row => h('button', { key: `${bot.id}:${row.id}`, type: 'button', className: 'kode-bot-row kode-bot-session', title: row.title, onClick: () => openSession(row.id) },
            h('span', { className: 'kode-bot-session-kind' }, row.kind === 'watch' ? '关注' : row.kind === 'subtask' ? '子任务' : '会话'),
            h('span', { className: 'kode-bot-name' }, row.title),
            // Filed here by hand: it can go back to its project.
            row.adopted && h('span', { className: 'kode-bot-release', role: 'button', title: '移回原来的项目', onClick: event => { event.stopPropagation(); void botsCall({ action: 'adopt', session: row.id, id: null }).then(value => publishBots({ data: value, error: '' }), () => {}) } }, '×'))) : [])]
      }),
      h('button', { type: 'button', className: 'kode-bot-row kode-bot-new', onClick: () => start(null) }, h('span', { className: 'kode-bot-avatar' }, h(IconPlusOutlineRegular, { size: 12 })), h('span', { className: 'kode-bot-name' }, data.bots.length ? '新建伙伴' : '创建第一个伙伴')))
  }
  function BotModelPicker({ profileId, model, disabled, onChange }) {
    const store = directory(undefined, 'local', true, profileId)
    const { data, error } = useSyncExternalStore(store.subscribe, store.getSnapshot)
    useEffect(() => { if (profileId) void store.load() }, [store, profileId])
    const models = profileId ? data?.models ?? [] : []
    const options = [{ value: '', label: 'Agent 默认模型' }, ...models.filter(row => row.id !== 'default').map(row => ({ value: row.id, label: row.name ?? row.displayName ?? row.id }))]
    if (model && !options.some(option => option.value === model)) options.push({ value: model, label: model })
    const failure = profileId && (error || data?.modelError)
    return h(React.Fragment, null,
      h(SelectField, { label: '模型（可选）', value: model ?? '', options, disabled, onChange }),
      profileId && !data && !error && h('span', { className: 'kode-config-note', role: 'status' }, '正在读取此 Agent 的模型…'),
      profileId && data && !failure && !models.length && h('span', { className: 'kode-config-note' }, '此 Agent 未提供可选模型'),
      failure && h('div', null, h(Failure, { text: failure }), h(Button, { type: 'button', variant: 'outline', onClick: () => void store.load(true) }, '重新读取模型')))
  }
  // Fields the dsh view adds to a bot; the roster stores the rest.
  // (`tone` and `tone_note` are forwarded on upsert and stripped by the server before Rust.)
  const BOT_VIEW_FIELDS = ['agent', 'agent_type', 'agent_id', 'main_session_id', 'workspace', 'home', 'sessions', 'connectors']
  function storedBotFields(bot) {
    const stored = Object.fromEntries(Object.entries(bot).filter(([key]) => !BOT_VIEW_FIELDS.includes(key)))
    return { ...stored, model: stored.model?.trim?.() || null, tagline: stored.tagline?.trim() || null }
  }
  const BOT_TONE_FALLBACK = [
    { id: 'colleague', label: '靠谱同事', summary: '像坐旁边的资深搭档，自然平实、说人话、有事直说', example: '「刚帮你扫了一眼，这处有个小坑，我先记在看板上了，你看现在顺手处理还是晚点？」' },
    { id: 'direct', label: '干脆利落', summary: '少废话、结论先行、直击重点，适合审代码和排障', example: '「两个阻断项：第 42 行空指针、回调缺超时。建议先修前者，要我顺手提 patch 吗？」' },
    { id: 'warm', label: '温和耐心', summary: '友好细腻、有同理心，循序渐进拆解，但不带客服腔', example: '「别急，这块逻辑确实绕，我先把关键路径顺了一遍，咱们一步步来看。」' },
    { id: 'humorous', label: '轻松风趣', summary: '带点机灵和恰到好处的幽默感，干活靠谱但不沉闷', example: '「线上又在整活了？别慌，我把日志翻出来了，罪魁祸首八成是这个超时配置。」' },
    { id: 'butler', label: '沉稳管家', summary: '周到克制、条理分明，主动把风险和边界替你想在前头', example: '「这两件事我先替你盯住，周四前没动静我再提醒你；眼下只需要你拍板接口方案。」' },
    { id: 'custom', label: '自定义风格', summary: '完全按你在下方填写的口吻习惯来说话', example: '按你的自定义口吻说明执行（例如称呼方式、长短偏好、口头禅或禁忌）。' },
  ]
  function toneMeta(id, presets) {
    const list = presets?.length ? presets : BOT_TONE_FALLBACK
    return list.find(row => row.id === id) ?? list[0]
  }
  function BotTonePicker({ tone, toneNote, presets, disabled, compact = false, onChange }) {
    const list = presets?.length ? presets : BOT_TONE_FALLBACK
    const active = toneMeta(tone || 'colleague', list)
    return h('div', { className: `kode-tone-picker${compact ? ' is-compact' : ''}` },
      h('div', { className: 'kode-tone-grid', role: 'radiogroup', 'aria-label': '语气风格' },
        ...list.map(item => h('button', {
          key: item.id,
          type: 'button',
          role: 'radio',
          'aria-checked': active.id === item.id,
          className: `kode-tone-card${active.id === item.id ? ' is-active' : ''}`,
          disabled,
          title: item.summary,
          onClick: () => onChange({ tone: item.id, tone_note: toneNote ?? '' }),
        },
          h('strong', null, item.label),
          !compact && h('span', { className: 'kode-secondary' }, item.summary)))),
      active.example && h('p', { className: 'kode-tone-example' }, h('span', { className: 'kode-tone-example-tag' }, '说话示例'), active.example),
      h('label', { className: 'kode-field' },
        h('span', null, active.id === 'custom' ? '自定义口吻说明（必填更贴合）' : '口吻补充 / 称呼习惯（可选）'),
        h('input', {
          maxLength: 400,
          value: toneNote ?? '',
          disabled,
          placeholder: '例如：叫我「老王」、尽量用短句口语、少用感叹号、别老用 1/2/3 列清单',
          onChange: event => onChange({ tone: active.id, tone_note: event.target.value }),
        })))
  }
  async function botsQuery(query) {
    const response = await fetchHost(`/api/kode/bots?${query}`, { credentials: 'same-origin', cache: 'no-store' })
    const value = await parseHostJson(response)
    if (!response.ok) throw new Error(value.error ?? '技能暂不可用')
    return value
  }
  function botBannerVars(banner, variable = '--kode-bot-scene') {
    return banner?.kind === 'image' ? { [variable]: `url(${JSON.stringify(banner.url)})` } : banner?.kind === 'gradient' ? { [variable]: banner.css } : undefined
  }
  const ceilingLabel = value => BOT_CEILINGS.find(row => row.value === value)?.label ?? value
  function BotSkillChips({ skills, empty = '还没有技能' }) {
    return skills?.length
      ? h('span', { className: 'kode-bot-skill-chips' }, ...skills.map(skill => h('span', { key: skill.slug, className: 'kode-bot-skill-chip', title: skill.description || skill.slug }, h(SkillGlyph, { size: 12 }), skill.name)))
      : h('span', { className: 'kode-secondary' }, empty)
  }
  // 技能: installed skills, SkillHub and this computer's own. Installs act at
  // once and go into the bot's own folder.
  function BotSkillsPanel({ bot }) {
    const [tab, setTab] = useState('installed'), [query, setQuery] = useState(''), [category, setCategory] = useState('')
    const [categories, setCategories] = useState([]), [results, setResults] = useState(null), [local, setLocal] = useState(null)
    const [working, setWorking] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
    const installed = new Set((bot.skills ?? []).map(row => row.slug))
    const load = async (task, set) => { setError(''); try { set(await task) } catch (failure) { setError(failure.message) } }
    useEffect(() => {
      if (tab === 'skillhub' && !categories.length) void load(botsQuery('skillhub=categories').then(value => value.categories), setCategories)
      if (tab === 'skillhub' && !results) void load(botsQuery('skillhub=list'), setResults)
      if (tab === 'local' && !local) void load(botsQuery('skills=local').then(value => value.skills), setLocal)
    }, [tab])
    const browse = next => { setCategory(next); setQuery(''); setResults(null); void load(botsQuery(`skillhub=list${next ? `&category=${encodeURIComponent(next)}` : ''}`), setResults) }
    const search = event => { event.preventDefault(); setResults(null); void load(botsQuery(query.trim() ? `skillhub=search&q=${encodeURIComponent(query.trim())}` : `skillhub=list${category ? `&category=${encodeURIComponent(category)}` : ''}`), setResults) }
    const act = async (slug, body) => {
      if (working) return
      setWorking(slug); setError(''); setNotice('')
      try {
        const value = await botsCall({ ...body, id: bot.id, slug })
        publishBots({ data: value, error: '' })
        if (value.skipped?.length) setNotice(`已安装；${value.skipped.join('、')} 里已有同名文件夹，保留了原来的。`)
      } catch (failure) { setError(failure.message) } finally { setWorking('') }
    }
    const install = (source, row) => act(row.slug, { action: 'skill_install', source, name: row.name, description: row.description, ...(source === 'local' ? { path: row.path } : {}) })
    const card = (row, source) => h('li', { key: `${source}:${row.slug}:${row.path ?? ''}`, className: 'kode-skill-card' },
      h('span', { className: 'kode-skill-icon', 'aria-hidden': true }, (row.name || row.slug).slice(0, 1).toUpperCase()),
      h('span', { className: 'kode-skill-text' },
        h('span', { className: 'kode-agent-name' }, row.name),
        row.description && h('span', { className: 'kode-secondary kode-skill-desc' }, row.description),
        source === 'skillhub' && h('span', { className: 'kode-skill-stats' }, `★ ${row.stars} · 下载 ${row.downloads.toLocaleString()}`),
        source === 'local' && h('span', { className: 'kode-skill-stats', title: row.path }, row.path)),
      source === 'installed'
        ? h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(working), onClick: () => { if (confirm(`从「${bot.name}」移除技能「${row.name}」？`)) void act(row.slug, { action: 'skill_remove' }) } }, working === row.slug ? '移除中…' : '移除')
        : h(Button, { size: 'sm', variant: installed.has(row.slug) ? 'ghost' : 'outline', disabled: Boolean(working) || installed.has(row.slug), onClick: () => void install(source, row) }, installed.has(row.slug) ? '已安装' : working === row.slug ? '安装中…' : '安装'))
    const tabs = [['installed', `已安装 ${installed.size}`], ['skillhub', 'SkillHub'], ['local', '这台电脑']]
    return h('div', { className: 'kode-bot-skills' },
      h('div', { className: 'kode-segmented', role: 'tablist' }, ...tabs.map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab', 'aria-selected': tab === id, onClick: () => setTab(id) }, label))),
      bot.default_cwd && h('p', { className: 'kode-config-note' }, `这个伙伴默认在 ${bot.default_cwd} 工作。技能只装在伙伴自己的空间（${bot.home ?? '伙伴文件夹'}），在那里开的会话才会加载。`),
      tab === 'installed' && (bot.skills?.length
        ? h('ul', { className: 'kode-skill-list' }, ...bot.skills.map(row => card(row, 'installed')))
        : h('p', { className: 'kode-secondary' }, '还没有技能。到 SkillHub 或这台电脑里挑几个吧。')),
      tab === 'skillhub' && h(React.Fragment, null,
        h('form', { className: 'kode-skill-search', onSubmit: search },
          h(IconSearchOutlineRegular, { size: 16 }),
          h('input', { 'aria-label': '搜索 SkillHub', placeholder: '搜索技能，例如：代码审查、周报、调研', value: query, onChange: event => setQuery(event.target.value) }),
          h(Button, { type: 'submit', size: 'sm', variant: 'outline' }, '搜索')),
        categories.length > 0 && h('div', { className: 'kode-bot-banner-picker kode-skill-categories' },
          h('button', { type: 'button', className: 'kode-banner-chip', 'aria-pressed': !category, onClick: () => browse('') }, '热门'),
          ...categories.map(row => h('button', { key: row.key, type: 'button', className: 'kode-banner-chip', 'aria-pressed': category === row.key, onClick: () => browse(row.key) }, row.name))),
        !results && !error && h('p', { className: 'kode-secondary', role: 'status' }, '正在读取 SkillHub…'),
        results && (results.skills.length ? h('ul', { className: 'kode-skill-list' }, ...results.skills.map(row => card(row, 'skillhub'))) : h('p', { className: 'kode-secondary' }, '没有找到相关技能，换个关键词试试。')),
        h('p', { className: 'kode-config-note' }, '技能来自 SkillHub（lightmake.site），由第三方发布；安装前可在 SkillHub 查看说明。')),
      tab === 'local' && (local
        ? local.length ? h('ul', { className: 'kode-skill-list' }, ...local.map(row => card(row, 'local'))) : h('p', { className: 'kode-secondary' }, '这台电脑的 ~/.claude、~/.agents、~/.codex 等 skills 目录里没有找到技能。')
        : !error && h('p', { className: 'kode-secondary', role: 'status' }, '正在读取这台电脑的技能…')),
      notice && h('p', { className: 'kode-config-note', role: 'status' }, notice),
      h(Failure, { text: error }))
  }
  const TASK_COLUMNS = [['needs_user', '待你处理'], ['in_progress', '进行中'], ['waiting', '等待中'], ['planned', '计划中'], ['done', '最近完成']]
  const TASK_STATUS_OPTIONS = [{ value: 'planned', label: '计划中' }, { value: 'in_progress', label: '进行中' }, { value: 'waiting', label: '等待中' }, { value: 'needs_user', label: '待你处理' }, { value: 'done', label: '已完成' }, { value: 'cancelled', label: '取消' }]
  const shortTime = ms => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  async function taskAct(body) { return botsCall(body) }
  // A bot's task board: what it tracks for you, grouped by status.
  function BotTaskBoard({ bot, ui }) {
    const { data, error: loadError } = useWatches()
    const [title, setTitle] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const act = async body => { setBusy(true); setError(''); try { await taskAct(body); return true } catch (failure) { setError(failure.message); return false } finally { setBusy(false) } }
    if (!data) return h('div', null, h('p', { className: 'kode-secondary', role: 'status' }, '正在读取任务…'), h(Failure, { text: loadError }))
    if (!data.tasks) return h('p', { className: 'kode-config-note' }, 'Kode 服务版本较旧，更新后才能使用任务板。')
    const tasks = data.tasks.filter(task => task.bot === bot.id && task.kind === 'task')
    const add = async event => { event.preventDefault(); if (title.trim() && await act({ action: 'task_upsert', task: { bot: bot.id, title: title.trim() } })) setTitle('') }
    const card = task => h('li', { key: task.id, className: 'kode-task-card', 'data-status': task.status },
      h('div', { className: 'kode-task-head' },
        h('span', { className: 'kode-agent-name' }, task.title),
        h('button', { type: 'button', className: 'kode-task-remove', title: '删除任务', disabled: busy, onClick: () => { if (confirm(`删除任务「${task.title}」？`)) void act({ action: 'task_delete', id: task.id }) } }, '×')),
      task.reason && h('span', { className: 'kode-secondary kode-task-reason' }, task.reason),
      h('div', { className: 'kode-task-meta' },
        h(SelectField, { label: '状态', showLabel: false, value: task.status, options: TASK_STATUS_OPTIONS, disabled: busy, onChange: value => void act({ action: 'task_upsert', task: { id: task.id, status: value } }) }),
        task.due && h('span', { className: `kode-agent-tag${task.due < Date.now() && !task.closed ? ' is-late' : ''}` }, `截止 ${shortTime(task.due)}`),
        task.session_uuid && h(Button, { size: 'sm', variant: 'ghost', onClick: () => void ui()?.openSession(task.session_uuid) }, '打开会话'),
        h('span', { className: 'kode-secondary' }, `更新于 ${shortTime(task.updated)}`)))
    return h('div', { className: 'kode-task-board' },
      h('p', { className: 'kode-secondary' }, '伙伴自己维护这块任务板；关联了执行会话的任务，会话完成、提问、卡住或到期时 Kode 会提醒它跟进。你也可以在这里加任务或改状态。'),
      h('form', { className: 'kode-skill-search', onSubmit: add }, h(IconPlusOutlineRegular, { size: 16 }), h('input', { 'aria-label': '新任务', placeholder: `给 ${bot.name} 加一个要跟踪的任务`, value: title, disabled: busy, onChange: event => setTitle(event.target.value) }), h(Button, { type: 'submit', size: 'sm', variant: 'outline', disabled: busy || !title.trim() }, '添加')),
      tasks.length ? h('div', { className: 'kode-task-columns' }, ...TASK_COLUMNS.map(([status, label]) => {
        const rows = tasks.filter(task => status === 'done' ? task.status === 'done' : task.status === status)
        return rows.length > 0 && h('section', { key: status, className: 'kode-task-column' }, h('h4', null, `${label} · ${rows.length}`), h('ul', { className: 'kode-skill-list' }, ...rows.map(card)))
      })) : h('p', { className: 'kode-secondary' }, '任务板还是空的。让伙伴「帮我盯着 …」，或者在上面加一个。'),
      h(Failure, { text: error }))
  }
  function BotInboxItem({ item, bot, watch, ui }) {
    const [note, setNote] = useState(''), [content, setContent] = useState(item.task?.payload?.content ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const act = async body => { setBusy(true); setError(''); try { await taskAct(body) } catch (failure) { setError(failure.message) } finally { setBusy(false) } }
    const who = h('span', { className: 'kode-inbox-who' }, bot ? h(BotAvatar, { bot, size: 24 }) : null, h('span', null, bot?.name ?? '伙伴'), h('span', { className: 'kode-secondary' }, shortTime(item.time)))
    const { task, run } = item
    if (item.kind === 'plan') return h('li', { className: 'kode-inbox-item' }, who,
      h('span', { className: 'kode-agent-tag' }, '计划待批准'), h('strong', null, task.title),
      task.detail && h('p', { className: 'kode-secondary kode-inbox-text' }, task.detail),
      h('ol', { className: 'kode-inbox-steps' }, ...(task.payload?.steps ?? []).map((step, index) => h('li', { key: index }, step.title, step.detail ? h('span', { className: 'kode-secondary' }, ` · ${step.detail}`) : null))),
      h('input', { className: 'kode-inbox-note', placeholder: '意见（可选），例如：先做第 2 步', value: note, disabled: busy, onChange: event => setNote(event.target.value) }),
      h('div', { className: 'kode-bot-actions' }, h(Button, { variant: 'primary', disabled: busy, onClick: () => void act({ action: 'task_approve', id: task.id, note }) }, '批准并开始'), h(Button, { disabled: busy, onClick: () => void act({ action: 'task_reject', id: task.id, note }) }, '不同意')),
      h(Failure, { text: error }))
    if (item.kind === 'outbound') return h('li', { className: 'kode-inbox-item' }, who,
      h('span', { className: 'kode-agent-tag' }, `待发送 · 企业微信 ${task.payload?.chat_id ?? ''}`),
      h('textarea', { className: 'kode-inbox-draft', rows: Math.min(10, Math.max(3, content.split('\n').length)), value: content, disabled: busy, onChange: event => setContent(event.target.value) }),
      h('div', { className: 'kode-bot-actions' }, h(Button, { variant: 'primary', disabled: busy || !content.trim(), onClick: () => void act({ action: 'outbox_send', id: task.id, content }) }, busy ? '发送中…' : '发送'), h(Button, { disabled: busy, onClick: () => void act({ action: 'task_reject', id: task.id, note: content !== task.payload?.content ? '用户改过内容但决定不发' : '' }) }, '不发')),
      h(Failure, { text: error }))
    if (item.kind === 'run') return h('li', { className: 'kode-inbox-item' }, who,
      h('span', { className: 'kode-agent-tag' }, '关注任务在等你'), h('strong', null, watch?.spec.name ?? '关注任务'),
      run.summary && h('p', { className: 'kode-secondary kode-inbox-text' }, run.summary),
      run.session_uuid && h('div', { className: 'kode-bot-actions' }, h(Button, { variant: 'primary', onClick: () => void ui()?.openSession(run.session_uuid) }, '去处理')))
    return h('li', { className: 'kode-inbox-item' }, who,
      h('span', { className: 'kode-agent-tag' }, '待你处理'), h('strong', null, task.title),
      (task.reason || task.detail) && h('p', { className: 'kode-secondary kode-inbox-text' }, task.reason || task.detail),
      h('div', { className: 'kode-bot-actions' },
        task.session_uuid && h(Button, { variant: 'primary', onClick: () => void ui()?.openSession(task.session_uuid) }, '打开会话'),
        h(Button, { disabled: busy, onClick: () => void act({ action: 'task_upsert', task: { id: task.id, status: 'in_progress', reason: '' } }) }, '我处理好了，让伙伴继续'),
        h(Button, { variant: 'ghost', disabled: busy, onClick: () => void act({ action: 'task_upsert', task: { id: task.id, status: 'done' } }) }, '标为完成')),
      h(Failure, { text: error }))
  }
  function BotInbox({ data, ui }) {
    const watches = useWatches().data
    const items = inboxItems(watches)
    if (!items.length) return null
    return h('section', { className: 'kode-bots-section kode-bot-inbox' },
      h('h3', { className: 'kode-bots-section-title' }, `待你处理 · ${items.length}`),
      h('ul', { className: 'kode-inbox-list' }, ...items.map(item => h(BotInboxItem, { key: item.key, item, ui, bot: data.bots.find(bot => bot.id === item.bot), watch: item.run && watches.watches.find(row => row.id === item.run.watch_id) }))))
  }
  // Bot notifications in this window wait and arrive together afterwards.
  function BotQuietHours({ data }) {
    const current = data.quiet_hours
    const [draft, setDraft] = useState(() => current ?? { start: '22:00', end: '08:00' }), [enabled, setEnabled] = useState(Boolean(current)), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
    const save = async () => {
      setBusy(true); setError(''); setSaved(false)
      try { publishBots({ data: await botsCall({ action: 'set_quiet_hours', quiet_hours: enabled ? draft : null }), error: '' }); setSaved(true) } catch (failure) { setError(failure.message) } finally { setBusy(false) }
    }
    return h('div', { className: 'kode-agent-row kode-bot-quiet' },
      h('div', { className: 'kode-agent-row-head' }, h('span', { className: 'kode-agent-name' }, '免打扰时段'), h(FastSwitch, { checked: enabled, disabled: busy, label: '免打扰', onChange: setEnabled })),
      h('p', { className: 'kode-secondary' }, '这段时间里伙伴的提醒先攒着，结束后合成一条发给你。定时任务照常运行。'),
      enabled && h('div', { className: 'kode-watch-grid' },
        h('label', { className: 'kode-field' }, h('span', null, '开始'), h('input', { type: 'time', value: draft.start, disabled: busy, onChange: event => setDraft({ ...draft, start: event.target.value }) })),
        h('label', { className: 'kode-field' }, h('span', null, '结束'), h('input', { type: 'time', value: draft.end, disabled: busy, onChange: event => setDraft({ ...draft, end: event.target.value }) }))),
      h('div', { className: 'kode-settings-footer' }, saved && h('span', { className: 'kode-secondary', role: 'status' }, '已保存'), h(Button, { variant: 'primary', disabled: busy, onClick: () => void save() }, '保存')),
      h(Failure, { text: error }))
  }
  const BOT_SETTINGS_TABS = [['profile', '资料'], ['persona', '角色说明'], ['connectors', '连接器'], ['tasks', '看板'], ['watches', '关注与定时'], ['skills', '技能'], ['run', '运行方式'], ['advanced', '高级']]
  const BOT_OUTBOUND = [{ value: 'direct', label: '直接发送' }, { value: 'draft', label: '先起草，我确认后再发' }]
  // A bot's settings take over the whole 伙伴 page: sections on the left.
  function BotSettingsPage({ bot, data, initialTab = 'profile', ui, onClose, onDeleted }) {
    const [tab, setTab] = useState(initialTab), [draft, setDraft] = useState(() => ({ ...bot })), [busy, setBusy] = useState(false), [error, setError] = useState('')
    useEffect(() => { setDraft({ ...bot }); setTab(initialTab) }, [bot.id, initialTab])
    const editable = ['profile', 'persona', 'run'].includes(tab)
    const openTasks = (useWatches().data?.tasks ?? []).filter(task => task.bot === bot.id && task.kind === 'task' && !task.closed).length
    const activeConnectors = (bot.connectors ?? []).filter(row => row.enabled !== false).length
    const dirty = ['name', 'tagline', 'avatar', 'banner', 'persona', 'tone', 'tone_note', 'backend_key', 'model', 'permission_ceiling', 'default_cwd', 'outbound'].some(key => (draft[key] ?? null) !== (bot[key] ?? null))
    const run = async (body, close = false) => {
      setBusy(true); setError('')
      try { const value = await botsCall(body); if (Array.isArray(value.bots)) publishBots({ data: value, error: '' }); if (close) onClose(); return value }
      catch (failure) { setError(failure.message) } finally { setBusy(false) }
    }
    // Skills change on their own; saving the profile keeps the latest ones.
    const save = () => run({ action: 'upsert', bot: { ...storedBotFields(draft), skills: bot.skills ?? [] } })
    const set = patch => setDraft({ ...draft, ...patch })
    const field = (label, key, props = {}) => h('label', { className: 'kode-field' }, h('span', null, label), h(props.rows ? 'textarea' : 'input', { value: draft[key] ?? '', disabled: busy, onChange: event => set({ [key]: event.target.value }), ...props }))
    const agents = data.agents.map(agent => ({ value: agent.backend_key, label: agent.name }))
    if (draft.backend_key && !agents.some(agent => agent.value === draft.backend_key)) agents.push({ value: draft.backend_key, label: `${draft.backend_key}（此电脑不可用）` })
    const places = [{ value: '', label: `伙伴自己的空间（${bot.home ?? `${data.root}/${bot.id}`}）` }, ...data.workspaces.map(row => ({ value: row.path, label: row.title }))]
    if (draft.default_cwd && !places.some(row => row.value === draft.default_cwd)) places.push({ value: draft.default_cwd, label: draft.default_cwd })
    const body = tab === 'profile' ? h('div', { className: 'kode-bot-pane-columns' },
      h('section', { className: 'kode-bot-pane-card' },
        h('h4', null, '基本资料'),
        field('名字', 'name', { maxLength: 80, required: true }),
        field('一句话简介', 'tagline', { maxLength: 120, placeholder: '显示在头像卡和侧栏，例如：逐条审 PR，指出风险' }),
        h('div', { className: 'kode-field' },
          h('span', null, '语气风格（告别“人机味”）'),
          h(BotTonePicker, { tone: draft.tone ?? 'colleague', toneNote: draft.tone_note ?? '', presets: data.tone_presets, disabled: busy, onChange: next => set(next) })),
        field('角色说明（摘要显示在资料卡上）', 'persona', { rows: 6, placeholder: '这个伙伴负责什么、按什么标准做事、什么时候问你' })),
      h('section', { className: 'kode-bot-pane-card kode-bot-pane-media' },
        h('h4', null, '头像与背景'),
        h(BotAvatarPicker, { bot, draft: { ...draft, agent_type: data.agents.find(agent => agent.backend_key === draft.backend_key)?.type ?? draft.agent_type }, busy, onChange: next => set({ avatar: next.avatar, banner: next.banner }) })))
      : tab === 'persona' ? h('section', { className: 'kode-bot-pane-card' },
        h('h4', null, '语气风格与角色说明'),
        h('span', { className: 'kode-secondary' }, '语气风格决定伙伴怎么开口说话（去 AI 客服腔），角色说明决定它的职责和做事边界。改完后下次新对话或点「重新打招呼」立即生效。'),
        h(BotTonePicker, { tone: draft.tone ?? 'colleague', toneNote: draft.tone_note ?? '', presets: data.tone_presets, disabled: busy, onChange: next => set(next) }),
        field('角色说明', 'persona', { rows: 14, placeholder: '这个伙伴负责什么、按什么标准做事、什么时候问你' }))
      : tab === 'run' ? h('div', { className: 'kode-bot-run-form' },
        h(SelectField, { label: 'Agent', value: draft.backend_key, options: agents, disabled: busy, onChange: value => set({ backend_key: value, model: null }) }),
        h(BotModelPicker, { profileId: data.agents.find(agent => agent.backend_key === draft.backend_key)?.profile_id, model: draft.model, disabled: busy, onChange: value => set({ model: value || null }) }),
        h(SelectField, { label: '权限上限', value: draft.permission_ceiling, options: BOT_CEILINGS, disabled: busy, onChange: value => set({ permission_ceiling: value }) }),
        h(SelectField, { label: '默认工作区', value: draft.default_cwd ?? '', options: places, disabled: busy, onChange: value => set({ default_cwd: value || null }) }),
        h(SelectField, { label: '对外消息（企业微信等）', value: draft.outbound ?? 'direct', options: BOT_OUTBOUND, disabled: busy, onChange: value => set({ outbound: value === 'direct' ? null : value }) }),
        h('span', { className: 'kode-config-note' }, '选「先起草」时，伙伴要发出去的消息会先放进伙伴页的「待你处理」，你改好、点发送才会发出。'))
      : tab === 'connectors' ? h(BotConnectorsPanel, { bot, data })
      : tab === 'tasks' ? h(BotsKanbanBoard, { data, ui, singleBot: bot })
      : tab === 'skills' ? h(BotSkillsPanel, { bot })
      : tab === 'watches' ? h(BotWatches, { bot, workspaces: data.workspaces, ui, routines: data.routines ?? [], onOpenConnectors: () => setTab('connectors') })
      : h('div', { className: 'kode-bot-advanced' },
        h('p', { className: 'kode-secondary' }, `记忆范围 bot:${bot.id}`),
        h('p', { className: 'kode-secondary' }, `伙伴空间 ${bot.home ?? '—'}`),
        h('div', { className: 'kode-bot-actions' },
          data.default_bot !== bot.id && h(Button, { disabled: busy, onClick: () => void run({ action: 'set_default', id: bot.id }) }, '设为默认伙伴'),
          h(Button, {
            disabled: busy || !bot.agent,
            onClick: async () => {
              const result = await run({ action: 'greet', id: bot.id, force: true, idempotency_key: `bot-greet-retry-${bot.id}-${Date.now()}` })
              if (result?.sessionId) { void refreshBots(); await ui()?.openSession(result.sessionId) }
            },
          }, '重新打招呼'),
          bot.main_session_id && h(Button, { disabled: busy, onClick: () => void run({ action: 'forget', id: bot.id }) }, '下次开始新对话')),
        h('div', { className: 'kode-bot-danger' },
          h('span', null, h('strong', null, '删除伙伴'), h('span', { className: 'kode-secondary' }, '它的会话、伙伴空间里的文件和记忆都会保留。')),
          h(Button, { variant: 'outline', disabled: busy, onClick: async () => { if (confirm(`删除「${bot.name}」？`) && await run({ action: 'delete', id: bot.id })) { onDeleted?.(); onClose() } } }, '删除')))
    const leave = () => { if (!dirty || confirm('有未保存的修改，确定离开？')) onClose() }
    return h('div', { className: 'kode-bot-settings' },
      h('header', { className: 'kode-bot-settings-head' },
        h(Button, { variant: 'ghost', size: 'sm', onClick: leave }, '‹ 伙伴'),
        h(BotAvatar, { bot: draft, size: 32 }),
        h('h2', null, bot.name, h('span', { className: 'kode-secondary' }, ' · 伙伴设置'))),
      h('div', { className: 'kode-bot-settings-body' },
        h('nav', { className: 'kode-bot-settings-nav', 'aria-label': '设置分类' }, ...BOT_SETTINGS_TABS.map(([id, label]) => h('button', { key: id, type: 'button', 'aria-current': tab === id ? 'page' : undefined, onClick: () => setTab(id) }, label, id === 'skills' && bot.skills?.length ? h('span', { className: 'kode-bot-nav-count' }, bot.skills.length) : id === 'tasks' && openTasks ? h('span', { className: 'kode-bot-nav-count' }, openTasks) : id === 'connectors' && activeConnectors ? h('span', { className: 'kode-bot-nav-count' }, activeConnectors) : null))),
        h('div', { className: 'kode-bot-settings-pane' }, body, h(Failure, { text: error }))),
      editable && h('footer', { className: 'kode-bot-settings-foot' },
        dirty && h('span', { className: 'kode-secondary' }, '有未保存的修改'),
        h(Button, { variant: 'outline', disabled: busy || !dirty, onClick: () => setDraft({ ...bot }) }, '撤销修改'),
        h(Button, { variant: 'primary', disabled: busy || !dirty || !draft.name?.trim() || !draft.backend_key, onClick: () => void save() }, busy ? '保存中…' : '保存')))
  }
  // Where bots without a chosen workspace keep their own folder.
  function BotsRoot({ data, busy, act }) {
    const [path, setPath] = useState(null)
    const editing = path !== null
    return h('div', { className: 'kode-agent-row kode-bots-root' },
      h('div', { className: 'kode-agent-row-head' },
        h('span', { className: 'kode-agent-name' }, '伙伴空间目录'),
        !editing && h('span', { className: 'kode-secondary' }, data.root),
        !editing && h(Button, { size: 'sm', variant: 'outline', className: 'kode-agent-edit', disabled: busy, onClick: () => setPath(data.root) }, '更改')),
      editing && h('form', { className: 'kode-agent-editor', onSubmit: async event => { event.preventDefault(); const root = path.trim(); if (await act({ action: 'set_root', root: root && root !== data.default_root ? root : null })) setPath(null) } },
        h('label', { className: 'kode-field' }, h('span', null, '没有指定工作区的伙伴，会在这里各有一个文件夹。已有的文件不会自动搬过去。'), h('input', { value: path, disabled: busy, onChange: event => setPath(event.target.value) })),
        h('div', { className: 'kode-settings-footer' },
          h(Button, { type: 'button', variant: 'ghost', disabled: busy, onClick: () => setPath(data.default_root) }, '恢复默认'),
          h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => setPath(null) }, '取消'),
          h(Button, { type: 'submit', variant: 'primary', disabled: busy }, '保存'))))
  }
  // 关注: events that wake a bot into its own run (no timers). Kode matches
  // events and starts the runs; this is where they are set up and reviewed.
