/**
 * Bots ("伙伴") in the dsh view. The roster lives in the Kode backend and is
 * shared with Kode GUI, extensions and phones; dsh runs a bot's conversation
 * as an ordinary dsh session started with the bot's Agent, persona and
 * permission limit, and records it as the bot's main session.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { admitHostRequest } from './host-admission.js'
import { installLocal, installSkillHub, localSkills, removeSkill, repairSkillLinks, skillhub, skillRecord, validSlug } from './bot-skills.js'
import { BotConnectors, CONNECTOR_CATALOG, MCP_APP_CATALOG, connectorsPrompt } from './bot-connectors.js'
import { BotVoiceStore, DEFAULT_TONE, TONE_PRESETS, normalizeTone, tonePrompt } from './bot-voice.js'
import { runWeComTool } from './wecom-bridge.js'

const STORES = new WeakMap()

const BOTS = '/api/v1/messaging/workbench/bots'
const WATCHES = '/api/v1/messaging/workbench/watches'
const TASKS = '/api/v1/messaging/workbench/bot-tasks'
const ROSTER_ACTIONS = ['upsert', 'delete', 'set_default', 'set_root', 'adopt', 'set_quiet_hours']
// Task board: `task_<action>` is Kode's task action.
const TASK_ACTIONS = ['task_upsert', 'task_delete', 'task_approve', 'task_reject']
// 关注 (bot watches): `watch_<action>` is Kode's watch action.
const WATCH_ACTIONS = ['watch_upsert', 'watch_toggle', 'watch_delete', 'watch_run', 'watch_seen']
const TEMPLATES = new URL('../assets/bot-templates.json', import.meta.url)
const BUILDER_SKILL = new URL('../assets/skills/kode-bot-builder/SKILL.md', import.meta.url)
// Fields the dsh view adds; the roster stores everything else.
const VIEW_FIELDS = ['agent', 'agent_type', 'agent_id', 'main_session_id', 'workspace', 'home', 'sessions', 'connectors', 'tone', 'tone_note']
export const storedBot = bot => Object.fromEntries(Object.entries(bot).filter(([key]) => !VIEW_FIELDS.includes(key)))
let catalog
function templateCatalog() {
  catalog ??= readFile(TEMPLATES, 'utf8').then(text => JSON.parse(text)).catch(error => { catalog = undefined; throw error })
  return catalog
}
export async function botTemplates() { return (await templateCatalog()).templates }
/** Recurring routines (standup, weekly brief, …) a bot can be given. */
export async function botRoutines() { return (await templateCatalog()).routines ?? [] }
// dsh sandbox modes. New dsh sessions never start above workspace-write.
const MODES = { plan: 'read-only', default: 'workspace-write', acceptEdits: 'workspace-write', bypassPermissions: 'workspace-write' }

/** The dsh Agent profile that runs `backendKey`, if this Host has one. */
// The Agents dsh offers: shadowed built-in twins of a desktop-configured
// Agent are hidden there, and session creation only accepts what is offered.
// `dsh` is DeepSeek Harness itself: it runs in-process and needs its own model
// provider, so it cannot be a bot's Agent the way a CLI can.
export const botAgentTypes = profile => profile.type !== 'dsh'
function offered(runtime) {
  return (runtime?.appearance?.profilesView() ?? runtime?.profiles.list() ?? []).filter(profile => runtime.hasRuntime(profile.type) && botAgentTypes(profile))
}

export function agentFor(runtime, backendKey) {
  const profiles = offered(runtime)
  const desktop = runtime?.profiles.sharedState?.desktop_ids ?? {}
  return profiles.find(profile => desktop[profile.id] === backendKey) ?? profiles.find(profile => profile.type === backendKey) ?? null
}

/** A session belongs to a bot when it is the bot's main conversation, runs
 *  in the bot's own folder (generated assets, side tasks) or is one of its
 *  watch runs. Each bot sees only its own. */
