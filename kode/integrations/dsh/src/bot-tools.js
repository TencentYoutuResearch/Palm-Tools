/** Tools a bot ("伙伴") uses to track work for the user: its task board,
 *  plans the user approves, a progress snapshot and its own schedules. A
 *  session belongs to a bot when it is the bot's main conversation, filed
 *  under it, one of its watch runs, or running in the bot's own folder. */
const PREFIX = '/api/v1/messaging/'
const TASKS = `${PREFIX}workbench/bot-tasks`
const WATCHES = `${PREFIX}workbench/watches`
const BOTS = `${PREFIX}workbench/bots`
const STATUSES = ['planned', 'in_progress', 'waiting', 'needs_user', 'done', 'cancelled']
const inside = (path, folder) => Boolean(path && folder) && (path === folder || path.startsWith(`${folder.replace(/\/$/, '')}/`))

export async function ownerOf(admin, sessionId, cwd, signal, extraAliases = []) {
  const roster = await admin.call(BOTS, undefined, signal)
  const keys = Array.from(new Set([String(sessionId), ...extraAliases.filter(Boolean).map(String)]))
  const adoptedMap = { ...(roster.adopted ?? {}), ...(roster.adopted_aliases ?? {}) }
  let bot = roster.bots.find(row => {
    const mainAliases = new Set([
      ...(roster.main_aliases?.[row.id] ?? []),
      ...(row.main_session?.session_id ? [row.main_session.session_id] : []),
    ])
    return keys.some(k => mainAliases.has(k))
  })
    ?? roster.bots.find(row => keys.some(k => adoptedMap[k] === row.id))
  if (!bot) {
    const runs = (await admin.call(WATCHES, undefined, signal).catch(() => null))?.runs ?? []
    const run = runs.find(row => keys.includes(row.session_uuid))
    bot = run && roster.bots.find(row => row.id === run.bot)
  }
  bot ??= roster.bots.find(row => inside(cwd, roster.homes?.[row.id]))
  return { roster, bot }
}

function agentAliases(agent) {
  const threadId = agent?.ctx?.get?.('kodeAgents')?.bindings?.get?.(agent.id)?.threadId
  return threadId ? [threadId] : []
}

async function mine(admin, agent, signal) {
  const { bot } = await ownerOf(admin, agent.id, agent.session?.header?.cwd, signal, agentAliases(agent))
  if (!bot) throw new Error('这个会话不属于任何伙伴：任务板、计划和定时只在伙伴自己的会话里可用。')
  return bot
}

