import test from 'node:test'
import assert from 'node:assert/strict'
import { botTools, draftOutbound, ownerOf, scheduleSpec, taskAssignment } from '../src/bot-tools.js'
import { registerBotsApi } from '../src/bots-api.js'

function fakeAdmin({ outbound } = {}) {
  const calls = [], tasks = [], watches = []
  const roster = {
    bots: [
      { id: 'b1', name: 'Kit', main_session: { runtime: 'dsh', session_id: 'main-1' }, outbound },
      { id: 'b2', name: 'Rex' },
    ],
    adopted: { 'helper-1': 'b2' },
    homes: { b1: '/bots/b1', b2: '/bots/b2' },
  }
  const admin = {
    call: async (path, body) => {
      calls.push([path, body])
      if (path.endsWith('/workbench/bots')) return roster
      if (path.includes('/workbench/watches')) {
        if (body?.action === 'upsert') { const id = body.id ?? `watch-${watches.length + 1}`; watches.push({ id, bot: body.bot, enabled: body.enabled, spec: body.spec }); return { watches, saved: id } }
        if (body?.action === 'delete') return { watches }
        return { watches, runs: [{ bot: 'b2', session_uuid: 'run-1' }] }
      }
      if (path.includes('/workbench/bot-tasks')) {
        if (body?.action === 'upsert') {
          const task = { id: body.task.id ?? `task-${tasks.length + 1}`, kind: 'task', status: 'planned', reason: '', detail: '', updated: 1, ...body.task }
          tasks.push(task); return { task }
        }
        return { tasks }
      }
      if (path.includes('/workbench/progress')) return { since: Number(new URL(`http://x${path}`).searchParams.get('since')), path }
      throw new Error(`unexpected ${path}`)
    },
  }
  return { admin, calls, tasks, watches }
}
const agent = (id, cwd = '/repo') => ({ id, session: { header: { cwd } } })
const tool = (admin, a, name) => Object.fromEntries(botTools(admin, a).map(([n, , , run]) => [n, run]))[name]

test('a session belongs to the bot whose main, filed, run or own folder it is', async () => {
  const { admin } = fakeAdmin()
  assert.equal((await ownerOf(admin, 'main-1', '/repo')).bot.id, 'b1')
  assert.equal((await ownerOf(admin, 'helper-1', '/repo')).bot.id, 'b2', 'filed under a bot')
  assert.equal((await ownerOf(admin, 'run-1', '/repo')).bot.id, 'b2', 'a watch run')
  assert.equal((await ownerOf(admin, 'side', '/bots/b1/assets')).bot.id, 'b1', 'its own folder')
  assert.equal((await ownerOf(admin, 'stranger', '/bots/b10')).bot, undefined)
  await assert.rejects(tool(admin, agent('stranger'), 'bot_tasks_list')({}), /不属于任何伙伴/)
})

test('a bot keeps its own task board and links the conversation doing a task', async () => {
  const { admin, calls, tasks } = fakeAdmin()
  const update = tool(admin, agent('main-1'), 'bot_task_update')
  const added = await update({ title: 'Fix login', due: '2026-12-01', link_session: 'helper-9' })
  const sent = calls.at(-1)[1].task
  assert.equal(sent.bot, 'b1')
  assert.deepEqual(sent.session, { runtime: 'dsh', session_id: 'helper-9' })
  assert.equal(new Date(sent.due).getDate(), 1)
  assert.equal(added.title, 'Fix login')
  await update({ task_id: added.task_id, status: 'waiting', reason: 'CI 排队', due: 'none' })
  assert.deepEqual({ ...calls.at(-1)[1].task }, { id: added.task_id, bot: 'b1', status: 'waiting', reason: 'CI 排队', due: 0 })
  await assert.rejects(update({ title: 'x', due: 'someday' }), /截止时间/)
  tasks.push({ id: 't-closed', bot: 'b1', title: 'old', status: 'done', closed: 5, kind: 'task', updated: 1 })
  const listed = await tool(admin, agent('main-1'), 'bot_tasks_list')({})
  assert.ok(listed.tasks.every(row => row.status !== 'done'))
  assert.ok((await tool(admin, agent('main-1'), 'bot_tasks_list')({ include_closed: true })).tasks.some(row => row.task_id === 't-closed'))
})