function inside(path, folder) { return Boolean(path && folder) && (path === folder || path.startsWith(`${folder.replace(/\/$/, '')}/`)) }
export function botsView(roster, { runtime, sessions, archived, workspaces, runs = [], templates = [], routines = [], connectors = [], connectorCatalog = CONNECTOR_CATALOG, mcpAppCatalog = MCP_APP_CATALOG, connectorEnv = null, voices = {}, tonePresets = TONE_PRESETS }) {
  const live = new Set(sessions.map(row => row.sessionId))
  // One owner per session: a main conversation, one filed under a bot, then
  // a folder, then a run.
  const owner = new Map()
  for (const bot of roster.bots) if (bot.main_session?.runtime === 'dsh') owner.set(bot.main_session.session_id, bot.id)
  const known = new Set(roster.bots.map(bot => bot.id))
  for (const [session, bot] of Object.entries(roster.adopted ?? {})) if (known.has(bot) && !owner.has(session)) owner.set(session, bot)
  for (const row of sessions) for (const bot of roster.bots) if (!owner.has(row.sessionId) && inside(row.cwd, roster.homes?.[bot.id])) owner.set(row.sessionId, bot.id)
  for (const run of runs) if (run.session_uuid && !owner.has(run.session_uuid)) owner.set(run.session_uuid, run.bot)
  return {
    default_bot: roster.default_bot ?? null,
    bots: roster.bots.map(bot => {
      const main = bot.main_session?.runtime === 'dsh' ? bot.main_session.session_id : null
      const agent = agentFor(runtime, bot.backend_key)
      const home = roster.homes?.[bot.id] ?? null
      const ran = new Set(runs.filter(run => run.bot === bot.id && run.session_uuid).map(run => run.session_uuid))
      const owned = sessions
        .filter(row => !archived.has(row.sessionId) && !row.blank && owner.get(row.sessionId) === bot.id)
        .map(row => ({ id: row.sessionId, title: row.projections?.values?.title ?? row.title ?? '未命名会话', updated_at: row.updatedAt ?? row.updated_at ?? 0, kind: row.sessionId === main ? 'main' : ran.has(row.sessionId) ? 'watch' : roster.adopted?.[row.sessionId] === bot.id ? 'subtask' : 'side', adopted: roster.adopted?.[row.sessionId] === bot.id }))
        .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      const botConnectors = connectors.filter(row => row.bot_id === bot.id)
      const voice = normalizeTone(voices?.[bot.id]?.tone ?? bot.tone ?? DEFAULT_TONE, voices?.[bot.id]?.tone_note ?? bot.tone_note ?? '')
      return { ...bot, workspace: roster.workspaces?.[bot.id] ?? bot.default_cwd ?? null, home, agent: agent?.name ?? null, agent_type: agent?.type ?? null, agent_id: agent?.id ?? null, main_session_id: main && live.has(main) && !archived.has(main) ? main : null, sessions: owned, connectors: botConnectors, tone: voice.tone, tone_note: voice.tone_note }
    }),
    root: roster.root ?? null,
    default_root: roster.default_root ?? null,
    agents: offered(runtime).map(profile => ({ profile_id: profile.id, name: profile.name, type: profile.type, backend_key: runtime.profiles.sharedState?.desktop_ids?.[profile.id] ?? profile.type })),
    workspaces: workspaces.map(row => ({ id: row.id, title: row.title, path: row.path })),
    templates,
    routines,
    connector_catalog: connectorCatalog,
    mcp_app_catalog: mcpAppCatalog,
    connector_env: connectorEnv,
    tone_presets: tonePresets,
    quiet_hours: roster.quiet_hours ?? null,
  }
}

/** The bot's own folder, created and registered in dsh under its name. */
export async function ensureBotHome(ctx, roster, bot) {
  const home = roster.homes?.[bot.id]
  if (!home) throw new Error('Kode 服务版本较旧，需要更新后才能给伙伴单独的文件夹')
  await mkdir(home, { recursive: true })
  await repairSkillLinks(home, bot.skills)
  const registry = ctx.get('workspaceRegistry')
  const workspace = await registry?.resolveByPath?.(home) ?? await registry?.create?.(home, bot.name)
  return { path: home, workspace_id: workspace?.id ?? null }
}

