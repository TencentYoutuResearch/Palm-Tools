  const BOT_SLUG = /^[A-Za-z0-9_.-]{1,128}$/
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
    const skills = (Array.isArray(raw.skills) ? raw.skills : []).filter(row => row && BOT_SLUG.test(row.slug) && !row.slug.startsWith('.'))
      .filter((row, index, rows) => rows.findIndex(other => other.slug === row.slug) === index).slice(0, 8)
      .map(row => ({ slug: row.slug, source: 'skillhub', name: text(row.name, 120) ?? row.slug, ...(text(row.description, 400) ? { description: text(row.description, 400) } : {}) }))
    return {
      bot: {
        name, tagline: text(raw.tagline, 120), persona: typeof raw.persona === 'string' ? raw.persona.trim().slice(0, 16000) : '',
        backend_key: backend?.backend_key ?? '', model: text(raw.model, 160),
        permission_ceiling: BOT_CEILINGS.some(row => row.value === raw.permission_ceiling) ? raw.permission_ceiling : 'default',
        default_cwd: typeof raw.default_cwd === 'string' && raw.default_cwd.startsWith('/') ? raw.default_cwd : null,
        avatar: typeof raw.avatar === 'string' && /^gallery\/[^/\\\x00]+$/.test(raw.avatar) && !raw.avatar.includes('..') ? raw.avatar : null,
        banner, template: text(raw.template, 64), ...(raw.outbound === 'draft' ? { outbound: 'draft' } : {}),
      },
      skills,
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
  /** Create a bot, then install its skills and set up its routines one by
   *  one. A step that fails leaves the bot in place; it can be redone from
   *  its settings. Routines start paused unless `enableRoutines`. */
  async function createBot(bot, skills, onProgress, { routines = [], enableRoutines = true } = {}) {
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
    return { bot: created, failed }
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
    const { bot, skills, routines } = proposal
    const agent = data.agents.find(row => row.backend_key === bot.backend_key)
    const create = () => {
      if (proposalRuns.has(code)) return
      const run = { state: { phase: 'working', note: '正在创建伙伴…' }, listeners: new Set([setState]) }
      const publish = next => { run.state = next; for (const listener of run.listeners) listener(next) }
      proposalRuns.set(code, run); publish(run.state)
      createBot(bot, skills, note => publish({ phase: 'working', note }), { routines })
        .then(result => publish({ phase: 'done', id: result.bot.id, failed: result.failed }))
        .catch(failure => { proposalRuns.delete(code); publish({ phase: 'idle', error: failure.message }) })
    }
    const open = () => { requestedBotProfile = state.id; openBotsPage?.(); window.dispatchEvent(new CustomEvent('kode-bot-profile')) }
    return h('div', { className: 'kode-bot-proposal' },
      h(BotNameplate, { bot: { ...bot, skills, agent_type: agent?.type }, library, agentName: agent?.name ?? bot.backend_key, routines }),
      proposal.agentMissing && h('p', { className: 'kode-config-note' }, `对话里选的 Agent 在这台电脑不可用，改用 ${agent?.name ?? '默认 Agent'}。`),
      state.phase === 'done'
        ? h('div', { className: 'kode-bot-proposal-actions' }, h(Button, { variant: 'primary', onClick: open }, '已创建 · 打开伙伴'), state.failed?.length > 0 && h(Failure, { text: `这些没设置成功，可以在伙伴设置里重试：${state.failed.join('、')}` }))
        : h('div', { className: 'kode-bot-proposal-actions' },
          h(Button, { variant: 'primary', disabled: state.phase === 'working' || !bot.backend_key, onClick: create }, state.phase === 'working' ? state.note : '创建伙伴'),
          state.phase !== 'working' && h('span', { className: 'kode-secondary' }, '想改哪里直接告诉我，会重新生成预览。')),
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
          h('span', { className: 'kode-agent-tag' }, ceilingLabel(bot.permission_ceiling)),
          bot.outbound === 'draft' && h('span', { className: 'kode-agent-tag' }, '对外消息先起草')),
        bot.persona && h('section', null, h('h4', null, '关于'), h('p', { className: 'kode-bot-nameplate-about' }, bot.persona)),
        h('section', null, h('h4', null, '技能'), h(BotSkillChips, { skills: bot.skills })),
        routines?.length > 0 && h('section', null, h('h4', null, '日常节奏'), h('ul', { className: 'kode-bot-routine-list' }, ...routines.map(routine => h('li', { key: routine.id }, h('strong', null, routine.name), h('span', { className: 'kode-secondary' }, ` ${cronLabel(routine.cron)}${routine.wecom_chat_id ? ` · 同步到企微 ${routine.wecom_chat_id}` : ''}`))))),
        children))
  }
  // The roster as a row of avatars; the selected one shows its profile card.
  function BotsRail({ bots, selected, defaultBot, unseen, onSelect, onCreate }) {
    return h('div', { className: 'kode-bot-rail', role: 'toolbar', 'aria-label': '我的伙伴' },
      ...bots.map(bot => h('button', { key: bot.id, type: 'button', className: 'kode-bot-rail-item', 'aria-pressed': selected === bot.id, title: bot.tagline ? `${bot.name} · ${bot.tagline}` : bot.name, onClick: event => onSelect(selected === bot.id ? null : bot.id, event.currentTarget) },
        h('span', { className: 'kode-bot-rail-pill', 'aria-hidden': true }),
        h('span', { className: 'kode-bot-rail-avatar' }, h(BotAvatar, { bot, size: 56 }),
          defaultBot === bot.id && h('span', { className: 'kode-bot-rail-star', title: '默认伙伴' }, '★'),
          unseen?.[bot.id] > 0 && h('span', { className: 'kode-bot-badge' }, unseen[bot.id] > 99 ? '99+' : unseen[bot.id])),
        h('span', { className: 'kode-bot-rail-name' }, bot.name))),
      h('button', { type: 'button', className: 'kode-bot-rail-item kode-bot-rail-add', title: '创建伙伴', onClick: onCreate },
        h('span', { className: 'kode-bot-rail-avatar' }, h(IconPlusOutlineRegular, { size: 24 })),
        h('span', { className: 'kode-bot-rail-name' }, '创建')))
  }
  function BotProfilePopover({ bot, data, anchor, busy, onMessage, onEdit, onClose }) {
    const library = useAvatarLibrary(Boolean(bot.avatar)), ref = React.useRef(null)
    useEffect(() => {
      const away = event => { if (ref.current && !ref.current.contains(event.target) && !event.target.closest?.('.kode-bot-rail-item')) onClose() }
      const key = event => { if (event.key === 'Escape') onClose() }
      document.addEventListener('mousedown', away); document.addEventListener('keydown', key)
      return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key) }
    }, [onClose])
    const watchData = useWatches().data
    const watches = watchData?.watches.filter(row => row.bot === bot.id && row.enabled).length ?? 0
    const open = watchData?.tasks?.filter(task => task.bot === bot.id && task.kind === 'task' && !task.closed).length ?? 0
    return h('div', { ref, className: 'kode-bot-popover', role: 'dialog', 'aria-label': `${bot.name} 的资料`, style: { '--kode-bot-anchor': `${anchor ?? 48}px` } },
      h('div', { role: 'button', tabIndex: 0, className: 'kode-bot-popover-edit', title: '点击编辑资料', onClick: onEdit, onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit() } } },
        h(BotNameplate, { bot, library, live: true },
          h('p', { className: 'kode-secondary' }, `${data.default_bot === bot.id ? '默认伙伴 · ' : ''}${open ? `跟踪 ${open} 个任务 · ` : ''}${watches ? `关注与定时 ${watches} 项 · ` : ''}${bot.sessions?.length ?? 0} 个会话`))),
      h('div', { className: 'kode-bot-popover-actions' },
        h(Button, { variant: 'primary', disabled: busy || !bot.agent, onClick: onMessage }, bot.main_session_id ? '继续对话' : '发消息'),
        h(Button, { variant: 'outline', disabled: busy, onClick: onEdit }, h(IconEditOutlineRegular, { size: 14 }), '编辑资料')))
  }
  function BotTemplates({ templates, routines = [], busy, onBuild, onUse }) {
    if (!templates?.length) return null
    return h('section', { className: 'kode-bots-section' },
      h('h3', { className: 'kode-bots-section-title' }, '推荐伙伴'),
      h('p', { className: 'kode-secondary' }, '从模板开始，在对话里按你的习惯调整；也可以直接使用。'),
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
            h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => onBuild(template) }, '对话定制'),
            h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => onUse(template) }, '直接使用')))
      })))
  }
  function KodeBotsPage({ ui, leave }) {
    const { data, error: loadError } = useBots(), watchState = useWatches()
    const openSession = async id => { leave?.(); await ui()?.openSession(id) }
    const [selected, setSelected] = useState(null), [anchor, setAnchor] = useState(null), [settings, setSettings] = useState(null)
    const [starting, setStarting] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('')
    const createRef = React.useRef(null)
    const bot = id => data?.bots.find(row => row.id === id)
    // Requests from elsewhere: a session header opens a bot's settings, the
    // sidebar badge its 关注, a created proposal its profile card.
    useEffect(() => {
      if (!data) return
      const take = () => {
        if (requestedBotEdit && bot(requestedBotEdit)) setSettings({ id: requestedBotEdit, tab: 'profile' })
        if (requestedBotWatches && bot(requestedBotWatches)) setSettings({ id: requestedBotWatches, tab: 'watches' })
        if (requestedBotProfile && bot(requestedBotProfile)) { setSelected(requestedBotProfile); setAnchor(null) }
        requestedBotEdit = requestedBotWatches = requestedBotProfile = undefined
      }
      take()
      const events = ['kode-bot-edit', 'kode-bot-watches', 'kode-bot-profile']
      for (const name of events) window.addEventListener(name, take)
      return () => { for (const name of events) window.removeEventListener(name, take) }
    }, [data])
    // Arrived from the sidebar: open that bot, or show where to create one.
    useEffect(() => {
      if (!data || requestedBotStart === undefined) return
      const wanted = requestedBotStart && bot(requestedBotStart)
      requestedBotStart = undefined
      if (wanted) void message(wanted)
      else createRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    }, [data])
    if (!data) return h('div', { className: 'kode-agent-settings kode-bots-page' }, h('h2', null, '伙伴'), !loadError && h('p', { className: 'kode-secondary', role: 'status' }, '正在读取伙伴…'), h(Failure, { text: loadError }))
    const task = async (label, work) => {
      if (busy) return
      setBusy(label); setError('')
      try { return await work() } catch (failure) { setError(failure.message) } finally { setBusy('') }
    }
    const message = async target => {
      if (target.main_session_id) { await openSession(target.main_session_id); return }
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
    const use = template => task('template', async () => {
      const { id, glyph, skills, routines: wanted = [], outbound, ...fields } = template
      const routines = wanted.map(key => (data.routines ?? []).find(row => row.id === key)).filter(Boolean)
      // Used as is, a template's routines wait until the user turns them on.
      const result = await createBot({ ...fields, template: id, backend_key: data.agents[0]?.backend_key ?? '', model: null, default_cwd: null, avatar: null, ...(outbound === 'draft' ? { outbound } : {}) }, skills ?? [], note => setBusy(note), { routines, enableRoutines: false })
      setSelected(result.bot.id); setAnchor(null)
      if (result.failed.length) setError(`伙伴已创建，这些没设置成功，可以在伙伴设置里重试：${result.failed.join('、')}`)
      else if (routines.length) setNotice(`伙伴已创建。${routines.map(row => row.name).join('、')} 已建好但先暂停，到伙伴设置 → 关注与定时里打开。`)
    })
    const selectedBot = bot(selected), settingsBot = settings && bot(settings.id)
    if (settingsBot) return h(BotSettingsPage, { key: settingsBot.id, bot: settingsBot, data, initialTab: settings.tab, ui: () => ({ openSession: id => { setSettings(null); return openSession(id) } }), onClose: () => setSettings(null), onDeleted: () => setSelected(null) })
    return h('div', { className: 'kode-agent-settings kode-bots-page' },
      h('header', { className: 'kode-bots-hero' },
        h('h2', null, '伙伴'),
        h('p', { className: 'kode-agent-intro' }, '有名字、角色、技能和自己记忆的长期助手。点头像看资料，点资料卡编辑。')),
      h(BotInbox, { data, ui: () => ({ openSession }) }),
      h('section', { className: 'kode-bots-section kode-bots-roster' },
        h('h3', { className: 'kode-bots-section-title' }, `我的伙伴${data.bots.length ? ` · ${data.bots.length}` : ''}`),
        h(BotsRail, { bots: data.bots, selected, defaultBot: data.default_bot, unseen: Object.fromEntries(data.bots.map(bot => [bot.id, (watchState.data?.unseen?.[bot.id] ?? 0) + inboxItems(watchState.data).filter(item => item.bot === bot.id).length])), onSelect: (id, element) => { setSelected(id); setStarting(null); setAnchor(element ? element.offsetLeft + element.offsetWidth / 2 : null) }, onCreate: () => void build(null) }),
        !data.bots.length && h('p', { className: 'kode-secondary' }, '还没有伙伴。从下面的模板开始，或者点「创建伙伴」用对话定制一个。'),
        selectedBot && h(BotProfilePopover, { bot: selectedBot, data, anchor, busy: Boolean(busy), onClose: () => setSelected(null), onMessage: () => void message(selectedBot), onEdit: () => setSettings({ id: selectedBot.id, tab: 'profile' }) }),
        starting && h('form', { className: 'kode-agent-editor kode-bot-start', onSubmit: event => { event.preventDefault(); void start() } },
          h(SelectField, { label: '工作区', value: starting.workspace, options: [{ value: starting.bot.workspace, label: starting.bot.default_cwd ? data.workspaces.find(row => row.path === starting.bot.workspace)?.title ?? starting.bot.workspace : `伙伴自己的空间（${starting.bot.workspace}）` }, ...data.workspaces.filter(row => row.path !== starting.bot.workspace).map(row => ({ value: row.path, label: row.title }))], disabled: Boolean(busy), onChange: value => setStarting({ ...starting, workspace: value }) }),
          h('label', { className: 'kode-field' }, h('span', null, `对 ${starting.bot.name} 说`), h('textarea', { rows: 3, required: true, autoFocus: true, value: starting.message, disabled: Boolean(busy), onChange: event => setStarting({ ...starting, message: event.target.value }) })),
          h('div', { className: 'kode-settings-footer' }, h(Button, { type: 'button', disabled: Boolean(busy), onClick: () => setStarting(null) }, '取消'), h(Button, { type: 'submit', variant: 'primary', disabled: Boolean(busy) || !starting.message.trim() || !starting.workspace }, '发送')))),
      h(BotTemplates, { templates: data.templates, routines: data.routines ?? [], busy: Boolean(busy) || !data.agents.length, onBuild: template => void build(template), onUse: template => void use(template) }),
      h('section', { ref: createRef, className: 'kode-bots-section kode-bot-create' },
        h('span', { className: 'kode-bot-create-icon', 'aria-hidden': true }, h(IconPlusOutlineRegular, { size: 28 })),
        h('div', { className: 'kode-bot-create-text' },
          h('h3', null, '创建伙伴'),
          h('p', { className: 'kode-secondary' }, '说说你想要什么样的伙伴，对话会一步步帮你选好名字、形象、Agent、权限和技能，最后确认就能用。')),
        h(Button, { variant: 'primary', disabled: Boolean(busy) || !data.agents.length, onClick: () => void build(null) }, busy === 'builder' ? '正在打开…' : '开始对话')),
      !data.agents.length && h('p', { className: 'kode-config-note' }, '这台电脑的 dsh 里还没有可用的 Agent。'),
      busy && !['builder', 'start'].includes(busy) && h('p', { className: 'kode-config-note', role: 'status' }, busy === 'template' ? '正在创建伙伴…' : busy),
      notice && h('p', { className: 'kode-config-note', role: 'status' }, notice),
      h(Failure, { text: error }),
      h(AdvancedSection, { title: '伙伴设置' }, h(BotQuietHours, { data }), h(WeComBridgeCard), h(BotsRoot, { data, busy: Boolean(busy), act: async body => { const value = await task('root', () => botsCall(body)); if (value) publishBots({ data: value, error: '' }); return value } })))
  }