test('plans wait for the user and schedules become time-triggered watches', async () => {
  const { admin, calls, watches } = fakeAdmin()
  const plan = await tool(admin, agent('main-1'), 'bot_plan_propose')({ title: 'Ship v2', summary: 'why', steps: [{ title: 'Migrate' }, { title: ' ' }, { title: 'Docs', detail: 'README' }] })
  const task = calls.at(-1)[1].task
  assert.equal(task.kind, 'plan'); assert.equal(task.status, 'needs_user')
  assert.deepEqual(task.payload.steps, [{ title: 'Migrate' }, { title: 'Docs', detail: 'README' }])
  assert.equal(plan.status, 'waiting_for_user')
  await assert.rejects(tool(admin, agent('main-1'), 'bot_plan_propose')({ title: 'x', steps: [] }), /至少/)

  const saved = await tool(admin, agent('main-1'), 'bot_schedule_upsert')({ name: '站会', cron: '0 9 * * 1-5', instructions: '写站会', wecom_chat_id: 'g1' })
  assert.equal(saved.schedule_id, 'watch-1')
  assert.deepEqual(watches[0].spec.on, { topic: 'schedule', match: { cron: '0 9 * * 1-5' } })
  assert.equal(watches[0].spec.policy.post_to_wecom, 'g1')
  assert.equal(watches[0].spec.policy.permission, 'plan', 'routines are read-only unless asked')
  const listed = await tool(admin, agent('main-1'), 'bot_schedules_list')({})
  assert.deepEqual(listed.schedules.map(row => [row.schedule_id, row.cron, row.wecom_chat_id]), [['watch-1', '0 9 * * 1-5', 'g1']])
  await assert.rejects(tool(admin, agent('main-1'), 'bot_schedule_delete')({ schedule_id: 'watch-404' }), /找不到/)
  assert.throws(() => scheduleSpec({ name: '', cron: '0 9 * * *', instructions: 'x' }), /名字/)
})

test('the progress snapshot is bounded and scoped to the bot', async () => {
  const { admin } = fakeAdmin()
  const before = Date.now()
  const snap = await tool(admin, agent('main-1'), 'kode_progress_snapshot')({ since_hours: 9999, workspace: '/repo' })
  assert.ok(snap.since >= before - 336 * 3_600_000 - 1000 && snap.since <= before - 336 * 3_600_000 + 1000)
  assert.match(snap.path, /bot=b1/)
  assert.match(snap.path, /workspace=%2Frepo/)
})

test('a bot that drafts outbound messages leaves WeCom sends for the user', async () => {
  const drafting = fakeAdmin({ outbound: 'draft' })
  const draft = await draftOutbound(drafting.admin, agent('main-1'), { chat_id: 'g1', content: '周报已更新\n详情见文档' }, undefined)
  assert.equal(draft.drafted, true)
  const task = drafting.calls.at(-1)[1].task
  assert.equal(task.kind, 'outbound'); assert.equal(task.status, 'needs_user')
  assert.deepEqual(task.payload, { channel: 'wecom', chat_id: 'g1', content: '周报已更新\n详情见文档', format: 'markdown' })
  assert.equal(await draftOutbound(fakeAdmin().admin, agent('main-1'), { chat_id: 'g1', content: 'x' }), null, 'direct bots send as before')
  assert.equal(await draftOutbound(drafting.admin, agent('stranger'), { chat_id: 'g1', content: 'x' }), null, 'ordinary sessions send as before')
  assert.match(taskAssignment('Fix it', 'task-1'), /task-1[\s\S]*状态：完成/)
})