/** Start a dsh session as `bot` with `task`, in `workspace` (registered in
 *  dsh on first use). Shared by the 伙伴 page and watch runs. */
export async function launchBot(ctx, roster, bot, { task, workspace, permission, title, key, voice, connectors = [], includeTone = true, includeConnectors = true, initialMessageSource }) {
  const runtime = ctx.get('kodeAgents'), creator = ctx.get('kodeSessionCreator'), registry = ctx.get('workspaceRegistry')
  if (!runtime || !creator) throw new Error('dsh 还在启动，请稍后再试')
  const agent = agentFor(runtime, bot.backend_key)
  if (!agent) throw new Error(`伙伴使用的 Agent（${bot.backend_key}）在这台电脑的 dsh 里不可用`)
  if (!workspace) throw new Error('选择伙伴的工作区')
  if (registry && !registry.list().some(row => row.path === workspace)) {
    // The bot's own folder is created on first use and named after the bot.
    // Other folders (a watched repository) join dsh's catalog as they are.
    const own = !bot.default_cwd && workspace === roster.workspaces?.[bot.id]
    if (own) await mkdir(workspace, { recursive: true })
    if (!(await registry.resolveByPath?.(workspace))) await registry.create?.(workspace, own ? bot.name : undefined)
  }
  const styleBlock = includeTone ? tonePrompt(voice?.tone ?? bot.tone ?? DEFAULT_TONE, voice?.tone_note ?? bot.tone_note ?? '') : ''
  const connectorBlock = includeConnectors ? connectorsPrompt(connectors, bot.name) : ''
  const parts = [roster.persona_prompts?.[bot.id] ?? '', styleBlock, connectorBlock, task.trim()].filter(Boolean)
  return creator.create({
    title: title ?? bot.name,
    // The persona and tone ride on the first message: dsh sessions have no system prompt flag.
    task: parts.join('\n\n'),
    agent: agent.id,
    workspace,
    ...(bot.model ? { model: bot.model } : {}),
    permission,
    idempotency_key: key,
    ...(initialMessageSource ? { initial_message_source: initialMessageSource } : {}),
  })
}

/** Runtime command `bot_run`: Kode's watch dispatcher starts a bot's run. */
export async function runBotForWatch(ctx, backend, payload, requestId) {
  const roster = await backend.call(BOTS)
  const bot = roster.bots.find(row => row.id === payload.bot_id)
  if (!bot) throw new Error('这个伙伴已不存在')
  if (typeof payload.task !== 'string' || !payload.task.trim()) throw new Error('Run task required')
  const stores = STORES.get(backend)
  const voiceStore = stores?.voiceStore ?? new BotVoiceStore(backend)
  const connectorsStore = stores?.connectorsStore ?? new BotConnectors(backend)
  const [voice, rawConnectors] = await Promise.all([
    voiceStore.get(bot.id).catch(() => null),
    connectorsStore.readAll().catch(() => []),
  ])
  const connectors = rawConnectors
    .filter(row => row.bot_id === bot.id)
    .map(row => connectorsStore.publicView(row, bot.name))
  const created = await launchBot(ctx, roster, bot, {
    task: payload.task,
    workspace: payload.workspace || roster.workspaces?.[bot.id],
    // Watches run at most at workspace-write; Kode already capped it to the bot's ceiling.
    permission: payload.permission === 'plan' ? 'read-only' : 'workspace-write',
    title: payload.title,
    key: `watch-${createHash('sha256').update(requestId).digest('hex').slice(0, 40)}`,
    voice,
    connectors,
  })
  return created.address.session_id
}

/** First message of a newly created bot's main session: proactively greets
 *  the user like a real teammate (anti-robotic, following the bot's tone
 *  preset), introduces itself and its ready setup, and asks what to tackle
 *  first (without making writes or external sends). */
