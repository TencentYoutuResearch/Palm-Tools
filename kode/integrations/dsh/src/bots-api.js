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

const BOTS = '/api/v1/messaging/workbench/bots'
const WATCHES = '/api/v1/messaging/workbench/watches'
const ROSTER_ACTIONS = ['upsert', 'delete', 'set_default', 'set_root', 'adopt']
// 关注 (bot watches): `watch_<action>` is Kode's watch action.
const WATCH_ACTIONS = ['watch_upsert', 'watch_toggle', 'watch_delete', 'watch_run', 'watch_seen']
const TEMPLATES = new URL('../assets/bot-templates.json', import.meta.url)
const BUILDER_SKILL = new URL('../assets/skills/kode-bot-builder/SKILL.md', import.meta.url)
// Fields the dsh view adds; the roster stores everything else.
const VIEW_FIELDS = ['agent', 'agent_type', 'agent_id', 'main_session_id', 'workspace', 'home', 'sessions']
export const storedBot = bot => Object.fromEntries(Object.entries(bot).filter(([key]) => !VIEW_FIELDS.includes(key)))
let templates
export async function botTemplates() {
  templates ??= readFile(TEMPLATES, 'utf8').then(text => JSON.parse(text).templates).catch(error => { templates = undefined; throw error })
  return templates
}
// dsh sandbox modes. New dsh sessions never start above workspace-write.
const MODES = { plan: 'read-only', default: 'workspace-write', acceptEdits: 'workspace-write', bypassPermissions: 'workspace-write' }

/** The dsh Agent profile that runs `backendKey`, if this Host has one. */
// The Agents dsh offers: shadowed built-in twins of a desktop-configured
// Agent are hidden there, and session creation only accepts what is offered.
function offered(runtime) {
  return (runtime?.appearance?.profilesView() ?? runtime?.profiles.list() ?? []).filter(profile => runtime.hasRuntime(profile.type))
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
export function botsView(roster, { runtime, sessions, archived, workspaces, runs = [], templates = [] }) {
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
      return { ...bot, workspace: roster.workspaces?.[bot.id] ?? bot.default_cwd ?? null, home, agent: agent?.name ?? null, agent_type: agent?.type ?? null, agent_id: agent?.id ?? null, main_session_id: main && live.has(main) && !archived.has(main) ? main : null, sessions: owned }
    }),
    root: roster.root ?? null,
    default_root: roster.default_root ?? null,
    agents: offered(runtime).map(profile => ({ profile_id: profile.id, name: profile.name, type: profile.type, backend_key: runtime.profiles.sharedState?.desktop_ids?.[profile.id] ?? profile.type })),
    workspaces: workspaces.map(row => ({ id: row.id, title: row.title, path: row.path })),
    templates,
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
export async function launchBot(ctx, roster, bot, { task, workspace, permission, title, key }) {
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
  return creator.create({
    title: title ?? bot.name,
    // The persona rides on the first message: dsh sessions have no system prompt flag.
    task: `${roster.persona_prompts?.[bot.id] ?? ''}\n\n${task.trim()}`.trim(),
    agent: agent.id,
    workspace,
    ...(bot.model ? { model: bot.model } : {}),
    permission,
    idempotency_key: key,
  })
}

/** Runtime command `bot_run`: Kode's watch dispatcher starts a bot's run. */
export async function runBotForWatch(ctx, backend, payload, requestId) {
  const roster = await backend.call(BOTS)
  const bot = roster.bots.find(row => row.id === payload.bot_id)
  if (!bot) throw new Error('这个伙伴已不存在')
  if (typeof payload.task !== 'string' || !payload.task.trim()) throw new Error('Run task required')
  const created = await launchBot(ctx, roster, bot, {
    task: payload.task,
    workspace: payload.workspace || roster.workspaces?.[bot.id],
    // Watches run at most at workspace-write; Kode already capped it to the bot's ceiling.
    permission: payload.permission === 'plan' ? 'read-only' : 'workspace-write',
    title: payload.title,
    key: `watch-${createHash('sha256').update(requestId).digest('hex').slice(0, 40)}`,
  })
  return created.address.session_id
}

/** First message of a 创建伙伴 conversation: the builder skill and the only
 *  values its proposal may use on this Host. */
