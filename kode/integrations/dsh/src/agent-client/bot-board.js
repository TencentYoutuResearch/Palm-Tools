  // Orca-style multi-column Kanban board for bots: surfaces Needs You, Working,
  // Waiting / Planned, and Done directly on the main 伙伴 page and per-bot view.
  const KANBAN_COLUMNS = [
    { key: 'needs_user', label: '待你处理', tone: 'amber', empty: '暂无需要你确认或回复的事' },
    { key: 'in_progress', label: '进行中', tone: 'blue', empty: '目前没有正在执行的任务' },
    { key: 'waiting', label: '等待 / 计划', tone: 'slate', empty: '暂无排期或等待中的任务' },
    { key: 'done', label: '最近完成', tone: 'green', empty: '完成的任务和巡检会出现在这里' },
  ]

  function KanbanCard({ item, bot, watch, showBot, ui, busy, onAct }) {
    const [note, setNote] = useState('')
    const [content, setContent] = useState(item.task?.payload?.content ?? '')
    const { task, run } = item
    const header = h('div', { className: 'kode-kanban-card-head' },
      showBot && bot && h('span', { className: 'kode-kanban-who' }, h(BotAvatar, { bot, size: 18 }), h('span', null, bot.name)),
      h('span', { className: 'kode-kanban-time' }, shortTime(item.time)),
      task?.kind === 'task' && h('button', {
        type: 'button',
        className: 'kode-task-remove',
        title: '删除任务',
        disabled: busy,
        onClick: () => { if (confirm(`删除任务「${task.title}」？`)) void onAct({ action: 'task_delete', id: task.id }) },
      }, '×'))

    if (item.kind === 'plan') {
      return h('li', { className: 'kode-kanban-card is-plan' },
        header,
        h('span', { className: 'kode-kanban-pill is-amber' }, '计划待批准'),
        h('strong', { className: 'kode-kanban-title' }, task.title),
        task.detail && h('p', { className: 'kode-secondary kode-kanban-desc' }, task.detail),
        task.payload?.steps?.length > 0 && h('ol', { className: 'kode-kanban-steps' },
          ...task.payload.steps.slice(0, 5).map((step, index) => h('li', { key: index }, step.title))),
        h('input', { className: 'kode-inbox-note', placeholder: '补充意见（可选）', value: note, disabled: busy, onChange: event => setNote(event.target.value) }),
        h('div', { className: 'kode-kanban-actions' },
          h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => void onAct({ action: 'task_approve', id: task.id, note }) }, '批准'),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void onAct({ action: 'task_reject', id: task.id, note }) }, '不同意')))
    }

    if (item.kind === 'outbound') {
      return h('li', { className: 'kode-kanban-card is-outbound' },
        header,
        h('span', { className: 'kode-kanban-pill is-amber' }, `待发送 · ${task.payload?.chat_id || '企业微信'}`),
        h('textarea', { className: 'kode-inbox-draft', rows: Math.min(6, Math.max(2, content.split('\n').length)), value: content, disabled: busy, onChange: event => setContent(event.target.value) }),
        h('div', { className: 'kode-kanban-actions' },
          h(Button, { size: 'sm', variant: 'primary', disabled: busy || !content.trim(), onClick: () => void onAct({ action: 'outbox_send', id: task.id, content }) }, '发送'),
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void onAct({ action: 'task_reject', id: task.id, note: content !== task.payload?.content ? '用户改过内容但决定不发' : '' }) }, '不发')))
    }

    if (item.kind === 'run') {
      const running = ['starting', 'running'].includes(run.status)
      const needs = run.status === 'needs_user'
      return h('li', { className: `kode-kanban-card is-run${running ? ' is-live' : ''}` },
        header,
        h('span', { className: `kode-kanban-pill is-${needs ? 'amber' : running ? 'blue' : run.status === 'failed' ? 'rose' : 'green'}` },
          running && h('span', { className: 'kode-kanban-live-dot', 'aria-hidden': true }),
          needs ? '关注任务等你处理' : running ? '后台执行中' : run.status === 'failed' ? '执行异常' : '关注已完成'),
        h('strong', { className: 'kode-kanban-title' }, watch?.spec?.name ?? '关注任务'),
        run.summary && h('p', { className: 'kode-secondary kode-kanban-desc' }, run.summary),
        run.session_uuid && h('div', { className: 'kode-kanban-actions' },
          h(Button, { size: 'sm', variant: needs ? 'primary' : 'ghost', onClick: () => void ui()?.openSession(run.session_uuid) }, needs ? '去处理' : '打开会话')))
    }

    // Standard task card
    return h('li', { className: 'kode-kanban-card', 'data-status': task.status },
      header,
      task.status === 'waiting' && h('span', { className: 'kode-kanban-pill is-slate' }, '等待中'),
      task.status === 'planned' && h('span', { className: 'kode-kanban-pill is-slate' }, '计划中'),
      h('strong', { className: 'kode-kanban-title' }, task.title),
      (task.reason || task.detail) && h('p', { className: 'kode-secondary kode-kanban-desc' }, task.reason || task.detail),
      task.due && h('span', { className: `kode-agent-tag${task.due < Date.now() && !task.closed ? ' is-late' : ''}` }, `截止 ${shortTime(task.due)}`),
      h('div', { className: 'kode-kanban-card-foot' },
        h(SelectField, { label: '状态', showLabel: false, value: task.status, options: TASK_STATUS_OPTIONS, disabled: busy, onChange: value => void onAct({ action: 'task_upsert', task: { id: task.id, status: value } }) }),
        h('div', { className: 'kode-kanban-actions' },
          task.status === 'needs_user' && h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => void onAct({ action: 'task_upsert', task: { id: task.id, status: 'in_progress', reason: '' } }) }, '继续'),
          task.session_uuid && h(Button, { size: 'sm', variant: 'ghost', onClick: () => void ui()?.openSession(task.session_uuid) }, '会话'))))
  }

  function BotsKanbanBoard({ data, ui, singleBot = null }) {
    const watchState = useWatches()
    const [botFilter, setBotFilter] = useState(singleBot?.id ?? 'all')
    const [query, setQuery] = useState('')
    const [newTitle, setNewTitle] = useState('')
    const [newBotId, setNewBotId] = useState(() => singleBot?.id ?? data.default_bot ?? data.bots[0]?.id ?? '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
      if (singleBot) { setBotFilter(singleBot.id); setNewBotId(singleBot.id) }
      else if (!data.bots.some(row => row.id === newBotId)) setNewBotId(data.default_bot ?? data.bots[0]?.id ?? '')
    }, [singleBot?.id, data.bots.length])

    const act = async body => {
      setBusy(true); setError('')
      try { await taskAct(body); return true }
      catch (failure) { setError(failure.message); return false }
      finally { setBusy(false) }
    }

    const addTask = async event => {
      event.preventDefault()
      const targetBot = singleBot?.id ?? newBotId
      if (!newTitle.trim() || !targetBot) return
      if (await act({ action: 'task_upsert', task: { bot: targetBot, title: newTitle.trim() } })) setNewTitle('')
    }

    const watchesData = watchState.data
    const botsById = new Map(data.bots.map(row => [row.id, row]))
    const watchesById = new Map((watchesData?.watches ?? []).map(row => [row.id, row]))
    const activeBotId = singleBot ? singleBot.id : (botFilter === 'all' ? null : botFilter)
    const needle = query.trim().toLowerCase()

    const columns = { needs_user: [], in_progress: [], waiting: [], done: [] }
    if (watchesData) {
      const seenSessions = new Set()
      for (const task of watchesData.tasks ?? []) {
        if (activeBotId && task.bot !== activeBotId) continue
        if (task.status === 'cancelled') continue
        const botName = botsById.get(task.bot)?.name ?? ''
        const text = `${task.title ?? ''} ${task.reason ?? ''} ${task.detail ?? ''} ${botName}`.toLowerCase()
        if (needle && !text.includes(needle)) continue
        if (task.session_uuid) seenSessions.add(task.session_uuid)
        const item = {
          key: `task:${task.id}`,
          kind: task.kind === 'plan' ? 'plan' : task.kind === 'outbound' ? 'outbound' : 'task',
          bot: task.bot,
          time: task.updated ?? task.created ?? 0,
          task,
        }
        if (task.status === 'needs_user') columns.needs_user.push(item)
        else if (task.status === 'in_progress') columns.in_progress.push(item)
        else if (task.status === 'waiting' || task.status === 'planned') columns.waiting.push(item)
        else if (task.status === 'done') columns.done.push(item)
      }
      for (const run of watchesData.runs ?? []) {
        if (activeBotId && run.bot !== activeBotId) continue
        if (run.session_uuid && seenSessions.has(run.session_uuid)) continue
        const watch = watchesById.get(run.watch_id)
        const botName = botsById.get(run.bot)?.name ?? ''
        const text = `${watch?.spec?.name ?? ''} ${run.summary ?? ''} ${botName}`.toLowerCase()
        if (needle && !text.includes(needle)) continue
        const item = {
          key: `run:${run.id}`,
          kind: 'run',
          bot: run.bot,
          time: run.finished_at ?? run.started_at ?? 0,
          run,
          watch,
        }
        if (run.status === 'needs_user') columns.needs_user.push(item)
        else if (run.status === 'starting' || run.status === 'running') columns.in_progress.push(item)
        else if (run.status === 'done' || run.status === 'failed') columns.done.push(item)
      }
      for (const key of Object.keys(columns)) {
        columns[key].sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
      }
      columns.done = columns.done.slice(0, 12)
    }

    const totalOpen = columns.needs_user.length + columns.in_progress.length + columns.waiting.length
    if (!singleBot && !data.bots.length) return null

    return h('section', { className: `kode-bots-section kode-kanban${singleBot ? ' is-single-bot' : ''}` },
      !singleBot && h('div', { className: 'kode-kanban-header' },
        h('div', null,
          h('h3', { className: 'kode-bots-section-title' }, `伙伴看板${totalOpen ? ` · ${totalOpen} 进行/待办` : ''}`),
          h('p', { className: 'kode-secondary' }, '实时汇聚所有伙伴的待确认事项、后台执行任务、计划排期与最近成果。')),
        h('div', { className: 'kode-kanban-search' },
          h(IconSearchOutlineRegular, { size: 15 }),
          h('input', { 'aria-label': '搜索看板', placeholder: '筛选任务、伙伴或原因…', value: query, onChange: event => setQuery(event.target.value) }))),
      !singleBot && data.bots.length > 1 && h('div', { className: 'kode-kanban-filters', role: 'tablist', 'aria-label': '按伙伴筛选看板' },
        h('button', { type: 'button', className: 'kode-banner-chip', 'aria-pressed': botFilter === 'all', onClick: () => setBotFilter('all') }, '全部伙伴'),
        ...data.bots.map(bot => {
          const count = (watchesData?.tasks ?? []).filter(t => t.bot === bot.id && !t.closed && t.status !== 'cancelled').length
          return h('button', { key: bot.id, type: 'button', className: 'kode-banner-chip', 'aria-pressed': botFilter === bot.id, onClick: () => setBotFilter(bot.id) },
            h(BotAvatar, { bot, size: 16 }),
            h('span', null, bot.name),
            count > 0 && h('span', { className: 'kode-kanban-filter-count' }, count))
        })),
      h('form', { className: 'kode-kanban-add', onSubmit: addTask },
        !singleBot && data.bots.length > 1 && h(SelectField, {
          label: '指派给伙伴',
          showLabel: false,
          value: newBotId,
          options: data.bots.map(row => ({ value: row.id, label: row.name })),
          disabled: busy,
          onChange: setNewBotId,
        }),
        h('div', { className: 'kode-skill-search kode-kanban-add-input' },
          h(IconPlusOutlineRegular, { size: 16 }),
          h('input', {
            'aria-label': '新增看板任务',
            placeholder: singleBot ? `给 ${singleBot.name} 添加一项待办或跟踪任务…` : `给 ${botsById.get(newBotId)?.name ?? '伙伴'} 添加一项任务…`,
            value: newTitle,
            disabled: busy,
            onChange: event => setNewTitle(event.target.value),
          }),
          h(Button, { type: 'submit', size: 'sm', variant: 'outline', disabled: busy || !newTitle.trim() || !(singleBot?.id || newBotId) }, '添加'))),
      !watchesData && !watchState.error && h('p', { className: 'kode-secondary', role: 'status' }, '正在加载看板…'),
      watchesData && !watchesData.tasks && h('p', { className: 'kode-config-note' }, '当前 Kode 服务版本较旧，更新后即可使用完整看板功能。'),
      watchesData && h('div', { className: 'kode-kanban-grid' },
        ...KANBAN_COLUMNS.map(col => {
          const items = columns[col.key] ?? []
          return h('div', { key: col.key, className: `kode-kanban-col is-${col.tone}` },
            h('div', { className: 'kode-kanban-col-head' },
              h('span', { className: 'kode-kanban-col-dot', 'aria-hidden': true }),
              h('h4', null, col.label),
              h('span', { className: 'kode-kanban-col-count' }, items.length)),
            items.length > 0
              ? h('ul', { className: 'kode-kanban-list' }, ...items.map(item => h(KanbanCard, {
                key: item.key,
                item,
                bot: botsById.get(item.bot),
                watch: item.watch,
                showBot: !singleBot && botFilter === 'all',
                ui,
                busy,
                onAct: act,
              })))
              : h('p', { className: 'kode-kanban-empty' }, col.empty))
        })),
      h(Failure, { text: error || watchState.error }))
  }