export function greetingPrompt(bot, { connectors = [], watches = [], voice = null } = {}) {
  const skills = (bot.skills ?? []).map(row => row.name || row.slug).filter(Boolean)
  const enabledConnectors = connectors.filter(row => row.enabled !== false)
  const scheduled = watches.filter(row => row.bot === bot.id)
  const styleBlock = tonePrompt(voice?.tone ?? bot.tone ?? DEFAULT_TONE, voice?.tone_note ?? bot.tone_note ?? '')
  const lines = [
    '你刚被用户创建好，这是你们的第一次碰面。',
    styleBlock,
    '',
    '开场打招呼要求：',
    '- 像真人搭档第一天入职走到工位旁打招呼一样，用 **3–5 句自然的口语** 向用户自我介绍并打招呼。',
    '- **严禁人机味**：不要写成说明书或客服开场白，不要用「大家好！我是XXX，我的核心能力如下：1. 2. 3.」「请问有什么可以帮您？」「期待与您合作！」。',
    '- 自然带出你叫什么、主要帮他管什么事；已经装好的技能、连上的连接器或定好的节奏顺嘴提一句即可（没接连接器就随口说以后随时能在「连接器」里加，不用念清单）。',
    '- 结尾顺手抛 1–2 件现在就能开工的具体事，或者直接问一句手头最先想推哪块。',
    '- 重要限制：本轮只聊天打招呼，不要改文件、不要跑写操作命令、也不要主动对外发消息。',
    '',
    '你的当前配置（仅供你心里有数，自然融入话里，不要照抄念出来）：',
    `- 名字：${bot.name}`,
    ...(bot.tagline ? [`- 定位：${bot.tagline}`] : []),
    ...(skills.length ? [`- 已装技能：${skills.join('、')}`] : []),
    ...(enabledConnectors.length
      ? [`- 已接入连接器：${enabledConnectors.map(c => `${c.name}${c.how_to_ask ? `（${c.how_to_ask}）` : ''}`).join('；')}`]
      : ['- 已接入连接器：暂未接入（后续可随时在「连接器」里加企微、GitHub、Webhook 或官方 MCP 应用）']),
    ...(scheduled.length
      ? [`- 已配置日常/关注：${scheduled.map(w => `${w.spec?.name || '定时任务'}${w.enabled ? '' : '（当前暂停）'}`).join('、')}`]
      : []),
  ]
  return lines.join('\n')
}

/** First message of a 创建伙伴 conversation: the builder skill and the only
 *  values its proposal may use on this Host. */
export async function builderPrompt({ agents, avatars, workspaces, template, routines = [], connectors = CONNECTOR_CATALOG, connectorEnv = null }) {
  const skill = await readFile(BUILDER_SKILL, 'utf8')
  const context = {
    agents: agents.map(row => ({ backend_key: row.backend_key, name: row.name, type: row.type })),
    avatars: avatars.map(row => ({ id: row.id, name: row.name })),
    banners: ['preset:blurple', 'preset:aurora', 'preset:cyber', 'preset:sunset', 'preset:forest', 'preset:sakura', 'preset:ocean', 'preset:amber'],
    tones: TONE_PRESETS.map(row => ({ id: row.id, label: row.label, summary: row.summary })),
    routines: routines.map(row => ({ id: row.id, name: row.name, cron: row.cron, when: row.when, summary: row.summary })),
    connectors: connectors.map(row => ({ type: row.type, name: row.name, summary: row.summary })),
    mcp_apps: MCP_APP_CATALOG.map(row => ({ id: row.id, name: row.name, category: row.category, summary: row.summary })),
    ...(connectorEnv ? { connector_env: connectorEnv } : {}),
    permission_ceilings: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
    workspaces: workspaces.slice(0, 40).map(row => ({ title: row.title, path: row.path })),
    ...(template ? { template } : {}),
  }
  const opening = template
    ? `我想从模板「${template.name}」开始创建伙伴。先简单介绍这个模板，再按步骤确认需要调整的地方。`
    : '我想创建一个新伙伴，请一步步引导我。'
  return `${skill.replace(/^---[\s\S]*?---\s*/, '')}\n\n## 上下文\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${opening}`
}

