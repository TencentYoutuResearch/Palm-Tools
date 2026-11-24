/**
 * Bots ("伙伴") in the dsh view. The roster lives in the Kode backend and is
 * shared with Kode GUI, extensions and phones; dsh runs a bot's conversation
 * as an ordinary dsh session started with the bot's Agent, persona and
 * permission limit, and records it as the bot's main session.
 */
import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const BOTS = '/api/v1/messaging/workbench/bots'
const WATCHES = '/api/v1/messaging/workbench/watches'
const ROSTER_ACTIONS = ['upsert', 'delete', 'set_default', 'set_root']
// 关注 (bot watches): `watch_<action>` is Kode's watch action.
const WATCH_ACTIONS = ['watch_upsert', 'watch_toggle', 'watch_delete', 'watch_run', 'watch_seen']
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

export function botsView(roster, { runtime, sessions, archived, workspaces }) {
  const live = new Set(sessions.map(row => row.sessionId))
  return {
    default_bot: roster.default_bot ?? null,
    bots: roster.bots.map(bot => {
      const main = bot.main_session?.runtime === 'dsh' ? bot.main_session.session_id : null
      const agent = agentFor(runtime, bot.backend_key)
      return { ...bot, workspace: roster.workspaces?.[bot.id] ?? bot.default_cwd ?? null, agent: agent?.name ?? null, agent_type: agent?.type ?? null, main_session_id: main && live.has(main) && !archived.has(main) ? main : null }
    }),
    root: roster.root ?? null,
    default_root: roster.default_root ?? null,
    agents: offered(runtime).map(profile => ({ name: profile.name, type: profile.type, backend_key: runtime.profiles.sharedState?.desktop_ids?.[profile.id] ?? profile.type })),
    workspaces: workspaces.map(row => ({ id: row.id, title: row.title, path: row.path })),
  }
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

export function registerBotsApi(ctx, backend) {
  const send = (res, status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(value)) }
  const view = async roster => {
    const registry = ctx.get('workspaceRegistry')
    const sessions = (await ctx.get('sessionController')?.list({}))?.items ?? []
    return botsView(roster ?? await backend.call(BOTS), { runtime: ctx.get('kodeAgents'), sessions, archived: new Set(registry?.archivedSessionIds ?? []), workspaces: registry?.list() ?? [] })
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
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/bots', handler: async (req, res) => {
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(res, 403, { error: 'Host owner required' })
    try {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://host').searchParams
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
        return send(res, 200, await view())
      }
      if (input?.action === 'start') return send(res, 200, await start(input))
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