export async function builderPrompt({ agents, avatars, workspaces, template }) {
  const skill = await readFile(BUILDER_SKILL, 'utf8')
  const context = {
    agents: agents.map(row => ({ backend_key: row.backend_key, name: row.name, type: row.type })),
    avatars: avatars.map(row => ({ id: row.id, name: row.name })),
    banners: ['preset:blurple', 'preset:aurora', 'preset:cyber', 'preset:sunset', 'preset:forest', 'preset:sakura', 'preset:ocean', 'preset:amber'],
    permission_ceilings: ['plan', 'default', 'acceptEdits', 'bypassPermissions'],
    workspaces: workspaces.slice(0, 40).map(row => ({ title: row.title, path: row.path })),
    ...(template ? { template } : {}),
  }
  const opening = template
    ? `我想从模板「${template.name}」开始创建伙伴。先简单介绍这个模板，再按步骤确认需要调整的地方。`
    : '我想创建一个新伙伴，请一步步引导我。'
  return `${skill.replace(/^---[\s\S]*?---\s*/, '')}\n\n## 上下文\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${opening}`
}

export function registerBotsApi(ctx, backend, { fetcher = globalThis.fetch } = {}) {
  const send = (res, status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
  const view = async roster => {
    const registry = ctx.get('workspaceRegistry')
    const sessions = (await ctx.get('sessionController')?.list({}))?.items ?? []
    // Older Kode has no watches; bots still list their other sessions.
    const runs = (await backend.call(WATCHES).catch(() => null))?.runs ?? []
    return botsView(roster ?? await backend.call(BOTS), { runtime: ctx.get('kodeAgents'), sessions, archived: new Set(registry?.archivedSessionIds ?? []), workspaces: registry?.list() ?? [], runs, templates: await botTemplates().catch(() => []) })
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
    const view = botsView(roster, { runtime, sessions: [], archived: new Set(), workspaces: registry?.list() ?? [] })
    const task = await builderPrompt({ agents: view.agents, avatars: await runtime.appearance?.gallery().catch(() => []) ?? [], workspaces: view.workspaces.filter(row => row.path !== workspace), template })
    const created = await creator.create({
      title: template ? `创建伙伴 · ${template.name}` : '创建伙伴', task, agent: agent.id, workspace,
      // Searching SkillHub needs the network; the skill forbids writes.
      permission: 'workspace-write',
      idempotency_key: String(input.idempotency_key ?? '').slice(0, 160) || `bot-builder-${Date.now()}`,
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
    const created = await launchBot(ctx, roster, bot, {
      task: input.message,
      workspace: input.workspace || roster.workspaces?.[bot.id] || bot.default_cwd,
      permission: MODES[bot.permission_ceiling] ?? 'read-only',
      key: String(input.idempotency_key ?? '').slice(0, 160) || `bot-${bot.id}-${Date.now()}`,
    })
    const sessionId = created.address.session_id
    await backend.call(BOTS, { action: 'set_main_session', id: bot.id, session: { runtime: 'dsh', session_id: sessionId } })
    return { sessionId }
  }
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/bots', handler: async (req, res, peer) => {
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
        return send(res, 200, await backend.call(Number.isSafeInteger(after) && after >= 0 && query.has('after') ? `${WATCHES}?after=${after}` : WATCHES))
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST required' })
      let body = ''
      for await (const chunk of req) { body += chunk; if (body.length > 64 * 1024) return send(res, 413, { error: 'Request too large' }) }
      const input = JSON.parse(body)
      if (ROSTER_ACTIONS.includes(input?.action)) {
        await backend.call(BOTS, input)
        // Every bot has its own folder from the start.
        if (input.action === 'upsert') await homes()
        return send(res, 200, await view())
      }
      if (input?.action === 'home') {
        const roster = await backend.call(BOTS), bot = roster.bots.find(row => row.id === input.id)
        if (!bot) throw new Error('这个伙伴已不存在')
        return send(res, 200, await ensureBotHome(ctx, roster, bot))
      }
      if (input?.action === 'start') return send(res, 200, await start(input))
      if (input?.action === 'builder') return send(res, 200, await builder(input))
      if (input?.action === 'skill_install') {
        const skipped = await installSkill(input)
        return send(res, 200, { ...await view(), ...(skipped.length ? { skipped } : {}) })
      }
      if (input?.action === 'skill_remove') { await dropSkill(input); return send(res, 200, await view()) }
      if (WATCH_ACTIONS.includes(input?.action)) return send(res, 200, await backend.call(WATCHES, { ...input, action: input.action.slice('watch_'.length) }))
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
}
