  const BOT_SLUG = /^[A-Za-z0-9_.-]{1,128}$/
  const VALID_CONNECTOR_TYPES = new Set(['wecom', 'webhook', 'github', 'team', 'slack', 'discord', 'linear', 'google', 'mcp'])
  const VALID_TONES = new Set(['colleague', 'direct', 'warm', 'humorous', 'butler', 'custom'])
  const fallbackConnectorName = (type, appId) => typeof connectorMeta === 'function' ? connectorMeta(type, appId).name : type
  /** A proposal from the 创建伙伴 conversation, reduced to what a bot may store. */
  function botProposal(code, agents, catalog = []) {
    let raw
    try { raw = JSON.parse(code) } catch { throw new Error('预览数据不是有效的 JSON，请让对话重新输出伙伴预览卡。') }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('预览数据不完整，请让对话重新输出伙伴预览卡。')
    const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
    const name = text(raw.name, 80)
    if (!name) throw new Error('伙伴预览缺少名字，请让对话补上。')
    const backend = agents.find(agent => agent.backend_key === raw.backend_key) ?? agents[0]
    const banner = typeof raw.banner === 'string' && (raw.banner === 'none' || BOT_BANNER_PRESETS.some(row => row.id === raw.banner) || /^color:#[0-9a-fA-F]{6}$/.test(raw.banner)) ? raw.banner : null
    const tone = typeof raw.tone === 'string' && VALID_TONES.has(raw.tone.trim()) ? raw.tone.trim() : null
    const tone_note = text(raw.tone_note, 400)
    const skills = (Array.isArray(raw.skills) ? raw.skills : []).filter(row => row && BOT_SLUG.test(row.slug) && !row.slug.startsWith('.'))
      .filter((row, index, rows) => rows.findIndex(other => other.slug === row.slug) === index).slice(0, 8)
      .map(row => ({ slug: row.slug, source: 'skillhub', name: text(row.name, 120) ?? row.slug, ...(text(row.description, 400) ? { description: text(row.description, 400) } : {}) }))
    const connectors = (Array.isArray(raw.connectors) ? raw.connectors : []).flatMap(row => {
      const type = typeof row === 'string' ? row.trim() : text(row?.type, 32)
      if (!type || !VALID_CONNECTOR_TYPES.has(type)) return []
      const cfg = typeof row === 'object' && row?.config && typeof row.config === 'object' ? row.config : {}
      return [{ type, name: (typeof row === 'object' && text(row?.name, 64)) || fallbackConnectorName(type, cfg.app_id), config: cfg }]
    }).slice(0, 8)
    return {
      bot: {
        name, tagline: text(raw.tagline, 120), persona: typeof raw.persona === 'string' ? raw.persona.trim().slice(0, 16000) : '',
        ...(tone ? { tone } : {}), ...(tone_note ? { tone_note } : {}),
        backend_key: backend?.backend_key ?? '', model: text(raw.model, 160),
        permission_ceiling: BOT_CEILINGS.some(row => row.value === raw.permission_ceiling) ? raw.permission_ceiling : 'default',
        default_cwd: typeof raw.default_cwd === 'string' && raw.default_cwd.startsWith('/') ? raw.default_cwd : null,
        avatar: typeof raw.avatar === 'string' && /^gallery\/[^/\\\x00]+$/.test(raw.avatar) && !raw.avatar.includes('..') ? raw.avatar : null,
        banner, template: text(raw.template, 64), ...(raw.outbound === 'draft' ? { outbound: 'draft' } : {}),
      },
      skills,
      connectors,
      // Routines name a catalog entry; the time and WeCom chat may differ.
      routines: (Array.isArray(raw.routines) ? raw.routines : []).flatMap(row => {
        const routine = catalog.find(item => item.id === (typeof row === 'string' ? row : row?.id))
        if (!routine) return []
        const cron = typeof row?.cron === 'string' && /^\S+( \S+){4}$/.test(row.cron.trim()) ? row.cron.trim() : routine.cron
        const chat = typeof row?.wecom_chat_id === 'string' && row.wecom_chat_id.trim() ? row.wecom_chat_id.trim().slice(0, 128) : null
        return [{ ...routine, cron, ...(chat ? { wecom_chat_id: chat } : {}) }]
      }).filter((row, index, rows) => rows.findIndex(other => other.id === row.id) === index).slice(0, 6),
      agentMissing: Boolean(raw.backend_key) && backend?.backend_key !== raw.backend_key,
    }
  }
  /** Create a bot, install its skills, routines and connectors, and optionally
   *  kick off its proactive first-meeting greeting session. */
  async function createBot(bot, skills, onProgress, { routines = [], enableRoutines = true, connectors = [], greet = false } = {}) {
    if (!bot.backend_key) throw new Error('这台电脑的 dsh 里还没有可用的 Agent')
    const before = new Set((botsSnapshot.data?.bots ?? (await botsCall()).bots).map(row => row.id))
    const view = await botsCall({ action: 'upsert', bot })
    publishBots({ data: view, error: '' })
    const created = view.bots.find(row => !before.has(row.id))
    if (!created) throw new Error('伙伴已保存，但没能确认它的编号，请到伙伴页查看。')
    const failed = []
    for (const [index, skill] of skills.entries()) {
      onProgress?.(`正在安装技能 ${index + 1}/${skills.length}：${skill.name}`)
      try { publishBots({ data: await botsCall({ action: 'skill_install', id: created.id, source: 'skillhub', slug: skill.slug, name: skill.name, description: skill.description }), error: '' }) }
      catch (failure) { failed.push(`${skill.name}（${failure.message}）`) }
    }
    for (const [index, routine] of routines.entries()) {
      onProgress?.(`正在设置日常节奏 ${index + 1}/${routines.length}：${routine.name}`)
      try { publishWatches({ data: await watchesCall({ action: 'watch_upsert', bot: created.id, enabled: enableRoutines, spec: watchSpec(routineDraft(routine, { post_to_wecom: routine.wecom_chat_id ?? '' })) }), error: '' }) }
      catch (failure) { failed.push(`${routine.name}（${failure.message}）`) }
    }
    for (const [index, connector] of connectors.entries()) {
      const label = connector.name || fallbackConnectorName(connector.type)
      onProgress?.(`正在接入连接器 ${index + 1}/${connectors.length}：${label}`)
      try { publishBots({ data: await botsCall({ action: 'connector_upsert', bot_id: created.id, connector }), error: '' }) }
      catch (failure) { failed.push(`连接器 ${label}（${failure.message}）`) }
    }
    let sessionId = null
    if (greet) {
      onProgress?.(`正在让 ${created.name} 准备向你打招呼…`)
      try {
        const greeted = await botsCall({ action: 'greet', id: created.id, idempotency_key: `bot-greet-${created.id}` })
        sessionId = greeted?.sessionId ?? null
        if (typeof refreshBots === 'function') void refreshBots()
      } catch (failure) {
        failed.push(`自动打招呼（${failure.message}）`)
      }
    }
    return { bot: created, failed, ...(sessionId ? { sessionId } : {}) }
  }
  // One creation per proposal text, however often its message re-renders.
  const proposalRuns = new Map()
  function BotProposalCard({ code, streaming }) {
    const { data } = useBots(), library = useAvatarLibrary(true)
    const [state, setState] = useState(() => proposalRuns.get(code)?.state ?? { phase: 'idle' })
    useEffect(() => {
      const run = proposalRuns.get(code)
      if (!run) return
      run.listeners.add(setState); setState(run.state)
      return () => run.listeners.delete(setState)
    }, [code])
    if (streaming) return h('div', { className: 'kode-bot-proposal is-loading', role: 'status' }, h(IconLoadingOutlineRegular, { size: 16 }), '正在生成伙伴预览…')
    if (!data) return h('div', { className: 'kode-bot-proposal is-loading', role: 'status' }, '正在读取伙伴…')
    let proposal
    try { proposal = botProposal(code, data.agents, data.routines ?? []) } catch (failure) { return h('div', { className: 'kode-bot-proposal' }, h(Failure, { text: failure.message })) }
    const { bot, skills, routines, connectors } = proposal
    const agent = data.agents.find(row => row.backend_key === bot.backend_key)
    const create = () => {
      if (proposalRuns.has(code)) return
      const run = { state: { phase: 'working', note: '正在创建伙伴…' }, listeners: new Set([setState]) }
      const publish = next => { run.state = next; for (const listener of run.listeners) listener(next) }
      proposalRuns.set(code, run); publish(run.state)
      createBot(bot, skills, note => publish({ phase: 'working', note }), { routines, connectors, greet: true })
        .then(result => {
          publish({ phase: 'done', id: result.bot.id, ...(result.sessionId ? { sessionId: result.sessionId } : {}), failed: result.failed })
          if (result.sessionId && typeof openBotChat === 'function') void openBotChat(result.sessionId)
        })
        .catch(failure => { proposalRuns.delete(code); publish({ phase: 'idle', error: failure.message }) })
    }
    const open = () => {
      if (state.sessionId && typeof openBotChat === 'function') { void openBotChat(state.sessionId); return }
      requestedBotProfile = state.id; openBotsPage?.(); window.dispatchEvent(new CustomEvent('kode-bot-profile'))
    }
    return h('div', { className: 'kode-bot-proposal' },
      h(BotNameplate, { bot: { ...bot, skills, connectors, agent_type: agent?.type }, library, agentName: agent?.name ?? bot.backend_key, routines }),
      proposal.agentMissing && h('p', { className: 'kode-config-note' }, `对话里选的 Agent 在这台电脑不可用，改用 ${agent?.name ?? '默认 Agent'}。`),
      state.phase === 'done'
        ? h('div', { className: 'kode-bot-proposal-actions' }, h(Button, { variant: 'primary', onClick: open }, state.sessionId ? '已创建 · 打开对话' : '已创建 · 打开伙伴'), state.failed?.length > 0 && h(Failure, { text: `这些没设置成功，可以在伙伴设置里重试：${state.failed.join('、')}` }))
        : h('div', { className: 'kode-bot-proposal-actions' },
          h(Button, { variant: 'primary', disabled: state.phase === 'working' || !bot.backend_key, onClick: create }, state.phase === 'working' ? state.note : '创建伙伴并打招呼'),
          state.phase !== 'working' && h('span', { className: 'kode-secondary' }, '创建后会自动打开对话，让它先向你自我介绍；想改哪里直接告诉我。')),
      h(Failure, { text: state.error }))
  }
  // Profile card body shared by the roster popover and proposals.
  function BotNameplate({ bot, library, agentName, live = false, routines, children }) {
    const [display] = useBackgroundPreference()
    const banner = display !== 'off' ? botBannerStyle(library, bot) : botBannerStyle(library, { ...bot, avatar: null })
    return h('div', { className: `kode-bot-nameplate${banner ? ' has-banner' : ''}`, style: botBannerVars(banner) },
      h('div', { className: 'kode-bot-nameplate-banner' }),
      h('div', { className: 'kode-bot-nameplate-avatar' }, live ? h(BotAvatar, { bot, size: 72 }) : h(AgentAvatar, { profile: botProfile(bot), host: 'local', size: 72, preview: true })),
      h('div', { className: 'kode-bot-nameplate-body' },
        h('h3', { className: 'kode-bot-nameplate-name' }, bot.name),
        bot.tagline && h('p', { className: 'kode-bot-nameplate-tagline' }, bot.tagline),
        h('div', { className: 'kode-bot-nameplate-tags' },
          h('span', { className: 'kode-agent-tag' }, agentName ?? bot.agent ?? `${bot.backend_key} 不可用`),
          bot.model && h('span', { className: 'kode-agent-tag' }, bot.model),
          h('span', { className: 'kode-agent-tag', title: bot.tone_note || undefined }, `语气 · ${toneMeta(bot.tone).label}`),
          h('span', { className: 'kode-agent-tag' }, ceilingLabel(bot.permission_ceiling)),
          bot.outbound === 'draft' && h('span', { className: 'kode-agent-tag' }, '对外消息先起草')),
        bot.persona && h('section', null, h('h4', null, '关于'), h('p', { className: 'kode-bot-nameplate-about' }, bot.persona)),
        h('section', null, h('h4', null, '技能'), h(BotSkillChips, { skills: bot.skills })),
        bot.connectors?.length > 0 && h('section', null, h('h4', null, '连接器'), h(BotConnectorChips, { connectors: bot.connectors })),
        routines?.length > 0 && h('section', null, h('h4', null, '日常节奏'), h('ul', { className: 'kode-bot-routine-list' }, ...routines.map(routine => h('li', { key: routine.id }, h('strong', null, routine.name), h('span', { className: 'kode-secondary' }, ` ${cronLabel(routine.cron)}${routine.wecom_chat_id ? ` · 同步到企微 ${routine.wecom_chat_id}` : ''}`))))),
        children))
  }
  // The roster as a row of avatars; the selected one shows its profile card.
  function BotsRail({ bots, selected, defaultBot, unseen, onSelect, onHover, onHoverEnd, onCreate }) {
    return h('div', { className: 'kode-bot-rail', role: 'toolbar', 'aria-label': '我的伙伴' },
      ...bots.map(bot => h('button', { key: bot.id, type: 'button', className: 'kode-bot-rail-item', 'aria-pressed': selected === bot.id, title: bot.tagline ? `${bot.name} · ${bot.tagline}` : bot.name, onMouseEnter: event => onHover?.(bot.id, event.currentTarget), onMouseLeave: () => onHoverEnd?.(), onClick: event => onSelect(selected === bot.id ? null : bot.id, event.currentTarget) },
        h('span', { className: 'kode-bot-rail-pill', 'aria-hidden': true }),
        h('span', { className: 'kode-bot-rail-avatar' }, h(BotAvatar, { bot, size: 56 }),
          defaultBot === bot.id && h('span', { className: 'kode-bot-rail-star', title: '默认伙伴' }, '★'),
          unseen?.[bot.id] > 0 && h('span', { className: 'kode-bot-badge' }, unseen[bot.id] > 99 ? '99+' : unseen[bot.id])),
        h('span', { className: 'kode-bot-rail-name' }, bot.name))),
      h('button', { type: 'button', className: 'kode-bot-rail-item kode-bot-rail-add', title: '新建伙伴', onClick: onCreate },
        h('span', { className: 'kode-bot-rail-avatar' }, h(IconPlusOutlineRegular, { size: 24 })),
        h('span', { className: 'kode-bot-rail-name' }, '新建')))
  }
  function BotProfilePopover({ bot, data, anchor, busy, floatingStyle = null, onMouseEnter, onMouseLeave, onMessage, onConnectors, onBoard, onEdit, onClose }) {
    const library = useAvatarLibrary(Boolean(bot.avatar)), ref = React.useRef(null)
    useEffect(() => {
      const away = event => { if (ref.current && !ref.current.contains(event.target) && !event.target.closest?.('.kode-bot-rail-item, .kode-bot-line')) onClose() }
      const key = event => { if (event.key === 'Escape') onClose() }
      document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
      return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
    }, [onClose])
    const watchData = useWatches().data
    const watches = watchData?.watches.filter(row => row.bot === bot.id && row.enabled).length ?? 0
    const open = watchData?.tasks?.filter(task => task.bot === bot.id && task.kind === 'task' && !task.closed).length ?? 0
    const conns = (bot.connectors ?? []).filter(row => row.enabled !== false).length
    return h('div', {
      ref,
      className: `kode-bot-popover${floatingStyle ? ' is-floating' : ''}`,
      role: 'dialog',
      'aria-label': `${bot.name} 的资料`,
      style: floatingStyle ?? { '--kode-bot-anchor': `${anchor ?? 48}px` },
      onMouseEnter,
      onMouseLeave,
    },
      h('div', { role: 'button', tabIndex: 0, className: 'kode-bot-popover-edit', title: '点击编辑资料', onClick: onEdit, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit() } } },
        h(BotNameplate, { bot, library, live: true },
          h('p', { className: 'kode-secondary' }, `${data.default_bot === bot.id ? '默认伙伴 · ' : ''}${conns ? `已接 ${conns} 个连接器 · ` : ''}${open ? `跟踪 ${open} 个任务 · ` : ''}${watches ? `关注与定时 ${watches} 项 · ` : ''}${bot.sessions?.length ?? 0} 个会话`))),
      h('div', { className: 'kode-bot-popover-actions' },
        h(Button, { variant: 'primary', disabled: busy || !bot.agent, onClick: onMessage }, bot.main_session_id ? '继续对话' : '开始对话'),
        h(Button, { variant: 'outline', disabled: busy, onClick: onBoard }, '看板'),
        h(Button, { variant: 'outline', disabled: busy, onClick: onConnectors }, '连接器'),
        h(Button, { variant: 'ghost', disabled: busy, onClick: onEdit }, h(IconEditOutlineRegular, { size: 14 }), '设置')))
  }
  // Orca-style quick scratch creator (mirrors NewBotDialog + BotTemplatesDialog prefill):
  // top soft color band, name, one-sentence purpose, agent + model + permissions,
  // connectors & popular MCP apps → instant proactive greeting!
  function BotQuickCreateForm({ data, busy, initialTemplate = null, onSubmit, onCancel }) {
    const [name, setName] = useState(() => initialTemplate?.name ?? '')
    const [tagline, setTagline] = useState(() => initialTemplate?.tagline ?? '')
    const [persona, setPersona] = useState(() => initialTemplate?.persona ?? '')
    const [tone, setTone] = useState(() => initialTemplate?.tone ?? 'colleague')
    const [toneNote, setToneNote] = useState('')
    const [backendKey, setBackendKey] = useState(() => data.agents[0]?.backend_key ?? '')
    const [model, setModel] = useState(null)
    const [ceiling, setCeiling] = useState(() => initialTemplate?.permission_ceiling ?? 'default')
    const [banner, setBanner] = useState(() => initialTemplate?.banner ?? 'preset:blurple')
    const [workspace, setWorkspace] = useState('')
    const [selectedConnectors, setSelectedConnectors] = useState([])
    const [selectedApps, setSelectedApps] = useState([])
    const [selectedRoutines, setSelectedRoutines] = useState(() => initialTemplate?.routines ?? [])
    useEffect(() => {
      if (!initialTemplate) return
      setName(initialTemplate.name ?? '')
      setTagline(initialTemplate.tagline ?? '')
      setPersona(initialTemplate.persona ?? '')
      setTone(initialTemplate.tone ?? 'colleague')
      setToneNote('')
      setCeiling(initialTemplate.permission_ceiling ?? 'default')
      setBanner(initialTemplate.banner ?? 'preset:blurple')
      setSelectedRoutines(initialTemplate.routines ?? [])
    }, [initialTemplate?.id])
    const toggleItem = (list, setList, value) => setList(list.includes(value) ? list.filter(item => item !== value) : [...list, value])
    const bannerCss = BOT_BANNER_PRESETS.find(row => row.id === banner)?.css
    const mcpCatalog = data.mcp_app_catalog?.length ? data.mcp_app_catalog : DEFAULT_MCP_APPS
    const popularApps = mcpCatalog.filter(app => ['notion', 'sentry', 'vercel', 'atlassian', 'supabase', 'context7'].includes(app.id))
    const submit = event => {
      event.preventDefault()
      if (!name.trim() || !backendKey) return
      const cleanName = name.trim().slice(0, 80)
      const cleanTagline = tagline.trim().slice(0, 120) || null
      const builtPersona = persona.trim() || `你是「${cleanName}」${cleanTagline ? `，职责是：${cleanTagline}` : ''}。你会通过看板管理任务，清晰简洁地向用户汇报进展，并在遇到重要决策或风险时主动询问用户。`
      const directConnectors = selectedConnectors.map(type => ({
        type,
        name: connectorMeta(type).name,
        config: type === 'github' && workspace ? { workspace, watch_commits: true } : {},
      }))
      const appConnectors = selectedApps.map(appId => {
        const app = mcpCatalog.find(row => row.id === appId)
        return { type: 'mcp', name: app?.name ?? appId, config: { app_id: appId } }
      })
      const routines = selectedRoutines.map(id => (data.routines ?? []).find(row => row.id === id)).filter(Boolean)
      void onSubmit({
        bot: {
          name: cleanName,
          tagline: cleanTagline,
          persona: builtPersona,
          tone,
          tone_note: toneNote.trim().slice(0, 400),
          backend_key: backendKey,
          model,
          permission_ceiling: ceiling,
          default_cwd: workspace || null,
          avatar: null,
          banner,
          ...(initialTemplate?.id ? { template: initialTemplate.id } : {}),
          ...(initialTemplate?.outbound === 'draft' ? { outbound: 'draft' } : {}),
        },
        skills: initialTemplate?.skills ?? [],
        connectors: [...directConnectors, ...appConnectors],
        routines,
      })
    }
    return h('form', { className: 'kode-agent-editor kode-bot-quick-create', onSubmit: submit },
      h('div', { className: 'kode-bot-quick-create-band', style: bannerCss ? { '--kode-bot-scene': bannerCss } : undefined },
        h('span', { className: 'kode-bot-quick-create-badge' }, initialTemplate?.glyph || (name.trim().slice(0, 1) || '✦')),
        h('button', { type: 'button', className: 'kode-task-remove', title: '关闭', disabled: busy, onClick: onCancel }, '×')),
      h('div', { className: 'kode-bot-quick-create-head' },
        h('div', null,
          h('h4', null, initialTemplate ? `基于「${initialTemplate.name}」配置伙伴` : '快速创建伙伴'),
          h('p', { className: 'kode-secondary' }, '起个名字、选好说话风格和连接器，创建后伙伴会立刻以自然口吻向你打招呼。'))),
      h('div', { className: 'kode-watch-grid' },
        h('label', { className: 'kode-field' },
          h('span', null, '名字'),
          h('input', { required: true, autoFocus: true, maxLength: 80, value: name, disabled: busy, placeholder: '例如：大管家、值班助手、PR 审校员', onChange: event => setName(event.target.value) })),
        h('label', { className: 'kode-field' },
          h('span', null, '一句话定位（可选）'),
          h('input', { maxLength: 120, value: tagline, disabled: busy, placeholder: '例如：帮我盯项目进度、整理周报和回复群消息', onChange: event => setTagline(event.target.value) }))),
      h('div', { className: 'kode-field' },
        h('span', null, '语气风格（告别“人机味”）'),
        h(BotTonePicker, { tone, toneNote, presets: data.tone_presets, disabled: busy, compact: true, onChange: next => { setTone(next.tone); setToneNote(next.tone_note) } })),
      h('div', { className: 'kode-watch-grid' },
        h(SelectField, { label: '运行 Agent', value: backendKey, options: data.agents.map(row => ({ value: row.backend_key, label: row.name })), disabled: busy, onChange: value => { setBackendKey(value); setModel(null) } }),
        h(SelectField, { label: '权限上限', value: ceiling, options: BOT_CEILINGS, disabled: busy, onChange: setCeiling })),
      h(BotModelPicker, { profileId: data.agents.find(agent => agent.backend_key === backendKey)?.profile_id, model, disabled: busy, onChange: value => setModel(value || null) }),
      data.workspaces?.length > 0 && h(SelectField, {
        label: '默认工作区',
        value: workspace,
        options: [{ value: '', label: '伙伴自己的空间（推荐，自动隔离记忆与技能）' }, ...data.workspaces.map(row => ({ value: row.path, label: row.title }))],
        disabled: busy,
        onChange: setWorkspace,
      }),
      h('div', { className: 'kode-field' },
        h('span', null, '横幅风格'),
        h('div', { className: 'kode-bot-banner-picker' }, ...BOT_BANNER_PRESETS.slice(0, 6).map(preset =>
          h('button', { key: preset.id, type: 'button', className: 'kode-banner-chip', 'aria-pressed': banner === preset.id, disabled: busy, onClick: () => setBanner(preset.id) }, preset.label)))),
      h('div', { className: 'kode-field' },
        h('span', null, '预接渠道连接器（可选，创建后可在「连接器」里添加 19+ MCP 应用与细调）'),
        h('div', { className: 'kode-connector-quick-picks' }, ...CONNECTOR_TYPES.filter(item => item.type !== 'mcp').map(item =>
          h('button', {
            key: item.type,
            type: 'button',
            className: 'kode-banner-chip kode-connector-pick-chip',
            'aria-pressed': selectedConnectors.includes(item.type),
            disabled: busy,
            title: item.summary,
            onClick: () => toggleItem(selectedConnectors, setSelectedConnectors, item.type),
          }, h(ConnectorIcon, { type: item.type, size: 17, compact: true }), item.name)))),
      popularApps.length > 0 && h('div', { className: 'kode-field' },
        h('span', null, '常用官方 MCP 应用（可选）'),
        h('div', { className: 'kode-connector-quick-picks' }, ...popularApps.map(app =>
          h('button', {
            key: app.id,
            type: 'button',
            className: 'kode-banner-chip kode-connector-pick-chip',
            'aria-pressed': selectedApps.includes(app.id),
            disabled: busy,
            title: app.summary,
            onClick: () => toggleItem(selectedApps, setSelectedApps, app.id),
          }, h(ConnectorIcon, { type: 'mcp', appId: app.id, size: 17, compact: true }), app.name)))),
      data.routines?.length > 0 && h('div', { className: 'kode-field' },
        h('span', null, '日常节奏（可选）'),
        h('div', { className: 'kode-bot-banner-picker' }, ...data.routines.map(routine =>
          h('button', {
            key: routine.id,
            type: 'button',
            className: 'kode-banner-chip',
            'aria-pressed': selectedRoutines.includes(routine.id),
            disabled: busy,
            title: routine.summary,
            onClick: () => toggleItem(selectedRoutines, setSelectedRoutines, routine.id),
          }, `${routine.name}（${routine.when}）`)))),
      h('label', { className: 'kode-field' },
        h('span', null, '更多角色要求（可选，不填也能在首轮对话里慢慢聊）'),
        h('textarea', { rows: 2, value: persona, disabled: busy, placeholder: '例如：回复尽量精炼，先给结论再给细节；改代码前先提方案…', onChange: event => setPersona(event.target.value) })),
      h('div', { className: 'kode-settings-footer' },
        h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
        h(Button, { type: 'submit', variant: 'primary', disabled: busy || !name.trim() || !backendKey }, busy ? '创建中…' : '创建并让它打招呼')))
  }
  function BotTemplates({ templates, routines = [], busy, onBuild, onConfigure, onUse }) {
    if (!templates?.length) return null
    return h('section', { className: 'kode-bots-section' },
      h('h3', { className: 'kode-bots-section-title' }, '推荐伙伴模板'),
      h('p', { className: 'kode-secondary' }, '可点「配置创建」预填表单并挑选连接器，或「对话定制」慢慢聊；点「直接使用」会立刻创建并打招呼。'),
      h('ul', { className: 'kode-bot-templates' }, ...templates.map(template => {
        const css = BOT_BANNER_PRESETS.find(row => row.id === template.banner)?.css
        return h('li', { key: template.id, className: 'kode-bot-template', style: css ? { '--kode-bot-scene': css } : undefined },
          h('div', { className: 'kode-bot-template-banner' }),
          h('span', { className: 'kode-bot-template-glyph', 'aria-hidden': true }, template.glyph ?? template.name.slice(0, 1)),
          h('div', { className: 'kode-bot-template-body' },
            h('span', { className: 'kode-agent-name' }, template.name),
            h('span', { className: 'kode-secondary kode-bot-template-tagline' }, template.tagline),
            h(BotSkillChips, { skills: template.skills, empty: '' }),
            template.routines?.length > 0 && h('span', { className: 'kode-secondary kode-bot-template-routines' }, `日常节奏：${template.routines.map(id => routines.find(row => row.id === id)?.name).filter(Boolean).join('、')}`)),
          h('div', { className: 'kode-bot-template-actions' },
            h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => onConfigure(template) }, '配置创建'),
            h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => onBuild(template) }, '对话定制'),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => onUse(template) }, '直接使用')))
      })))
  }
  function KodeBotsPage({ ui, leave }) {
    const { data, error: loadError } = useBots(), watchState = useWatches()
    const openSession = async id => { leave?.(); await ui()?.openSession(id) }
    const [selected, setSelected] = useState(null), [hovered, setHovered] = useState(null), [anchor, setAnchor] = useState(null), [settings, setSettings] = useState(null)
    const [quickCreate, setQuickCreate] = useState(false), [quickTemplate, setQuickTemplate] = useState(null)
    const [starting, setStarting] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
    const rosterRef = React.useRef(null)
    const railHoverOpen = React.useRef(null), railHoverClose = React.useRef(null)
    const clearRailTimers = () => {
      if (railHoverOpen.current) { clearTimeout(railHoverOpen.current); railHoverOpen.current = null }
      if (railHoverClose.current) { clearTimeout(railHoverClose.current); railHoverClose.current = null }
    }
    useEffect(() => () => clearRailTimers(), [])
    const bot = id => data?.bots.find(row => row.id === id)
    // Requests from elsewhere: a session header opens a bot's settings, the
    // sidebar badge its 关注, a created proposal its profile card.
    useEffect(() => {
      if (!data) return
      const take = () => {
        if (requestedBotEdit && bot(requestedBotEdit)) setSettings({ id: requestedBotEdit, tab: 'profile' })
        if (requestedBotWatches && bot(requestedBotWatches)) setSettings({ id: requestedBotWatches, tab: 'watches' })
        if (requestedBotConnectors && bot(requestedBotConnectors)) setSettings({ id: requestedBotConnectors, tab: 'connectors' })
        if (requestedBotTasks && bot(requestedBotTasks)) setSettings({ id: requestedBotTasks, tab: 'tasks' })
        if (requestedBotProfile && bot(requestedBotProfile)) { setSelected(requestedBotProfile); setAnchor(null) }
        requestedBotEdit = requestedBotWatches = requestedBotProfile = requestedBotConnectors = requestedBotTasks = undefined
      }
      take()
      const events = ['kode-bot-edit', 'kode-bot-watches', 'kode-bot-profile', 'kode-bot-connectors', 'kode-bot-tasks']
      for (const name of events) window.addEventListener(name, take)
      return () => { for (const name of events) window.removeEventListener(name, take) }
    }, [data])
    const task = async (label, work) => {
      if (busy) return
      setBusy(label); setError('')
      try { return await work() } catch (failure) { setError(failure.message) } finally { setBusy('') }
    }
    const message = async target => {
      if (target.main_session_id) { await openSession(target.main_session_id); return }
      // First chat with a newly configured bot without an active session: let it greet proactively!
      const greeted = await task('greet', async () => {
        const result = await botsCall({ action: 'greet', id: target.id, idempotency_key: `bot-greet-${target.id}-${Date.now()}` })
        void refreshBots()
        return result
      })
      if (greeted?.sessionId) { await openSession(greeted.sessionId); return }
      setStarting({ bot: target, message: '', workspace: target.workspace ?? '', key: `bot-${target.id}-${Date.now()}` })
    }
    const start = () => task('start', async () => {
      const result = await botsCall({ action: 'start', id: starting.bot.id, message: starting.message, workspace: starting.workspace, idempotency_key: starting.key })
      setStarting(null); void refreshBots()
      await openSession(result.sessionId)
    })
    const build = template => task('builder', async () => {
      const result = await botsCall({ action: 'builder', ...(template ? { template: template.id } : {}), idempotency_key: `bot-builder-${template?.id ?? 'blank'}-${Date.now()}` })
      await openSession(result.sessionId)
    })
    const quickSave = ({ bot: draftBot, skills = [], connectors, routines }) => task('quick', async () => {
      const result = await createBot(draftBot, skills, note => setBusy(note), { routines, enableRoutines: true, connectors, greet: true })
      setQuickCreate(false); setQuickTemplate(null); setSelected(result.bot.id); setAnchor(null)
      if (result.failed.length) setError(`伙伴已创建，这些没设置成功，可以在伙伴设置里重试：${result.failed.join('、')}`)
      if (result.sessionId) await openSession(result.sessionId)
    })
    const openQuickForm = (template = null) => {
      setQuickTemplate(template)
      setQuickCreate(true)
      setSelected(null)
      setStarting(null)
      requestAnimationFrame(() => rosterRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }))
    }
    // The sidebar can request a conversation or the creation form while this page is already open.
    useEffect(() => {
      if (!data) return
      const take = () => {
        if (busy || requestedBotStart === undefined) return
        const id = requestedBotStart
        requestedBotStart = undefined
        setSettings(null)
        if (id === null) openQuickForm()
        else {
          const wanted = bot(id)
          if (wanted) void message(wanted)
        }
      }
      take()
      window.addEventListener('kode-bot-start', take)
      return () => window.removeEventListener('kode-bot-start', take)
    }, [data, busy])
    if (!data) return h('div', { className: 'kode-agent-settings kode-bots-page' }, h('h2', null, '伙伴'), !loadError && h('p', { className: 'kode-secondary', role: 'status' }, '正在读取伙伴…'), h(Failure, { text: loadError }))
    const use = template => task('template', async () => {
      const { id, glyph, skills, routines: wanted = [], outbound, tone, ...fields } = template
      const routines = wanted.map(key => (data.routines ?? []).find(row => row.id === key)).filter(Boolean)
      // Used as is, a template's routines wait until the user turns them on; the bot greets you immediately.
      const result = await createBot({ ...fields, template: id, backend_key: data.agents[0]?.backend_key ?? '', model: null, default_cwd: null, avatar: null, ...(tone ? { tone } : {}), ...(outbound === 'draft' ? { outbound } : {}) }, skills ?? [], note => setBusy(note), { routines, enableRoutines: false, greet: true })
      setSelected(result.bot.id); setAnchor(null)
      if (result.failed.length) setError(`伙伴已创建，这些没设置成功，可以在伙伴设置里重试：${result.failed.join('、')}`)
      else if (routines.length) setNotice(`伙伴已创建。${routines.map(row => row.name).join('、')} 已建好但先暂停，到伙伴设置 → 关注与定时里打开。`)
      if (result.sessionId) await openSession(result.sessionId)
    })
    const activeBotId = selected ?? hovered
    const selectedBot = bot(activeBotId), settingsBot = settings && bot(settings.id)
    const scheduleRailHover = (id, element) => {
      if (selected || starting || quickCreate) return
      if (railHoverClose.current) { clearTimeout(railHoverClose.current); railHoverClose.current = null }
      const nextAnchor = element ? element.offsetLeft + element.offsetWidth / 2 : null
      if (hovered === id) { setAnchor(nextAnchor); return }
      if (railHoverOpen.current) clearTimeout(railHoverOpen.current)
      railHoverOpen.current = setTimeout(() => {
        railHoverOpen.current = null
        setHovered(id)
        setAnchor(nextAnchor)
      }, hovered ? 60 : 120)
    }
    const scheduleRailLeave = () => {
      if (railHoverOpen.current) { clearTimeout(railHoverOpen.current); railHoverOpen.current = null }
      if (selected) return
      if (railHoverClose.current) clearTimeout(railHoverClose.current)
      railHoverClose.current = setTimeout(() => {
        railHoverClose.current = null
        setHovered(null)
      }, 220)
    }
    if (settingsBot) return h(BotSettingsPage, { key: settingsBot.id, bot: settingsBot, data, initialTab: settings.tab, ui: () => ({ openSession: id => { setSettings(null); return openSession(id) } }), onClose: () => setSettings(null), onDeleted: () => { setSelected(null); setHovered(null) } })
    return h('div', { className: 'kode-agent-settings kode-bots-page' },
      h('header', { className: 'kode-bots-hero' },
        h('div', { className: 'kode-bots-hero-row' },
          h('div', null,
            h('h2', null, '伙伴'),
            h('p', { className: 'kode-agent-intro' }, '有名字、角色、连接器和专属看板的长期助手。悬停或点头像看资料，配好后会立刻向你打招呼。')),
          h('div', { className: 'kode-bots-hero-actions' },
            h(Button, { variant: 'outline', disabled: Boolean(busy) || !data.agents.length, onClick: () => { if (quickCreate && !quickTemplate) { setQuickCreate(false) } else { openQuickForm(null) } } }, h(IconPlusOutlineRegular, { size: 15 }), '快速创建'),
            h(Button, { variant: 'primary', disabled: Boolean(busy) || !data.agents.length, onClick: () => void build(null) }, busy === 'builder' ? '正在打开…' : '对话定制')))),
      h('section', { ref: rosterRef, className: 'kode-bots-section kode-bots-roster' },
        h('h3', { className: 'kode-bots-section-title' }, `我的伙伴${data.bots.length ? ` · ${data.bots.length}` : ''}`),
        h(BotsRail, { bots: data.bots, selected: activeBotId, defaultBot: data.default_bot, unseen: Object.fromEntries(data.bots.map(bot => [bot.id, (watchState.data?.unseen?.[bot.id] ?? 0) + inboxItems(watchState.data).filter(item => item.bot === bot.id).length])), onHover: scheduleRailHover, onHoverEnd: scheduleRailLeave, onSelect: (id, element) => { clearRailTimers(); setHovered(null); setSelected(selected === id ? null : id); setStarting(null); setQuickCreate(false); setQuickTemplate(null); setAnchor(element ? element.offsetLeft + element.offsetWidth / 2 : null) }, onCreate: () => { clearRailTimers(); setHovered(null); openQuickForm(null) } }),
        !data.bots.length && !quickCreate && h('p', { className: 'kode-secondary' }, '还没有伙伴。可以点右上角「快速创建」直接上手，或从下面的模板与「对话定制」开始。'),
        quickCreate && h(BotQuickCreateForm, { key: quickTemplate?.id ?? 'blank', data, busy: Boolean(busy), initialTemplate: quickTemplate, onSubmit: quickSave, onCancel: () => { setQuickCreate(false); setQuickTemplate(null) } }),
        selectedBot && h(BotProfilePopover, {
          bot: selectedBot,
          data,
          anchor,
          busy: Boolean(busy),
          onMouseEnter: () => { if (railHoverClose.current) { clearTimeout(railHoverClose.current); railHoverClose.current = null } },
          onMouseLeave: scheduleRailLeave,
          onClose: () => { clearRailTimers(); setSelected(null); setHovered(null) },
          onMessage: () => void message(selectedBot),
          onBoard: () => { clearRailTimers(); setHovered(null); setSettings({ id: selectedBot.id, tab: 'tasks' }) },
          onConnectors: () => { clearRailTimers(); setHovered(null); setSettings({ id: selectedBot.id, tab: 'connectors' }) },
          onEdit: () => { clearRailTimers(); setHovered(null); setSettings({ id: selectedBot.id, tab: 'profile' }) },
        }),
        starting && h('form', { className: 'kode-agent-editor kode-bot-start', onSubmit: event => { event.preventDefault(); void start() } },
          h(SelectField, { label: '工作区', value: starting.workspace, options: [{ value: starting.bot.workspace, label: starting.bot.default_cwd ? data.workspaces.find(row => row.path === starting.bot.workspace)?.title ?? starting.bot.workspace : `伙伴自己的空间（${starting.bot.workspace}）` }, ...data.workspaces.filter(row => row.path !== starting.bot.workspace).map(row => ({ value: row.path, label: row.title }))], disabled: Boolean(busy), onChange: value => setStarting({ ...starting, workspace: value }) }),
          h('label', { className: 'kode-field' }, h('span', null, `对 ${starting.bot.name} 说`), h('textarea', { rows: 3, required: true, autoFocus: true, value: starting.message, disabled: Boolean(busy), onChange: event => setStarting({ ...starting, message: event.target.value }) })),
          h('div', { className: 'kode-settings-footer' }, h(Button, { type: 'button', disabled: Boolean(busy), onClick: () => setStarting(null) }, '取消'), h(Button, { type: 'submit', variant: 'primary', disabled: Boolean(busy) || !starting.message.trim() || !starting.workspace }, '发送')))),
      h(BotsKanbanBoard, { data, ui: () => ({ openSession }) }),
      h(BotTemplates, { templates: data.templates, routines: data.routines ?? [], busy: Boolean(busy) || !data.agents.length, onConfigure: template => openQuickForm(template), onBuild: template => void build(template), onUse: template => void use(template) }),
      h('section', { className: 'kode-bots-section kode-bot-create' },
        h('span', { className: 'kode-bot-create-icon', 'aria-hidden': true }, h(IconPlusOutlineRegular, { size: 28 })),
        h('div', { className: 'kode-bot-create-text' },
          h('h3', null, '对话引导创建伙伴'),
          h('p', { className: 'kode-secondary' }, '说说你想要什么样的伙伴，对话会一步步帮你选好名字、形象、Agent、权限、技能和连接器，确认后它会立刻向你打招呼。')),
        h(Button, { variant: 'primary', disabled: Boolean(busy) || !data.agents.length, onClick: () => void build(null) }, busy === 'builder' ? '正在打开…' : '开始对话')),
      !data.agents.length && h('p', { className: 'kode-config-note' }, '这台电脑的 dsh 里还没有可用的 Agent。'),
      busy && !['builder', 'start'].includes(busy) && h('p', { className: 'kode-config-note', role: 'status' }, busy === 'template' ? '正在创建伙伴…' : busy === 'greet' ? '正在唤醒伙伴向你打招呼…' : busy === 'quick' ? '正在创建伙伴…' : busy),
      notice && h('p', { className: 'kode-config-note', role: 'status' }, notice),
      h(Failure, { text: error }),
      h(AdvancedSection, { title: '伙伴设置' }, h(BotQuietHours, { data }), h(WeComBridgeCard), h(BotsRoot, { data, busy: Boolean(busy), act: async body => { const value = await task('root', () => botsCall(body)); if (value) publishBots({ data: value, error: '' }); return value } })))
  }