function dueTime(value) {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 0 || value === 'none') return 0
  const time = typeof value === 'number' ? value : /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T18:00:00`).getTime() : Date.parse(value)
  if (!Number.isFinite(time) || time <= 0) throw new Error('截止时间要写成 YYYY-MM-DD 或 ISO 时间')
  return time
}

const compact = task => ({ task_id: task.id, title: task.title, status: task.status, ...(task.reason ? { reason: task.reason } : {}), ...(task.detail ? { detail: task.detail.slice(0, 400) } : {}), ...(task.due ? { due: new Date(task.due).toISOString() } : {}), ...(task.session_uuid ? { session_id: task.session_uuid } : {}), kind: task.kind, updated: new Date(task.updated).toISOString() })

export function scheduleSpec(args) {
  if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('定时任务需要名字')
  if (typeof args.instructions !== 'string' || !args.instructions.trim()) throw new Error('写清楚每次到点要做什么')
  return {
    name: args.name.trim().slice(0, 80),
    on: { topic: 'schedule', match: { cron: String(args.cron ?? '').trim() } },
    do: args.instructions.trim(),
    policy: {
      coalesce_secs: 0, max_runs_per_hour: 2, permission: args.permission ?? 'plan', workspace: args.workspace || null,
      carry_last_summary: true, notify: args.notify ?? 'attention', report_to_main: true,
      ...(args.wecom_chat_id ? { post_to_wecom: String(args.wecom_chat_id) } : {}),
    },
  }
}

/** `[name, description, parameters, execute(args, signal)]` for one session. */
export function botTools(admin, agent) {
  return [
    ['bot_tasks_list', 'List the tasks on your (the bot\'s) task board: what you track for the user, with status and the conversation doing each one. Use before reporting progress or planning next steps.', {
      include_closed: { type: 'boolean', description: 'Also list tasks finished or cancelled in the last 7 days.' },
    }, async (args, signal) => {
      const bot = await mine(admin, agent, signal)
      const { tasks } = await admin.call(`${TASKS}?bot=${encodeURIComponent(bot.id)}`, undefined, signal)
      return { bot: bot.name, tasks: tasks.filter(task => args.include_closed || !task.closed).map(compact) }
    }],
    ['bot_task_update', 'Add a task to your board or update one. Keep status honest: planned, in_progress, waiting (give reason), needs_user (the user must decide; give reason), done, cancelled. Link the conversation doing it with link_session (a session_id from kode_sessions_list/create) so Kode tells you when it finishes, asks something, stalls or runs late.', {
      task_id: { type: 'string', description: 'Existing task to update; omit to add a new task.' },
      title: { type: 'string', description: 'Short task title (required for a new task).' },
      detail: { type: 'string' },
      status: { type: 'string', enum: STATUSES },
      reason: { type: 'string', description: 'Why it waits or needs the user.' },
      due: { type: 'string', description: 'Due date YYYY-MM-DD or ISO time; "none" clears it.' },
      link_session: { type: 'string', description: 'Local session_id of the conversation doing this task.' },
      unlink_session: { type: 'boolean' },
    }, async (args, signal) => {
      const bot = await mine(admin, agent, signal)
      const due = dueTime(args.due)
      const { task } = await admin.call(TASKS, { action: 'upsert', task: {
        ...(args.task_id ? { id: args.task_id } : {}), bot: bot.id,
        ...Object.fromEntries(['title', 'detail', 'status', 'reason'].filter(key => args[key] !== undefined).map(key => [key, args[key]])),
        ...(due !== undefined ? { due } : {}),
        ...(args.link_session ? {
          session: {
            runtime: String(args.link_session).startsWith('kode:runtime:gui:') ? 'gui' : 'dsh',
            session_id: String(args.link_session),
          },
        } : {}),
        ...(args.unlink_session ? { unlink: true } : {}),
      } }, signal)
      if (task.bot !== bot.id) throw new Error('这个任务属于别的伙伴')
      return compact(task)
    }],
    ['bot_plan_propose', 'Propose a multi-step plan for the user to approve before you dispatch work. The plan waits in the user\'s inbox; when approved, Kode creates one task per step and tells you to start. Do not dispatch the steps before that message arrives.', {
      title: { type: 'string', required: true },
      summary: { type: 'string', description: 'Goal, approach and risks in a few lines.' },
      steps: { type: 'array', required: true, description: 'Ordered steps, at most 20.', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] } },
    }, async (args, signal) => {
      const bot = await mine(admin, agent, signal)
      const steps = (Array.isArray(args.steps) ? args.steps : []).filter(step => typeof step?.title === 'string' && step.title.trim()).slice(0, 20).map(step => ({ title: step.title.trim().slice(0, 200), ...(step.detail ? { detail: String(step.detail).slice(0, 8000) } : {}) }))
      if (!steps.length) throw new Error('计划至少要有一个步骤')
      const { task } = await admin.call(TASKS, { action: 'upsert', task: { bot: bot.id, kind: 'plan', title: args.title, detail: args.summary ?? '', status: 'needs_user', payload: { steps } } }, signal)
      return { plan_id: task.id, status: 'waiting_for_user', note: '计划已交给用户批准。批准后你会收到一条「计划已批准」的消息，那时再开始派发。' }
    }],
    ['kode_progress_snapshot', 'Read what moved recently on this computer: conversations with their latest conclusions, conversations waiting for someone, Git commits in those folders, and your open tasks. Use it for standups, reports and progress checks.', {
      since_hours: { type: 'number', description: 'Look back this many hours (default 24, at most 336).' },
      workspace: { type: 'string', description: 'Only this folder and below.' },
    }, async (args, signal) => {
      const { bot } = await ownerOf(admin, agent.id, agent.session?.header?.cwd, signal, agentAliases(agent))
      const hours = Math.min(336, Math.max(0.25, Number(args.since_hours) || 24))
      const query = new URLSearchParams({ since: String(Date.now() - hours * 3_600_000) })
      if (args.workspace) query.set('workspace', String(args.workspace))
      if (bot) query.set('bot', bot.id)
      return admin.call(`${PREFIX}workbench/progress?${query}`, undefined, signal)
    }],
    ['bot_schedules_list', 'List your scheduled routines (time-triggered runs such as a daily standup).', {}, async (_args, signal) => {
      const bot = await mine(admin, agent, signal)
      const { watches } = await admin.call(`${WATCHES}?bot=${encodeURIComponent(bot.id)}`, undefined, signal)
      return { schedules: watches.filter(row => row.spec?.on?.topic === 'schedule').map(row => ({ schedule_id: row.id, name: row.spec.name, cron: row.spec.on.match?.cron, enabled: row.enabled, instructions: row.spec.do, wecom_chat_id: row.spec.policy?.post_to_wecom ?? null })) }
    }],
    ['bot_schedule_upsert', 'Create or change one of your scheduled routines. Each time it fires you run in your own routine conversation with these instructions, and the result is posted back to your main conversation. cron is five fields in local time: minute hour day month weekday (e.g. "0 9 * * 1-5" = every workday 09:00, "0 17 * * 5" = Fridays 17:00).', {
      schedule_id: { type: 'string', description: 'Existing routine to change; omit to create.' },
      name: { type: 'string', required: true },
      cron: { type: 'string', required: true },
      instructions: { type: 'string', required: true, description: 'What to do each time, e.g. call kode_progress_snapshot and write a standup.' },
      permission: { type: 'string', enum: ['plan', 'default', 'acceptEdits'], description: 'Default plan (read-only); never above your ceiling.' },
      notify: { type: 'string', enum: ['always', 'attention', 'never'] },
      wecom_chat_id: { type: 'string', description: 'Also post each report to this WeCom chat.' },
      enabled: { type: 'boolean' },
    }, async (args, signal) => {
      const bot = await mine(admin, agent, signal)
      if (args.schedule_id) {
        const { watches } = await admin.call(`${WATCHES}?bot=${encodeURIComponent(bot.id)}`, undefined, signal)
        if (!watches.some(row => row.id === args.schedule_id && row.spec?.on?.topic === 'schedule')) throw new Error('找不到你的这个定时任务')
      }
      const view = await admin.call(WATCHES, { action: 'upsert', ...(args.schedule_id ? { id: args.schedule_id } : {}), bot: bot.id, enabled: args.enabled !== false, spec: scheduleSpec(args) }, signal)
      return { schedule_id: view.saved ?? args.schedule_id, name: args.name, cron: args.cron, enabled: args.enabled !== false }
    }],
    ['bot_schedule_delete', 'Delete one of your scheduled routines.', { schedule_id: { type: 'string', required: true } }, async (args, signal) => {
      const bot = await mine(admin, agent, signal)
      const { watches } = await admin.call(`${WATCHES}?bot=${encodeURIComponent(bot.id)}`, undefined, signal)
      if (!watches.some(row => row.id === args.schedule_id && row.spec?.on?.topic === 'schedule')) throw new Error('找不到你的这个定时任务')
      await admin.call(WATCHES, { action: 'delete', id: args.schedule_id }, signal)
      return { deleted: args.schedule_id }
    }],
  ]
}

/** A WeCom message from a bot that drafts outbound messages waits for the user. */
export async function draftOutbound(admin, agent, args, signal) {
  const { bot } = await ownerOf(admin, agent.id, agent.session?.header?.cwd, signal, agentAliases(agent))
  if (bot?.outbound !== 'draft') return null
  const content = String(args.content ?? '')
  const { task } = await admin.call(TASKS, { action: 'upsert', task: {
    bot: bot.id, kind: 'outbound', status: 'needs_user',
    title: `发到企业微信 ${args.chat_id}：${content.replace(/\s+/g, ' ').slice(0, 40)}`,
    detail: content.slice(0, 8000),
    payload: { channel: 'wecom', chat_id: String(args.chat_id), content: content.slice(0, 8000), format: args.format === 'text' ? 'text' : 'markdown' },
  } }, signal)
  return { sent: false, drafted: true, draft_id: task.id, note: '这个伙伴的对外消息需要用户确认：已作为草稿放进用户的待处理，用户确认后才会发送。告诉用户你起草了什么。' }
}

/** The worker side of a linked task: report back in a form the bot can read. */
export function taskAssignment(task, taskId) {
  return `${task}\n\n——\n这是任务 ${taskId} 的一部分。做完后用 kode_sessions_send 回复派你来的会话（in_reply_to 上面的消息），第一行写「状态：完成」「状态：需要决定」或「状态：受阻」，再写结论和需要的决定。`
}