test('the bots API proxies task actions and sends an approved draft once', async () => {
  let handler
  const calls = [], sent = []
  const draft = { id: 'task-d', kind: 'outbound', status: 'needs_user', payload: { channel: 'wecom', chat_id: 'g1', content: 'old', format: 'markdown' } }
  const backend = { call: async (path, body) => {
    calls.push([path, body])
    if (path.endsWith('/bot-tasks') && !body) return { tasks: [draft] }
    if (body?.action === 'upsert' && body.task?.status === 'done') draft.status = 'done'
    return { task: body?.task ?? null }
  } }
  const wecom = { sendMessage: async args => { sent.push(args); return { ok: true } } }
  registerBotsApi({ get: () => undefined, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) }, webServer: { register: route => { handler = route.handler } } }, backend, { wecom })
  const post = async body => { const res = { setHeader() {}, end(text) { this.body = JSON.parse(text) } }; await handler({ method: 'POST', async *[Symbol.asyncIterator]() { yield JSON.stringify(body) } }, res); return res }
  await post({ action: 'task_approve', id: 'plan-1', note: 'ok' })
  assert.deepEqual(calls.at(-1), ['/api/v1/messaging/workbench/bot-tasks', { id: 'plan-1', note: 'ok', action: 'approve' }])
  const res = await post({ action: 'outbox_send', id: 'task-d', content: '改过的内容' })
  assert.deepEqual(res.body, { sent: true })
  assert.deepEqual(sent, [{ chat_id: 'g1', content: '改过的内容', format: 'markdown' }])
  assert.equal(calls.at(-1)[1].task.status, 'done')
  assert.equal(calls.at(-1)[1].task.payload.content, '改过的内容')
  assert.equal((await post({ action: 'outbox_send', id: 'task-d' })).body.error, '这条草稿已经处理过了')
  assert.equal(sent.length, 1)
})

test('tui-originated bot main sessions and adopted subtasks are recognized seamlessly in dsh', async () => {
  const { botsView } = await import('../src/bots-api.js')
  const roster = {
    default_bot: 'b1',
    bots: [
      { id: 'b1', name: 'Kit', backend_key: 'claude', main_session: { runtime: 'gui', session_id: 'uuid-tui-main' } },
    ],
    adopted: { 'uuid-tui-worker': 'b1' },
    main_aliases: { b1: ['uuid-tui-main', 'dsh-imported-main'] },
    adopted_aliases: { 'uuid-tui-worker': 'b1', 'dsh-imported-worker': 'b1' },
    homes: { b1: '/bots/b1' },
  }
  const runtime = {
    profiles: { list: () => [], sharedState: {} },
    hasRuntime: () => true,
    bindings: new Map([
      ['dsh-bound-main', { threadId: 'uuid-tui-main' }],
      ['dsh-bound-worker', { threadId: 'uuid-tui-worker' }],
    ]),
  }
  const view = botsView(roster, {
    runtime,
    sessions: [
      { sessionId: 'dsh-bound-main', title: 'Kit Main', updatedAt: 20 },
      { sessionId: 'dsh-bound-worker', title: 'Worker Subtask', updatedAt: 10 },
    ],
    archived: new Set(),
    workspaces: [],
  })
  assert.equal(view.bots[0].main_session_id, 'dsh-bound-main')
  assert.deepEqual(
    view.bots[0].sessions.map(s => [s.id, s.kind, s.adopted]),
    [
      ['dsh-bound-main', 'main', false],
      ['dsh-bound-worker', 'subtask', true],
    ],
  )

  const admin = { call: async () => roster }
  const boundMainAgent = {
    id: 'dsh-bound-main',
    session: { header: { cwd: '/elsewhere' } },
    ctx: { get: key => (key === 'kodeAgents' ? runtime : undefined) },
  }
  assert.equal((await ownerOf(admin, 'dsh-bound-main', '/elsewhere', undefined, ['uuid-tui-main'])).bot.id, 'b1')
  assert.equal((await ownerOf(admin, 'dsh-imported-worker', '/elsewhere')).bot.id, 'b1')
  // Verify bot_tasks_list works for the imported TUI main session inside DSH
  const adminWithTasks = {
    call: async path => (path.endsWith('/workbench/bots') ? roster : { tasks: [] }),
  }
  const listRes = await tool(adminWithTasks, boundMainAgent, 'bot_tasks_list')({})
  assert.equal(listRes.bot, 'Kit')
})

