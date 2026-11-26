  const WATCH_SOURCES = [
    { topic: 'schedule', label: '按时间（定时）', schedule: true },
    { topic: 'session.turn_completed', label: '会话完成一轮', scope: 'cwd' },
    { topic: 'session.awaiting', label: '会话在等人处理', scope: 'cwd' },
    { topic: 'session.exited', label: '会话结束', scope: 'cwd' },
    { topic: 'fs.changed', label: '文件变化', scope: 'workspace', paths: true },
    { topic: 'git.commit', label: 'Git 新提交', scope: 'workspace', branch: true },
    { topic: 'git.branch', label: 'Git 切换分支', scope: 'workspace' },
    { topic: 'wecom/message', label: '企业微信机器人收到消息', wecom: true },
    { topic: 'kode.team/mention', label: '团队里有人 @ 我', room: true },
    { topic: 'kode.team/message', label: '团队频道有新消息', room: true },
    { topic: 'kode.team/call_finished', label: '团队请求有了答复' },
    { topic: 'kode.team/crew_awaiting', label: 'Crew 计划等待确认' },
    { topic: '*', label: '其他插件事件', custom: true },
  ]
  const WATCH_PERMISSIONS = [{ value: 'plan', label: '只读，给出结论' }, { value: 'default', label: '改动前询问' }, { value: 'acceptEdits', label: '可以改文件' }]
  const WATCH_NOTIFY = [{ value: 'attention', label: '需要我处理或失败时通知' }, { value: 'always', label: '每次完成都通知' }, { value: 'never', label: '不通知，只记在动态里' }]
  const RUN_STATUS = { starting: '启动中', running: '进行中', needs_user: '等你处理', completed: '完成', failed: '没完成' }
  async function watchesCall(body, query = '') {
    const response = await fetchHost(`/api/kode/bots?watches=1${query}`, body ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin', cache: 'no-store' })
    const value = await parseHostJson(response)
    if (!response.ok) throw new Error(value.error ?? '关注暂不可用')
    return value
  }
  // One long poll per window feeds every view of watches and runs.
  let watchesSnapshot = { data: null, error: '' }, watchesFollowing = false
  const watchesListeners = new Set()
  function publishWatches(next) { watchesSnapshot = next; for (const listener of watchesListeners) listener() }
  async function followWatches() {
    if (watchesFollowing) return
    watchesFollowing = true
    try {
      while (watchesListeners.size) {
        try {
          const revision = watchesSnapshot.data?.revision
          const data = await watchesCall(undefined, revision === undefined ? '' : `&after=${revision}`)
          publishWatches({ data, error: '' })
        } catch (error) {
          publishWatches({ ...watchesSnapshot, error: error.message })
          await new Promise(resolve => setTimeout(resolve, 5000))
        }
      }
    } finally { watchesFollowing = false }
  }
  const watchesStore = { subscribe: fn => { watchesListeners.add(fn); void followWatches(); return () => watchesListeners.delete(fn) }, getSnapshot: () => watchesSnapshot }
  function useWatches() { return useSyncExternalStore(watchesStore.subscribe, watchesStore.getSnapshot) }
  async function watchAct(body) { const data = await watchesCall(body); publishWatches({ data, error: '' }); return data }
  function watchSource(topic) { return WATCH_SOURCES.find(row => row.topic === topic) ?? WATCH_SOURCES.at(-1) }
  const SCHEDULE_PRESETS = [
    { value: '0 9 * * 1-5', label: '每个工作日 09:00' }, { value: '0 9 * * *', label: '每天 09:00' }, { value: '0 18 * * 1-5', label: '每个工作日 18:00' },
    { value: '0 9 * * 1', label: '每周一 09:00' }, { value: '0 17 * * 5', label: '每周五 17:00' }, { value: '0 * * * *', label: '每小时' }, { value: '', label: '自定义（cron）' },
  ]
  /** A readable line for a five-field cron (minute hour day month weekday). */
  function cronLabel(expr) {
    const parts = String(expr ?? '').trim().split(/\s+/)
    if (parts.length !== 5) return `定时「${expr ?? ''}」`
    const [minute, hour, day, month, weekday] = parts
    const raw = `定时「${parts.join(' ')}」`
    if (day !== '*' || month !== '*' || !/^\d+$/.test(minute)) return raw
    const names = ['日', '一', '二', '三', '四', '五', '六', '日']
    const days = weekday === '*' ? '每天' : weekday === '1-5' ? '每个工作日' : /^[0-7](,[0-7])*$/.test(weekday) ? `每周${weekday.split(',').map(d => names[d]).join('、')}` : null
    if (!days) return raw
    if (hour === '*') return weekday === '*' ? `每小时第 ${minute} 分` : `${days}每小时第 ${minute} 分`
    if (/^\d+$/.test(hour)) return `${days} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    if (/^\d+(,\d+)+$/.test(hour)) return `${days} ${hour.split(',').map(h => `${h.padStart(2, '0')}:${minute.padStart(2, '0')}`).join('、')}`
    const step = /^(\d+)-(\d+)\/(\d+)$/.exec(hour)
    return step ? `${days} ${step[1]}–${step[2]} 点每 ${step[3]} 小时` : raw
  }
  /** A routine template (站会、周报 …) as a watch draft. */
  function routineDraft(routine, extra = {}) {
    return { ...watchDraft(null), name: routine.name, topic: 'schedule', cron: routine.cron, do: routine.instructions, notify: routine.notify ?? 'attention', permission: 'plan', coalesce_secs: 0, max_runs_per_hour: 2, ...extra }
  }
  function watchDraft(watch) {
    if (!watch) return { name: '', topic: 'session.turn_completed', custom: '', where: '', paths: '', branch: '', room: '', chat_id: '', cron: '0 9 * * 1-5', post_to_wecom: '', do: '', coalesce_secs: 30, max_runs_per_hour: 6, permission: 'plan', notify: 'attention', report_to_main: true, enabled: true }
    const { spec } = watch, match = spec.on.match ?? {}, source = watchSource(spec.on.topic)
    return { id: watch.id, enabled: watch.enabled, name: spec.name, topic: source.topic, custom: source.custom ? spec.on.topic : '', where: match.workspace ?? match.cwd ?? '', paths: match.paths ?? '', branch: match.branch ?? '', room: match.room ?? '', chat_id: match.chat_id ?? '', cron: match.cron ?? '0 9 * * 1-5', do: spec.do, ...spec.policy, post_to_wecom: spec.policy?.post_to_wecom ?? '' }
  }
  function watchSpec(draft) {
    const source = watchSource(draft.topic), match = {}
    if (source.scope && draft.where.trim()) match[source.scope] = draft.where.trim()
    if (source.paths && draft.paths.trim()) match.paths = draft.paths.trim()
    if (source.branch && draft.branch.trim()) match.branch = draft.branch.trim()
    if (source.room && draft.room.trim()) match.room = draft.room.trim()
    if (source.wecom && draft.chat_id?.trim()) match.chat_id = draft.chat_id.trim()
    if (source.schedule) match.cron = draft.cron.trim()
    return { name: draft.name.trim(), on: { topic: source.custom ? draft.custom.trim() : source.topic, match }, do: draft.do, policy: { coalesce_secs: source.schedule ? 0 : Number(draft.coalesce_secs) || 0, max_runs_per_hour: Number(draft.max_runs_per_hour) || 1, permission: draft.permission, workspace: null, carry_last_summary: true, notify: draft.notify, report_to_main: draft.report_to_main !== false, ...(draft.post_to_wecom?.trim() ? { post_to_wecom: draft.post_to_wecom.trim() } : {}) } }
  }
  function watchSummary(spec) {
    const source = watchSource(spec.on.topic), match = spec.on.match ?? {}
    if (source.schedule) return [cronLabel(match.cron), spec.policy?.post_to_wecom && `同时发到企微 ${spec.policy.post_to_wecom}`].filter(Boolean).join(' · ')
    const parts = [source.custom ? spec.on.topic : source.label]
    if (match.workspace || match.cwd) parts.push(`在 ${match.workspace ?? match.cwd}`)
    if (match.paths) parts.push(`文件 ${match.paths}`)
    if (match.branch) parts.push(`分支 ${match.branch}`)
    if (match.room) parts.push(`频道 ${match.room}`)
    if (match.chat_id) parts.push(`企微会话 ${match.chat_id}`)
    return parts.join(' · ')
  }
  function WatchEditor({ draft, workspaces, busy, onChange, onSave, onCancel }) {
    const source = watchSource(draft.topic), set = (key, value) => onChange({ ...draft, [key]: value })
    const input = (label, key, props = {}) => h('label', { className: 'kode-field' }, h('span', null, label), h(props.rows ? 'textarea' : 'input', { value: draft[key] ?? '', disabled: busy, onChange: event => set(key, event.target.value), ...props }))
    const places = [...(source.scope === 'cwd' ? [{ value: '', label: '任何工作区' }] : []), ...workspaces.map(row => ({ value: row.path, label: `${row.title}（${row.path}）` }))]
    if (draft.where && !places.some(row => row.value === draft.where)) places.push({ value: draft.where, label: draft.where })
    return h('form', { className: 'kode-agent-editor kode-watch-editor', onSubmit: event => { event.preventDefault(); onSave() } },
      input('名字', 'name', { maxLength: 80, required: true, placeholder: source.wecom ? '例如：响应企业微信研发群消息' : '例如：提交后做代码审查' }),
      h(SelectField, { label: '当这件事发生', value: draft.topic, options: WATCH_SOURCES.map(row => ({ value: row.topic, label: row.label })), disabled: busy, onChange: value => onChange({ ...draft, topic: value, where: watchSource(value).scope === 'workspace' && !draft.where ? workspaces[0]?.path ?? '' : draft.where }) }),
      source.custom && input('事件名（插件 id/事件）', 'custom', { required: true, placeholder: 'some.extension/event' }),
      source.schedule && h(SelectField, { label: '什么时候', value: SCHEDULE_PRESETS.some(row => row.value && row.value === draft.cron) ? draft.cron : '', options: SCHEDULE_PRESETS, disabled: busy, onChange: value => set('cron', value || draft.cron) }),
      source.schedule && input('时间（cron：分 时 日 月 周）', 'cron', { required: true, placeholder: '0 9 * * 1-5' }),
      source.schedule && h('span', { className: 'kode-config-note' }, `${cronLabel(draft.cron)}。Kode 关着时错过的时间点，重新打开后 12 小时内会补跑一次。`),
      source.scope && h(SelectField, { label: source.scope === 'cwd' ? '哪里的会话' : '关注哪个工作区', value: draft.where, options: places, disabled: busy, onChange: value => set('where', value) }),
      source.scope && input('或者填写路径', 'where', { placeholder: '/绝对路径' }),
      source.paths && input('只看这些文件（可选）', 'paths', { placeholder: 'src/**  或  docs/*.md' }),
      source.branch && input('只看这个分支（可选）', 'branch', { placeholder: 'main' }),
      input('同时把结论发到企业微信会话（chat_id，可选）', 'post_to_wecom', { placeholder: '例如：wr_xxxx；伙伴设为「先起草」时会先给你确认' }),
      source.room && input('只看这个频道（可选）', 'room', { placeholder: 'general' }),
      source.wecom && input('只看这个企微会话 chat_id（可选，留空监听全部已配置会话）', 'chat_id', { placeholder: '例如：wr_xxxx 或成员 userid' }),
      input('伙伴每次要做什么', 'do', { rows: 4, required: true, placeholder: source.wecom ? '阅读企业微信消息，必要时调用 wecom_messages_list 补充上下文、用 wecom_message_send 回复对方，并把结论整理汇报给我。' : '看一下这次改动有没有明显问题，有的话列出来；没有就说“没问题”。' }),
      !source.schedule && h('div', { className: 'kode-watch-grid' },
        input('合并多少秒内的事件', 'coalesce_secs', { type: 'number', min: 0, max: 3600 }),
        input('每小时最多运行', 'max_runs_per_hour', { type: 'number', min: 1, max: 60 })),
      h(SelectField, { label: '运行时的权限（不超过伙伴的上限）', value: draft.permission, options: WATCH_PERMISSIONS, disabled: busy, onChange: value => set('permission', value) }),
      h(SelectField, { label: '通知', value: draft.notify, options: WATCH_NOTIFY, disabled: busy, onChange: value => set('notify', value) }),
      h('label', { className: 'kode-avatar-background-toggle' }, h('input', { type: 'checkbox', checked: draft.report_to_main !== false, disabled: busy, onChange: event => set('report_to_main', event.target.checked) }), '完成后把结论发到伙伴的主对话里'),
      h('div', { className: 'kode-settings-footer' }, h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'), h(Button, { type: 'submit', variant: 'primary', disabled: busy || !draft.name.trim() || !draft.do.trim() || (source.schedule && !draft.cron?.trim()) }, '保存')))
  }
  function RunRow({ run, watch, ui }) {
    const [open, setOpen] = useState(false)
    const when = new Date(run.started).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const trigger = (run.trigger?.events ?? []).map(event => event.summary).join('\n')
    return h('li', { className: 'kode-run-row', 'data-status': run.status },
      h('button', { type: 'button', className: 'kode-run-head', onClick: () => setOpen(!open) },
        h('span', { className: 'kode-run-status' }, RUN_STATUS[run.status] ?? run.status),
        h('span', { className: 'kode-run-name' }, watch?.spec.name ?? '已删除的关注'),
        !run.seen && run.finished && h('span', { className: 'kode-run-new' }, '新'),
        h('span', { className: 'kode-secondary' }, when)),
      (open || run.status === 'needs_user') && h('div', { className: 'kode-run-body' },
        trigger && h('p', { className: 'kode-secondary kode-run-trigger' }, trigger),
        run.summary && h('p', { className: 'kode-run-summary' }, run.summary),
        run.error && h(Failure, { text: run.error })),
      run.session_uuid && h(Button, { className: 'kode-run-open', onClick: () => void ui()?.openSession(run.session_uuid) }, '打开会话'))
  }
  function BotWatches({ bot, workspaces, ui, routines = [] }) {
    const { data, error: loadError } = useWatches()
    const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const act = async body => {
      setBusy(true); setError('')
      try { await watchAct(body); return true } catch (failure) { setError(failure.message); return false } finally { setBusy(false) }
    }
    const unseen = data?.unseen?.[bot.id] ?? 0
    useEffect(() => { if (unseen) void watchAct({ action: 'watch_seen', bot: bot.id }).catch(() => {}) }, [unseen, bot.id])
    if (!data) return h('div', { className: 'kode-bot-watches' }, h('p', { className: 'kode-secondary' }, '正在读取关注…'), h(Failure, { text: loadError }))
    const watches = data.watches.filter(row => row.bot === bot.id), runs = data.runs.filter(row => row.bot === bot.id).slice(0, 12)
    const save = async () => { if (await act({ action: 'watch_upsert', id: draft.id, bot: bot.id, enabled: draft.enabled, spec: watchSpec(draft) })) setDraft(null) }
    return h('div', { className: 'kode-bot-watches' },
      h('h3', { className: 'kode-settings-group-title' }, '关注与定时'),
      h('p', { className: 'kode-secondary' }, '到点或发生这些事时，伙伴会自己开一个会话去处理，结论发到它的主对话，也记在下面的动态里。'),
      routines.length > 0 && !draft && h('div', { className: 'kode-bot-routine-picks' },
        h('span', { className: 'kode-secondary' }, '常用节奏：'),
        ...routines.map(routine => h('button', { key: routine.id, type: 'button', className: 'kode-banner-chip', title: `${routine.when} · ${routine.summary}`, disabled: busy, onClick: () => setDraft(routineDraft(routine)) }, routine.name))),
      watches.length ? h('ul', { className: 'kode-watch-list' }, ...watches.map(watch => draft?.id === watch.id
        ? h('li', { key: watch.id }, h(WatchEditor, { draft, workspaces, busy, onChange: setDraft, onSave: save, onCancel: () => setDraft(null) }))
        : h('li', { key: watch.id, className: 'kode-watch-row', 'data-enabled': watch.enabled },
          h(FastSwitch, { checked: watch.enabled, disabled: busy, label: watch.enabled ? '暂停' : '启用', onChange: enabled => void act({ action: 'watch_toggle', id: watch.id, enabled }) }),
          h('div', { className: 'kode-watch-text' }, h('span', { className: 'kode-agent-name' }, watch.spec.name), h('span', { className: 'kode-secondary' }, watchSummary(watch.spec))),
          h(Button, { disabled: busy, onClick: () => void act({ action: 'watch_run', id: watch.id }) }, '运行一次'),
          h(Button, { disabled: busy || !!draft, onClick: () => setDraft(watchDraft(watch)) }, '编辑'),
          h(Button, { disabled: busy, onClick: () => { if (confirm(`删除关注「${watch.spec.name}」？已有的动态会保留。`)) void act({ action: 'watch_delete', id: watch.id }) } }, '删除')))) : null,
      draft && !draft.id ? h(WatchEditor, { draft, workspaces, busy, onChange: setDraft, onSave: save, onCancel: () => setDraft(null) })
        : h(Button, { variant: 'outline', className: 'kode-agent-add', disabled: busy || !!draft, onClick: () => setDraft(watchDraft(null)) }, h(IconPlusOutlineRegular, { size: 16 }), '添加关注'),
      h(Failure, { text: error }),
      runs.length > 0 && h('h3', { className: 'kode-settings-group-title' }, '动态'),
      runs.length > 0 && h('ul', { className: 'kode-run-list' }, ...runs.map(run => h(RunRow, { key: run.id, run, ui, watch: data.watches.find(row => row.id === run.watch_id) }))))
  }