export function registerBotsApi(ctx, backend, { fetcher = globalThis.fetch, wecom = null, execFile, storageDir } = {}) {
  const send = (res, status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
  const connectorsStore = new BotConnectors(backend, {
    wecom,
    ...(execFile ? { execFile } : {}),
    ...(storageDir ? { storageFile: join(storageDir, 'dsh-bot-connectors.json') } : {}),
  })
  const voiceStore = new BotVoiceStore(backend, {
    ...(storageDir ? { storageFile: join(storageDir, 'dsh-bot-voice.json') } : {}),
  })
  if (backend && typeof backend === 'object') STORES.set(backend, { connectorsStore, voiceStore })
  const view = async roster => {
    const registry = ctx.get('workspaceRegistry')
    const sessions = (await ctx.get('sessionController')?.list({}))?.items ?? []
    // Older Kode has no watches; bots still list their other sessions.
    const watchData = await backend.call(WATCHES).catch(() => null)
    if (watchData?.watches?.length) {
      await connectorsStore.pruneOrphanWatches(watchData.watches).catch(() => {})
    }
    const runs = watchData?.runs ?? []
    const resolvedRoster = roster ?? await backend.call(BOTS)
    const botNames = new Map(resolvedRoster.bots.map(row => [row.id, row.name]))
    const [rawConnectors, connectorEnv, voices] = await Promise.all([
      connectorsStore.readAll().catch(() => []),
      connectorsStore.environment().catch(() => null),
      voiceStore.readAll().catch(() => ({})),
    ])
    const connectors = rawConnectors.map(row => connectorsStore.publicView(row, botNames.get(row.bot_id) ?? '伙伴'))
    return botsView(resolvedRoster, {
      runtime: ctx.get('kodeAgents'),
      sessions,
      archived: new Set(registry?.archivedSessionIds ?? []),
      workspaces: registry?.list() ?? [],
      runs,
      templates: await botTemplates().catch(() => []),
      routines: await botRoutines().catch(() => []),
      connectors,
      connectorCatalog: CONNECTOR_CATALOG,
      connectorEnv,
      voices,
    })
  }
  const botById = async id => {
    const roster = await backend.call(BOTS), bot = roster.bots.find(row => row.id === id)
    if (!bot) throw new Error('这个伙伴已不存在')
    const home = roster.homes?.[bot.id]
    if (!home) throw new Error('Kode 服务版本较旧，需要更新后才能给伙伴安装技能')
    await mkdir(home, { recursive: true })
    return { roster, bot, home }
  }
  // Installs touch one folder and rewrite the bot record: one at a time.
  let skillChain = Promise.resolve()
  const serial = task => { const run = skillChain.then(task); skillChain = run.catch(() => {}); return run }
  const installSkill = input => serial(async () => {
    const { bot, home } = await botById(input.id)
    if (!validSlug(input.slug)) throw new Error('无效的技能标识')
    if (!['skillhub', 'local'].includes(input.source)) throw new Error('未知的技能来源')
    if (!bot.skills?.some(row => row.slug === input.slug) && (bot.skills?.length ?? 0) >= 32) throw new Error('一个伙伴最多安装 32 个技能')
    const skipped = input.source === 'skillhub' ? await installSkillHub(home, input.slug, { fetcher }) : await installLocal(home, input.slug, input.path)
    const record = skillRecord(input.source, { slug: input.slug, name: input.name, description: input.description })
    const skills = [...(bot.skills ?? []).filter(row => row.slug !== input.slug), record]
    await backend.call(BOTS, { action: 'upsert', bot: { ...storedBot(bot), skills } })
    return skipped
  })
  const dropSkill = input => serial(async () => {
    const { bot, home } = await botById(input.id)
    await removeSkill(home, input.slug)
    await backend.call(BOTS, { action: 'upsert', bot: { ...storedBot(bot), skills: (bot.skills ?? []).filter(row => row.slug !== input.slug) } })
  })
  // A drafted outbound message, sent once the user approves it (optionally edited).
  const sendDraft = async input => {
    const { tasks } = await backend.call(TASKS)
    const draft = tasks.find(row => row.id === input.id)
    if (!draft || draft.kind !== 'outbound') throw new Error('这条草稿已不存在')
    if (draft.status !== 'needs_user') throw new Error('这条草稿已经处理过了')
    const content = typeof input.content === 'string' && input.content.trim() ? input.content.slice(0, 8000) : draft.payload?.content
    if (draft.payload?.channel !== 'wecom' || !draft.payload?.chat_id || !content) throw new Error('草稿缺少发送目标或内容')
    if (!wecom) throw new Error('企业微信机器人桥接尚未就绪')
    await runWeComTool(wecom, 'wecom_message_send', { chat_id: draft.payload.chat_id, content, format: draft.payload.format ?? 'markdown' })
    await backend.call(TASKS, { action: 'upsert', task: { id: draft.id, status: 'done', reason: '已发送', detail: content, payload: { ...draft.payload, content } } })
  }
  const builder = async input => {
    const runtime = ctx.get('kodeAgents'), creator = ctx.get('kodeSessionCreator'), registry = ctx.get('workspaceRegistry')
    if (!runtime || !creator) throw new Error('dsh 还在启动，请稍后再试')
    const roster = await backend.call(BOTS)
    const agents = offered(runtime)
    const agent = agents.find(row => row.id === input.agent_id) ?? agents.find(row => row.id === runtime.profiles.defaultProfileId) ?? agents[0]
    if (!agent) throw new Error('这台电脑的 dsh 里还没有可用的 Agent')
    const template = typeof input.template === 'string' ? (await botTemplates()).find(row => row.id === input.template) : undefined
    if (input.template && !template) throw new Error('这个模板已不存在')
    const root = roster.root ?? roster.default_root
    if (!root) throw new Error('Kode 服务版本较旧，需要更新后才能创建伙伴')
    const workspace = join(root, '.builder')
    await mkdir(workspace, { recursive: true })
    if (registry && !(await registry.resolveByPath?.(workspace))) await registry.create?.(workspace, '创建伙伴')
    const viewData = botsView(roster, { runtime, sessions: [], archived: new Set(), workspaces: registry?.list() ?? [] })
    const connectorEnv = await connectorsStore.environment().catch(() => null)
    const task = await builderPrompt({
      agents: viewData.agents,
      avatars: await runtime.appearance?.gallery().catch(() => []) ?? [],
      workspaces: viewData.workspaces.filter(row => row.path !== workspace),
      template,
      routines: await botRoutines().catch(() => []),
      connectors: CONNECTOR_CATALOG,
      connectorEnv,
    })
    const created = await creator.create({
      title: template ? `创建伙伴 · ${template.name}` : '创建伙伴', task, agent: agent.id, workspace,
      // Searching SkillHub needs the network; the skill forbids writes.
      permission: 'workspace-write',
      idempotency_key: String(input.idempotency_key ?? '').slice(0, 160) || `bot-builder-${Date.now()}`,
      initial_message_source: 'kode-bootstrap',
    })
    return { sessionId: created.address.session_id }
  }
  const homes = async (only) => {
    const roster = await backend.call(BOTS)
    for (const bot of roster.bots) if (!only || bot.id === only) await ensureBotHome(ctx, roster, bot).catch(() => {})
    return roster
  }
  const start = async input => {
    const roster = await backend.call(BOTS)
    const bot = roster.bots.find(row => row.id === input.id)
    if (!bot) throw new Error('这个伙伴已不存在')
    if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('先写下要对伙伴说的第一句话')
    const [voice, rawConnectors] = await Promise.all([
      voiceStore.get(bot.id).catch(() => null),
      connectorsStore.readAll().catch(() => []),
    ])
    const connectors = rawConnectors
      .filter(row => row.bot_id === bot.id)
      .map(row => connectorsStore.publicView(row, bot.name))
    const created = await launchBot(ctx, roster, bot, {
      task: input.message,
      workspace: input.workspace || roster.workspaces?.[bot.id] || bot.default_cwd,
      permission: MODES[bot.permission_ceiling] ?? 'read-only',
      key: String(input.idempotency_key ?? '').slice(0, 160) || `bot-${bot.id}-${Date.now()}`,
      voice,
      connectors,
    })
    const sessionId = created.address.session_id
    await backend.call(BOTS, { action: 'set_main_session', id: bot.id, session: { runtime: 'dsh', session_id: sessionId } })
    return { sessionId }
  }
  const greet = async input => {
    const roster = await backend.call(BOTS)
    const bot = roster.bots.find(row => row.id === input.id)
    if (!bot) throw new Error('这个伙伴已不存在')
    // If this bot already has a live non-archived main session and force isn't set, reuse it.
    if (!input.force && bot.main_session?.runtime === 'dsh') {
      const registry = ctx.get('workspaceRegistry')
      const archived = new Set(registry?.archivedSessionIds ?? [])
      const sessions = (await ctx.get('sessionController')?.list({}))?.items ?? []
      const liveId = bot.main_session.session_id
      if (liveId && !archived.has(liveId) && sessions.some(row => row.sessionId === liveId)) {
        return { sessionId: liveId, alreadyStarted: true }
      }
    }
    const [rawConnectors, watchData, voice] = await Promise.all([
      connectorsStore.readAll().catch(() => []),
      backend.call(WATCHES).catch(() => null),
      voiceStore.get(bot.id).catch(() => null),
    ])
    const botConnectors = rawConnectors
      .filter(row => row.bot_id === bot.id)
      .map(row => connectorsStore.publicView(row, bot.name))
    const task = greetingPrompt(bot, { connectors: botConnectors, watches: watchData?.watches ?? [], voice })
    const created = await launchBot(ctx, roster, bot, {
      task,
      workspace: input.workspace || roster.workspaces?.[bot.id] || bot.default_cwd,
      // Greeting only introduces the bot; read-only prevents accidental side effects.
      permission: 'read-only',
      key: String(input.idempotency_key ?? '').slice(0, 160) || `bot-greet-${bot.id}-${Date.now()}`,
      voice,
      includeTone: false,
      includeConnectors: false,
      initialMessageSource: 'kode-bootstrap',
    })
    const sessionId = created.address.session_id
    await backend.call(BOTS, { action: 'set_main_session', id: bot.id, session: { runtime: 'dsh', session_id: sessionId } })
    return { sessionId }
  }
  const disposeWebhooks = ctx.webServer.register({ kind: 'prefix', path: '/api/kode/bot-webhooks', auth: 'anonymous', handler: async (req, res) => {
    await connectorsStore.handleWebhook(req, res)
  } })
  const disposeBots = ctx.webServer.register({ kind: 'exact', path: '/api/kode/bots', handler: async (req, res, peer) => {
    const admitted = admitHostRequest(ctx, req, peer)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(res, 403, { error: 'Host owner required' })
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://host').searchParams
        if (query.has('skillhub')) return send(res, 200, await skillhub(query, { fetcher }))
        if (query.get('skills') === 'local') return send(res, 200, { skills: await localSkills() })
        if (!query.has('watches')) return send(res, 200, await view())
        // Long poll: Kode answers when watches or runs change (or after a while).
        const after = Number(query.get('after'))
        const hasAfter = Number.isSafeInteger(after) && after >= 0 && query.has('after')
        let watchResult = await backend.call(hasAfter ? `${WATCHES}?after=${after}` : WATCHES)
        if (!hasAfter && watchResult?.watches?.length) {
          const pruned = await connectorsStore.pruneOrphanWatches(watchResult.watches).catch(() => [])
          if (pruned.length) watchResult = await backend.call(WATCHES)
        }
        return send(res, 200, watchResult)
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST required' })
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) return send(res, 413, { error: 'Request too large' }) }
      const input = JSON.parse(body)
      if (ROSTER_ACTIONS.includes(input?.action)) {
        if (input.action === 'upsert' && input.bot && typeof input.bot === 'object') {
          const hasVoice = 'tone' in input.bot || 'tone_note' in input.bot
          const voicePatch = hasVoice ? { tone: input.bot.tone, tone_note: input.bot.tone_note } : null
          const beforeIds = !input.bot.id && hasVoice
            ? new Set((await backend.call(BOTS).catch(() => null))?.bots?.map(row => row.id) ?? [])
            : null
          await backend.call(BOTS, { ...input, bot: storedBot(input.bot) })
          // Every bot has its own folder from the start.
          const after = await homes()
          if (voicePatch) {
            const targetId = input.bot.id || after.bots.find(row => !beforeIds?.has(row.id))?.id
            if (targetId) await voiceStore.set(targetId, voicePatch).catch(() => {})
          }
          return send(res, 200, await view(after))
        }
        await backend.call(BOTS, input)
        if (input.action === 'delete' && input.id) {
          await connectorsStore.removeForBot(input.id).catch(() => {})
          await voiceStore.remove(input.id).catch(() => {})
        }
        return send(res, 200, await view())
      }
      if (input?.action === 'home') {
        const roster = await backend.call(BOTS), bot = roster.bots.find(row => row.id === input.id)
        if (!bot) throw new Error('这个伙伴已不存在')
        return send(res, 200, await ensureBotHome(ctx, roster, bot))
      }
      if (input?.action === 'start') return send(res, 200, await start(input))
      if (input?.action === 'greet') return send(res, 200, await greet(input))
      if (input?.action === 'builder') return send(res, 200, await builder(input))
      if (input?.action === 'skill_install') {
        const skipped = await installSkill(input)
        return send(res, 200, { ...await view(), ...(skipped.length ? { skipped } : {}) })
      }
      if (input?.action === 'skill_remove') { await dropSkill(input); return send(res, 200, await view()) }
      if (input?.action === 'connector_upsert') {
        const roster = await backend.call(BOTS), bot = roster.bots.find(row => row.id === input.bot_id)
        if (!bot) throw new Error('这个伙伴已不存在')
        const connector = await connectorsStore.upsert(bot, input.connector ?? input)
        return send(res, 200, { ...await view(), connector })
      }
      if (input?.action === 'connector_toggle') {
        await connectorsStore.toggle(input.id, input.enabled)
        return send(res, 200, await view())
      }
      if (input?.action === 'connector_delete') {
        await connectorsStore.remove(input.id)
        return send(res, 200, await view())
      }
      if (input?.action === 'connector_rotate') {
        const rotated = await connectorsStore.rotateSecret(input.id)
        return send(res, 200, { ...await view(), connector_id: rotated.id })
      }
      if (input?.action === 'connector_test') {
        const result = await connectorsStore.test(input.id)
        return send(res, 200, { ...result, ...await view() })
      }
      if (TASK_ACTIONS.includes(input?.action)) {
        const { action, ...rest } = input
        return send(res, 200, await backend.call(TASKS, { ...rest, action: action.slice('task_'.length) }))
      }
      if (input?.action === 'outbox_send') { await sendDraft(input); return send(res, 200, { sent: true }) }
      if (WATCH_ACTIONS.includes(input?.action)) {
        const result = await backend.call(WATCHES, { ...input, action: input.action.slice('watch_'.length) })
        if (input.action === 'watch_toggle' && input.id) {
          await connectorsStore.syncByWatchToggle(input.id, input.enabled).catch(() => {})
        } else if (input.action === 'watch_delete' && input.id) {
          await connectorsStore.removeByWatchId(input.id).catch(() => {})
        }
        return send(res, 200, result)
      }
      if (input?.action === 'forget') {
        await backend.call(BOTS, { action: 'set_main_session', id: input.id, session: null })
        return send(res, 200, await view())
      }
      return send(res, 400, { error: 'Unknown bot action' })
    } catch (error) {
      if (error.status === 404) return send(res, 503, { code: 'KODE_SERVICE_UPDATE_REQUIRED', error: 'Kode 服务版本较旧，需要更新并重启后才能使用伙伴。' })
      return send(res, 400, { error: error.message })
    }
  } })
  return () => { disposeBots?.(); disposeWebhooks?.() }
}
