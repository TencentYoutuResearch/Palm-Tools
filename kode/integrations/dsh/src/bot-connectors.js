/**
 * Per-bot Connectors & Apps ("连接器") for DSH & Kode bots.
 *
 * Mirrors Orca Bot's 3-tier connector system (`stablyai/orca`):
 * 1. Direct channel connectors (WeCom, GitHub, Slack, Discord, Linear, Google, Kode Team)
 * 2. Official direct MCP apps catalog (Vercel, Sentry, Datadog, PostHog, Cloudflare,
 *    Supabase, Neon, Netlify, GitLab, Context7, Atlassian, Notion, Stripe, ClickUp,
 *    Airtable, Todoist, Zapier, Granola, Intercom) + custom MCP server by URL
 * 3. Custom local HTTP Webhooks (`POST /api/kode/bot-webhooks/<connector_id>`)
 *
 * Persists in the owner-only `bot-connectors` workbench document (compatible with
 * existing `kode-bridge` binaries without changing Rust `Bot` schema) and binds
 * Kode watches automatically for event-driven connectors.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile as execFileCb } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BackendDocument, isDocumentConflictError } from './backend-state.js'

const execFileAsync = promisify(execFileCb)
const WATCHES = '/api/v1/messaging/workbench/watches'
const EVENTS = '/api/v1/messaging/workbench/events'
const MAX_CONNECTORS_PER_BOT = 24
const MAX_WEBHOOK_BODY_BYTES = 32 * 1024

export const CONNECTOR_CATALOG = [
  {
    type: 'wecom',
    name: '企业微信',
    badge: '企微',
    category: 'chat',
    summary: '在企微单聊或群聊里直接呼叫伙伴，自动同步监听会话并回复',
    delivery: '本机 wecom-cli',
    needs_webhook: false,
  },
  {
    type: 'github',
    name: 'GitHub',
    badge: 'GH',
    category: 'coding',
    summary: '通过本机 gh 账号操作 PR/Issue，并监听仓库提交、分支变更或 Webhook',
    delivery: '本机 gh + Git/Webhook',
    needs_webhook: true,
  },
  {
    type: 'slack',
    name: 'Slack',
    badge: 'Slack',
    category: 'chat',
    summary: '在 Slack 频道和私信里呼叫伙伴，通过专属 Webhook 接收事件',
    delivery: 'Webhook + 本机 MCP',
    needs_webhook: true,
  },
  {
    type: 'discord',
    name: 'Discord',
    badge: 'Discord',
    category: 'chat',
    summary: '在 Discord 频道、子区与私信中触发伙伴并同步回复',
    delivery: 'Webhook + Bot',
    needs_webhook: true,
  },
  {
    type: 'linear',
    name: 'Linear',
    badge: 'Linear',
    category: 'docs',
    summary: '通过 @提及、指派或标签把 Linear Issue 交给伙伴自动跟进',
    delivery: 'Webhook + 本机 MCP',
    needs_webhook: true,
  },
  {
    type: 'google',
    name: 'Google',
    badge: 'Google',
    category: 'mail',
    summary: '让伙伴访问你的 Gmail、Calendar 与 Drive，支持定时巡检或 Webhook',
    delivery: '本机直连 / Webhook',
    needs_webhook: true,
  },
  {
    type: 'team',
    name: '团队频道',
    badge: 'Team',
    category: 'chat',
    summary: '在 Kode 团队频道中被 @ 提及或监听指定频道消息时自动响应',
    delivery: 'Kode 团队事件',
    needs_webhook: false,
  },
  {
    type: 'webhook',
    name: 'Webhook',
    badge: 'Hook',
    category: 'custom',
    summary: '生成专属本机回调地址与密钥，CI、脚本或外部服务调用即可触发',
    delivery: '本机 Host 回调',
    needs_webhook: true,
  },
  {
    type: 'mcp',
    name: 'MCP 应用',
    badge: 'MCP',
    category: 'custom',
    summary: '接入官方或自定义 MCP 服务器（Notion、Sentry、Vercel、Jira 等）',
    delivery: 'MCP 服务器',
    needs_webhook: false,
  },
]

/** Official direct MCP apps synced from Orca (`src/shared/bots/bot-mcp-apps.ts`). */
export const MCP_APP_CATALOG = [
  { id: 'vercel', name: 'Vercel', badge: 'VC', category: 'coding', summary: '查看部署状态并读取构建与运行日志', url: 'https://mcp.vercel.com' },
  { id: 'cloudflare', name: 'Cloudflare', badge: 'CF', category: 'coding', summary: '管理 Workers、DNS 与账户资源', url: 'https://mcp.cloudflare.com/mcp' },
  { id: 'supabase', name: 'Supabase', badge: 'SB', category: 'coding', summary: '查询数据库并管理 Supabase 项目', url: 'https://mcp.supabase.com/mcp' },
  { id: 'neon', name: 'Neon', badge: 'NE', category: 'coding', summary: '执行 SQL 并管理 Postgres 分支', url: 'https://mcp.neon.tech/mcp' },
  { id: 'netlify', name: 'Netlify', badge: 'NL', category: 'coding', summary: '部署站点并检查构建结果', url: 'https://mcp.netlify.com/mcp' },
  {
    id: 'gitlab',
    name: 'GitLab',
    badge: 'GL',
    category: 'coding',
    summary: '读取并更新 GitLab Issue 与 Merge Request',
    url: 'https://{host}/api/v4/mcp',
    variable: { key: 'host', label: 'GitLab 域名（留空默认 gitlab.com）', default: 'gitlab.com', placeholder: 'gitlab.example.com' },
  },
  { id: 'context7', name: 'Context7', badge: 'C7', category: 'coding', summary: '查询开源库的最新官方文档与示例', url: 'https://mcp.context7.com/mcp' },
  { id: 'sentry', name: 'Sentry', badge: 'ST', category: 'monitoring', summary: '排查线上报错及关联事件栈', url: 'https://mcp.sentry.dev/mcp' },
  {
    id: 'datadog',
    name: 'Datadog',
    badge: 'DD',
    category: 'monitoring',
    summary: '检索日志、指标与告警监控',
    url: 'https://mcp.{site}/v1/mcp',
    variable: {
      key: 'site',
      label: 'Datadog 区域',
      default: 'datadoghq.com',
      choices: [
        { name: 'US1', value: 'datadoghq.com' },
        { name: 'US3', value: 'us3.datadoghq.com' },
        { name: 'US5', value: 'us5.datadoghq.com' },
        { name: 'EU', value: 'datadoghq.eu' },
        { name: 'AP1', value: 'ap1.datadoghq.com' },
        { name: 'AP2', value: 'ap2.datadoghq.com' },
        { name: 'UK1', value: 'uk1.datadoghq.com' },
      ],
    },
  },
  { id: 'posthog', name: 'PostHog', badge: 'PH', category: 'monitoring', summary: '查询产品数据分析与 Feature Flags', url: 'https://mcp.posthog.com/mcp' },
  { id: 'atlassian', name: 'Atlassian', badge: 'AT', category: 'docs', summary: '读写 Jira Issue 与 Confluence 文档', url: 'https://mcp.atlassian.com/v2/mcp' },
  { id: 'notion', name: 'Notion', badge: 'NT', category: 'docs', summary: '搜索、阅读并编辑 Notion 页面', url: 'https://mcp.notion.com/mcp' },
  { id: 'clickup', name: 'ClickUp', badge: 'CU', category: 'docs', summary: '管理任务、清单与文档', url: 'https://mcp.clickup.com/mcp' },
  { id: 'airtable', name: 'Airtable', badge: 'AB', category: 'docs', summary: '查询并编辑多维表格记录', url: 'https://mcp.airtable.com/mcp' },
  { id: 'todoist', name: 'Todoist', badge: 'TD', category: 'docs', summary: '新增、整理并完成待办任务', url: 'https://ai.todoist.net/mcp' },
  { id: 'zapier', name: 'Zapier', badge: 'ZP', category: 'docs', summary: '调用你在 Zapier 中编排的自动化动作', url: 'https://mcp.zapier.com/api/v1/connect' },
  { id: 'granola', name: 'Granola', badge: 'GR', category: 'mail', summary: '检索会议纪要与转写记录', url: 'https://mcp.granola.ai/mcp' },
  { id: 'stripe', name: 'Stripe', badge: 'SP', category: 'sales', summary: '查询支付订单、客户与订阅状态', url: 'https://mcp.stripe.com' },
  {
    id: 'intercom',
    name: 'Intercom',
    badge: 'IC',
    category: 'sales',
    summary: '搜索客服对话、联系人与帮助中心文章',
    url: 'https://mcp.{site}/mcp',
    variable: {
      key: 'site',
      label: 'Intercom 区域',
      default: 'intercom.com',
      choices: [
        { name: 'US', value: 'intercom.com' },
        { name: 'EU', value: 'eu.intercom.com' },
      ],
    },
  },
]

const VALID_TYPES = new Set(CONNECTOR_CATALOG.map(row => row.type))
const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : ''
const newId = () => `conn_${randomBytes(8).toString('hex')}`
const newSecret = () => randomBytes(24).toString('hex')

function validHttpUrl(text) {
  try {
    const parsed = new URL(text)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : ''
  } catch {
    return ''
  }
}

export function resolveMcpAppUrl(appOrId, raw = {}) {
  const id = typeof appOrId === 'string' ? appOrId : appOrId?.id
  const app = MCP_APP_CATALOG.find(item => item.id === id)
  if (!app) return validHttpUrl(clean(raw.url, 512))
  if (!app.variable) return app.url
  const val = clean(raw[app.variable.key], 160).replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || app.variable.default
  return validHttpUrl(app.url.replace(`{${app.variable.key}}`, val)) || app.url.replace(`{${app.variable.key}}`, app.variable.default)
}

export function connectorUsesWebhookWatch(connector) {
  return buildWatchSpecForConnector(connector)?.on?.topic === 'webhook/event'
}

export function connectorHowToAsk(connector, botName = '伙伴') {
  const cfg = connector.config ?? {}
  switch (connector.type) {
    case 'wecom':
      return cfg.chat_id ? `在企业微信会话 ${cfg.chat_id} 中发送消息即可触发` : '在已监听的企业微信会话中发送消息即可触发'
    case 'webhook':
      return `POST ${webhookPathFor(connector.id)}（携带 Bearer 密钥）`
    case 'github':
      if (cfg.watch_commits && cfg.workspace) {
        return cfg.repo
          ? `监听工作区 ${cfg.workspace}${cfg.branch ? `（${cfg.branch} 分支）` : ''} 的本地提交，并用本机 gh 访问 ${cfg.repo}`
          : `监听工作区 ${cfg.workspace}${cfg.branch ? `（${cfg.branch} 分支）` : ''} 的本地提交，并用本机 gh 操作仓库`
      }
      return cfg.repo
        ? `使用本机 gh 访问 ${cfg.repo}，或通过专属 Webhook 接收 GitHub 事件`
        : '使用本机 gh 账号操作仓库，或通过专属 Webhook 触发'
    case 'team':
      return cfg.mode === 'all'
        ? `监听团队频道${cfg.room ? ` #${cfg.room}` : '（全部频道）'}的新消息`
        : `在团队频道${cfg.room ? ` #${cfg.room}` : ''}中 @${botName}`
    case 'slack':
      return `在 Slack ${cfg.channel ? `#${cfg.channel} ` : ''}提及 @${cfg.mention_handle || botName}（转发至专属 Webhook）`
    case 'discord':
      return `在 Discord ${cfg.channel ? `#${cfg.channel} ` : ''}频道/子区提及 @${cfg.mention_handle || botName}（转发至专属 Webhook）`
    case 'linear':
      return `在 Linear ${cfg.team ? `${cfg.team} ` : ''}添加标签 ${cfg.label || `bot:${botName}`} 或转发 Webhook`
    case 'google':
      return cfg.schedule_cron
        ? `按定时（${cfg.schedule_cron}）自动检查 ${(cfg.services ?? ['gmail', 'calendar']).join(' / ')}`
        : `通过本机 MCP 或专属 Webhook 触发 ${(cfg.services ?? ['gmail', 'calendar']).join(' / ')}`
    case 'mcp':
      return cfg.url ? `直接通过 MCP 地址 ${cfg.url} 调用 ${connector.name} 工具` : `通过已配置的 MCP 服务器调用 ${connector.name}`
    default:
      return ''
  }
}

export function connectorsPrompt(connectors = [], botName = '伙伴') {
  const active = connectors.filter(row => row && row.enabled !== false)
  if (!active.length) return ''
  const lines = ['你当前已启用的连接器与外部应用（需要时主动使用或按以下入口协同）：']
  for (const conn of active) {
    const how = conn.how_to_ask || connectorHowToAsk(conn, botName)
    const note = conn.type === 'mcp' && conn.config?.notes ? `；备注：${conn.config.notes}` : ''
    lines.push(`- ${conn.name}（${conn.type}）：${how}${note}`)
  }
  return lines.join('\n')
}

function cleanGithubRepo(value) {
  const raw = clean(value, 240)
  const match = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?$/i.exec(raw)
  return match ? match[1] : clean(raw, 160)
}

function sameConnectorTarget(existing, type, config) {
  if (existing.type !== type) return false
  const prev = existing.config ?? {}
  switch (type) {
    case 'wecom':
      return (prev.chat_id ?? '') === (config.chat_id ?? '')
    case 'github':
      return cleanGithubRepo(prev.repo) === config.repo
        && (prev.workspace ?? '') === (config.workspace ?? '')
        && (prev.branch ?? '') === (config.branch ?? '')
        && Boolean(prev.watch_commits) === Boolean(config.watch_commits)
    case 'team':
      return (prev.room ?? '') === (config.room ?? '') && (prev.mode ?? 'mention') === (config.mode ?? 'mention')
    case 'mcp':
      return config.app_id && config.app_id !== 'custom'
        ? prev.app_id === config.app_id
        : (prev.url ?? '') === (config.url ?? '')
    case 'slack':
      return (prev.workspace ?? '') === (config.workspace ?? '') && (prev.channel ?? '') === (config.channel ?? '')
    case 'discord':
      return (prev.server ?? '') === (config.server ?? '') && (prev.channel ?? '') === (config.channel ?? '')
    case 'linear':
      return (prev.team ?? '') === (config.team ?? '') && (prev.label ?? '') === (config.label ?? '')
    case 'google':
      return (prev.account ?? '') === (config.account ?? '') && (prev.schedule_cron ?? '') === (config.schedule_cron ?? '')
    default:
      return false
  }
}

export function webhookPathFor(connectorId) {
  return `/api/kode/bot-webhooks/${encodeURIComponent(connectorId)}`
}

export function normalizeConnectorConfig(type, raw = {}, bot = null) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  if (type === 'wecom') {
    return {
      chat_id: clean(cfg.chat_id, 128),
      chat_name: clean(cfg.chat_name, 120),
      instructions: clean(cfg.instructions, 4000) || '阅读企业微信收到的消息，必要时调用 wecom_messages_list 补充上下文，并用 wecom_message_send 回复对方；完成后把处理结论汇报到主对话。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'default',
    }
  }
  if (type === 'webhook') {
    return {
      events_hint: clean(cfg.events_hint, 200),
      instructions: clean(cfg.instructions, 4000) || '收到外部 Webhook 事件，请分析载荷内容并按你的职责处理，把结论汇报到主对话。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan',
    }
  }
  if (type === 'github') {
    const workspace = 'workspace' in cfg ? clean(cfg.workspace, 512) : (bot?.default_cwd ?? '')
    return {
      repo: cleanGithubRepo(cfg.repo),
      workspace: workspace.startsWith('/') ? workspace : '',
      branch: clean(cfg.branch, 120),
      watch_commits: cfg.watch_commits !== false,
      instructions: clean(cfg.instructions, 4000) || '检查这次仓库变更或 GitHub 事件（必要时用本机 gh 查看 PR/Issue/CI 状态），指出风险和待办并汇报到主对话。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan',
    }
  }
  if (type === 'team') {
    return {
      room: clean(cfg.room, 120),
      mode: cfg.mode === 'all' ? 'all' : 'mention',
      instructions: clean(cfg.instructions, 4000) || '查看团队频道里的最新消息或 @ 你的请求，按你的职责及时回应并同步结论。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan',
    }
  }
  if (type === 'slack') {
    return {
      workspace: clean(cfg.workspace, 120),
      channel: clean(cfg.channel, 120).replace(/^#/, ''),
      mention_handle: clean(cfg.mention_handle, 80),
      instructions: clean(cfg.instructions, 4000) || '收到来自 Slack 的请求，请分析上下文、完成处理，并将回复内容同步给用户或通过已配置的 Slack MCP 回复。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan',
    }
  }
  if (type === 'discord') {
    return {
      server: clean(cfg.server, 120),
      channel: clean(cfg.channel, 120).replace(/^#/, ''),
      mention_handle: clean(cfg.mention_handle, 80),
      instructions: clean(cfg.instructions, 4000) || '收到来自 Discord 的请求，请分析上下文并给出答复，把关键进展同步到主对话。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan',
    }
  }
  if (type === 'linear') {
    return {
      team: clean(cfg.team, 120),
      label: clean(cfg.label, 80),
      instructions: clean(cfg.instructions, 4000) || '收到 Linear Issue 更新或标签触发，请评估需求/问题、更新看板，并在主对话向用户汇报进展。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan',
    }
  }
  if (type === 'google') {
    const services = Array.isArray(cfg.services)
      ? cfg.services.filter(item => ['gmail', 'calendar', 'drive'].includes(item))
      : ['gmail', 'calendar']
    const cron = clean(cfg.schedule_cron, 64)
    if (cron && !/^\S+( \S+){4}$/.test(cron)) {
      throw new Error('定时 Cron 格式应为 5 段（分 时 日 月 周），例如 0 9 * * 1-5')
    }
    return {
      account: clean(cfg.account, 160),
      services: services.length ? services : ['gmail', 'calendar'],
      schedule_cron: cron,
      instructions: clean(cfg.instructions, 4000) || '检查近期重要邮件、即将开始的日程或共享文档变动，提炼需要用户关注的事项并汇报。',
      permission: ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan',
    }
  }
  if (type === 'mcp') {
    const appId = clean(cfg.app_id, 64) || 'custom'
    const app = MCP_APP_CATALOG.find(item => item.id === appId)
    const url = resolveMcpAppUrl(appId, cfg)
    if (!url) throw new Error('请输入有效的 http(s) MCP 服务器地址')
    return {
      app_id: app ? app.id : 'custom',
      category: app?.category ?? (clean(cfg.category, 32) || 'custom'),
      url,
      ...(cfg.site ? { site: clean(cfg.site, 120) } : {}),
      ...(cfg.host ? { host: clean(cfg.host, 160) } : {}),
      notes: clean(cfg.notes, 400),
    }
  }
  return {}
}

export function buildWatchSpecForConnector(connector) {
  if (connector.type === 'mcp') return null
  const cfg = connector.config ?? {}
  const name = `连接器 · ${connector.name}`.slice(0, 80)
  const permission = ['plan', 'default', 'acceptEdits'].includes(cfg.permission) ? cfg.permission : 'plan'
  const basePolicy = {
    coalesce_secs: 10,
    max_runs_per_hour: 12,
    permission,
    workspace: null,
    carry_last_summary: true,
    notify: 'attention',
    report_to_main: true,
  }
  if (connector.type === 'wecom') {
    return {
      name,
      on: { topic: 'wecom/message', match: cfg.chat_id ? { chat_id: cfg.chat_id } : {} },
      do: cfg.instructions,
      policy: { ...basePolicy, ...(cfg.chat_id ? { post_to_wecom: cfg.chat_id } : {}) },
    }
  }
  if (connector.type === 'team') {
    return {
      name,
      on: { topic: cfg.mode === 'all' ? 'kode.team/message' : 'kode.team/mention', match: cfg.room ? { room: cfg.room } : {} },
      do: cfg.instructions,
      policy: basePolicy,
    }
  }
  if (connector.type === 'github' && cfg.watch_commits && cfg.workspace) {
    return {
      name,
      on: { topic: 'git.commit', match: { workspace: cfg.workspace, ...(cfg.branch ? { branch: cfg.branch } : {}) } },
      do: cfg.instructions,
      policy: basePolicy,
    }
  }
  if (connector.type === 'google' && cfg.schedule_cron) {
    return {
      name,
      on: { topic: 'schedule', match: { cron: cfg.schedule_cron } },
      do: cfg.instructions,
      policy: { ...basePolicy, coalesce_secs: 0, max_runs_per_hour: 2 },
    }
  }
  // Webhook-backed connectors: webhook, slack, discord, linear, github (without local git watch), google (without schedule)
  return {
    name,
    on: { topic: 'webhook/event', match: { connector_id: connector.id } },
    do: cfg.instructions,
    policy: { ...basePolicy, coalesce_secs: 5 },
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class BotConnectors {
  constructor(backend, { wecom = null, execFile = execFileAsync, storageFile } = {}) {
    this.backend = backend
    this.wecom = wecom
    this.execFile = execFile
    const fallbackFile = storageFile === undefined ? join(homedir(), '.config', 'kode', 'dsh-bot-connectors.json') : storageFile
    this.doc = new BackendDocument(backend, 'bot-connectors', { fallbackFile, migrateFallback: storageFile !== undefined })
    this.chain = Promise.resolve()
    this.ghCache = { checkedAt: 0, value: null }
  }

  serial(task) {
    const run = this.chain.then(task)
    this.chain = run.catch(() => {})
    return run
  }

  async readAll() {
    const raw = await this.doc.read().catch(() => null)
    const list = Array.isArray(raw?.connectors) ? raw.connectors : []
    return list
  }

  async writeAll(connectors) {
    try {
      await this.doc.write({ version: 1, connectors })
    } catch (error) {
      if (isDocumentConflictError(error)) {
        await this.doc.read().catch(() => null)
        await this.doc.write({ version: 1, connectors })
      } else {
        throw error
      }
    }
    return connectors
  }

  async ghStatus() {
    if (this.ghCache.value && Date.now() - this.ghCache.checkedAt < 60_000) return this.ghCache.value
    try {
      const { stdout, stderr } = await this.execFile('gh', ['auth', 'status'], { timeout: 4000 })
      const text = `${stdout ?? ''}\n${stderr ?? ''}`
      const match = /Logged in to [^\s]+ account ([^\s(]+)/i.exec(text) || /account ([^\s(]+)/i.exec(text)
      const value = { installed: true, authenticated: true, account: match?.[1] ?? null }
      this.ghCache = { checkedAt: Date.now(), value }
      return value
    } catch (error) {
      const missing = error?.code === 'ENOENT'
      const value = { installed: !missing, authenticated: false, account: null }
      this.ghCache = { checkedAt: Date.now(), value }
      return value
    }
  }

  async environment() {
    const [wecomStatus, gh] = await Promise.all([
      this.wecom?.status?.().catch(() => null) ?? Promise.resolve(null),
      this.ghStatus(),
    ])
    return {
      wecom: wecomStatus ? {
        installed: Boolean(wecomStatus.installed),
        authorized: Boolean(wecomStatus.authorized),
        bot_id: wecomStatus.bot_id ?? null,
        enabled: Boolean(this.wecom?.config?.enabled),
      } : { installed: false, authorized: false, bot_id: null, enabled: false },
      github: gh,
    }
  }

  publicView(connector, botName) {
    const hasWebhook = Boolean(connectorUsesWebhookWatch(connector) && connector.secret)
    return {
      id: connector.id,
      bot_id: connector.bot_id,
      type: connector.type,
      name: connector.name,
      enabled: connector.enabled !== false,
      config: connector.config ?? {},
      watch_id: connector.watch_id ?? null,
      ...(hasWebhook ? { webhook_path: webhookPathFor(connector.id), secret: connector.secret } : {}),
      how_to_ask: connectorHowToAsk(connector, botName),
      last_event_at: connector.last_event_at ?? null,
      event_count: connector.event_count ?? 0,
      created_at: connector.created_at ?? 0,
      updated_at: connector.updated_at ?? 0,
    }
  }

  async upsert(bot, input) {
    return this.serial(async () => {
      const type = clean(input?.type, 32)
      if (!VALID_TYPES.has(type)) throw new Error('不支持的连接器类型')
      const catalog = CONNECTOR_CATALOG.find(item => item.type === type)
      const all = await this.readAll()
      const explicitExisting = input.id ? all.find(row => row.id === input.id && row.bot_id === bot.id) : null
      if (input.id && !explicitExisting) throw new Error('找不到这个连接器')
      const config = normalizeConnectorConfig(type, input.config ?? explicitExisting?.config ?? {}, bot)
      const existing = explicitExisting ?? all.find(row => row.bot_id === bot.id && sameConnectorTarget(row, type, config)) ?? null
      if (!existing && all.filter(row => row.bot_id === bot.id).length >= MAX_CONNECTORS_PER_BOT) {
        throw new Error(`一个伙伴最多配置 ${MAX_CONNECTORS_PER_BOT} 个连接器`)
      }
      const now = Date.now()
      const mcpApp = type === 'mcp' ? MCP_APP_CATALOG.find(item => item.id === config.app_id) : null
      const record = {
        id: existing?.id ?? newId(),
        bot_id: bot.id,
        type,
        name: clean(input.name, 64) || existing?.name || mcpApp?.name || catalog.name,
        enabled: input.enabled !== undefined ? Boolean(input.enabled) : (existing?.enabled ?? true),
        config,
        secret: catalog.needs_webhook ? (existing?.secret ?? newSecret()) : undefined,
        watch_id: existing?.watch_id ?? null,
        last_event_at: existing?.last_event_at ?? null,
        event_count: existing?.event_count ?? 0,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      }
      // Sync WeCom global watched_chats and ensure polling is enabled when an active WeCom connector is added.
      const saveWecom = this.wecom?.saveConfig
        ? patch => this.wecom.saveConfig(patch)
        : this.wecom?.configure
          ? patch => this.wecom.configure(patch)
          : null
      if (type === 'wecom' && saveWecom) {
        const patch = {}
        const watched = this.wecom.config?.watched_chats ?? []
        if (config.chat_id && !watched.some(row => row.chat_id === config.chat_id)) {
          patch.watched_chats = [...watched, { chat_id: config.chat_id, name: config.chat_name || config.chat_id }]
        }
        if (record.enabled && !this.wecom.config?.enabled) {
          patch.enabled = true
        }
        if (Object.keys(patch).length > 0) {
          await saveWecom(patch).catch(() => {})
        }
      }
      // Bind or update the backing Kode watch (MCP apps are tool endpoints and need no watch).
      const spec = buildWatchSpecForConnector(record)
      let createdWatchId = null
      if (spec) {
        const upsertWatch = async watchId => this.backend.call(WATCHES, {
          action: 'upsert',
          ...(watchId ? { id: watchId } : {}),
          bot: bot.id,
          enabled: record.enabled,
          spec,
        })
        try {
          let result
          try {
            result = await upsertWatch(record.watch_id)
          } catch (error) {
            if (record.watch_id && error?.status === 404) {
              // The backing watch may have been manually deleted; recreate it cleanly.
              record.watch_id = null
              result = await upsertWatch(null)
            } else {
              throw error
            }
          }
          if (result?.saved) {
            if (!record.watch_id) createdWatchId = result.saved
            record.watch_id = result.saved
          } else if (!record.watch_id && Array.isArray(result?.watches)) {
            const matched = result.watches.find(row => row.bot === bot.id && row.spec?.name === spec.name)
            if (matched) {
              createdWatchId = matched.id
              record.watch_id = matched.id
            }
          }
        } catch (error) {
          if (error?.status !== 404) throw error
        }
      }
      const next = existing ? all.map(row => row.id === record.id ? record : row) : [...all, record]
      try {
        await this.writeAll(next)
      } catch (error) {
        if (createdWatchId) {
          await this.backend.call(WATCHES, { action: 'delete', id: createdWatchId }).catch(() => {})
        }
        throw error
      }
      return this.publicView(record, bot.name)
    })
  }

  async toggle(id, enabled) {
    return this.serial(async () => {
      const all = await this.readAll()
      const target = all.find(row => row.id === id)
      if (!target) throw new Error('找不到这个连接器')
      target.enabled = Boolean(enabled)
      target.updated_at = Date.now()
      if (target.watch_id) {
        await this.backend.call(WATCHES, { action: 'toggle', id: target.watch_id, enabled: target.enabled }).catch(error => {
          if (error?.status !== 404 && !/unknown|not found|不存在/i.test(error?.message ?? '')) throw error
        })
      }
      await this.writeAll(all)
      return target
    })
  }

  async remove(id) {
    return this.serial(async () => {
      const all = await this.readAll()
      const target = all.find(row => row.id === id)
      if (!target) throw new Error('找不到这个连接器')
      if (target.watch_id) {
        await this.backend.call(WATCHES, { action: 'delete', id: target.watch_id }).catch(() => {})
      }
      await this.writeAll(all.filter(row => row.id !== id))
      return { deleted: id }
    })
  }

  async removeForBot(botId) {
    return this.serial(async () => {
      const all = await this.readAll()
      const removed = all.filter(row => row.bot_id === botId)
      const keep = all.filter(row => row.bot_id !== botId)
      for (const row of removed) {
        if (row.watch_id) {
          await this.backend.call(WATCHES, { action: 'delete', id: row.watch_id }).catch(() => {})
        }
      }
      if (keep.length !== all.length) await this.writeAll(keep)
    })
  }

  async syncByWatchToggle(watchId, enabled) {
    if (!watchId) return false
    return this.serial(async () => {
      const all = await this.readAll()
      const target = all.find(row => row.watch_id === watchId)
      if (!target) return false
      target.enabled = Boolean(enabled)
      target.updated_at = Date.now()
      await this.writeAll(all)
      return true
    })
  }

  async removeByWatchId(watchId) {
    if (!watchId) return false
    return this.serial(async () => {
      const all = await this.readAll()
      const keep = all.filter(row => row.watch_id !== watchId)
      if (keep.length === all.length) return false
      await this.writeAll(keep)
      return true
    })
  }

  /** Clean up orphaned `连接器 · ...` watches left behind by earlier failed writes. */
  async pruneOrphanWatches(watches) {
    if (!Array.isArray(watches) || !watches.length) return []
    if (!watches.some(w => w?.id && typeof w.spec?.name === 'string' && w.spec.name.startsWith('连接器 · '))) return []
    return this.serial(async () => {
      let raw
      try { raw = await this.doc.read() } catch { return [] }
      const list = Array.isArray(raw?.connectors) ? raw.connectors : []
      const activeWatchIds = new Set(list.map(row => row.watch_id).filter(Boolean))
      const orphans = watches.filter(w =>
        w?.id
        && !activeWatchIds.has(w.id)
        && typeof w.spec?.name === 'string'
        && w.spec.name.startsWith('连接器 · '))
      if (!orphans.length) return []
      const removed = []
      for (const orphan of orphans) {
        await this.backend.call(WATCHES, { action: 'delete', id: orphan.id }).then(() => { removed.push(orphan.id) }).catch(() => {})
      }
      return removed
    })
  }

  async rotateSecret(id) {
    return this.serial(async () => {
      const all = await this.readAll()
      const target = all.find(row => row.id === id)
      if (!target) throw new Error('找不到这个连接器')
      if (!connectorUsesWebhookWatch(target)) throw new Error('该连接器当前不使用 Webhook 密钥')
      target.secret = newSecret()
      target.updated_at = Date.now()
      await this.writeAll(all)
      return target
    })
  }

  async recordEvent(connectorId) {
    await this.serial(async () => {
      const all = await this.readAll()
      const row = all.find(item => item.id === connectorId)
      if (!row) return
      row.last_event_at = Date.now()
      row.event_count = (row.event_count ?? 0) + 1
      await this.writeAll(all)
    }).catch(() => {})
  }

  async test(id) {
    const all = await this.readAll()
    const target = all.find(row => row.id === id)
    if (!target) throw new Error('找不到这个连接器')
    if (target.enabled === false) throw new Error('连接器当前已暂停，请先启用后再测试')
    if (connectorUsesWebhookWatch(target)) {
      await this.publishWebhookEvent(target, { test: true, message: `来自「${target.name}」的测试触发事件`, source: target.type })
      return { ok: true, mode: 'webhook_event' }
    }
    if (target.watch_id) {
      await this.backend.call(WATCHES, { action: 'run', id: target.watch_id })
      await this.recordEvent(target.id)
      return { ok: true, mode: 'watch_run' }
    }
    if (target.type === 'mcp' && target.config?.url) {
      return { ok: true, mode: 'mcp_configured', url: target.config.url }
    }
    throw new Error('该连接器尚未绑定触发规则')
  }

  async publishWebhookEvent(connector, data) {
    const payload = {
      connector_id: connector.id,
      bot_id: connector.bot_id,
      connector_name: connector.name,
      source: connector.type,
      received_at: new Date().toISOString(),
      data: data && typeof data === 'object' ? data : { text: String(data ?? '') },
    }
    await this.backend.call(EVENTS, { topic: 'webhook/event', payload })
    await this.recordEvent(connector.id)
    return payload
  }

  async handleWebhook(req, res) {
    const send = (status, value) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(value))
    }
    if (req.method !== 'POST') return send(405, { error: 'POST required' })
    const url = new URL(req.url ?? '/', 'http://host')
    const id = decodeURIComponent(url.pathname.replace(/^\/api\/kode\/bot-webhooks\/?/, '').split('/')[0] ?? '')
    if (!id) return send(404, { error: 'Connector not found' })
    const all = await this.readAll()
    const connector = all.find(row => row.id === id)
    if (!connector || !connector.secret || !connectorUsesWebhookWatch(connector)) return send(404, { error: 'Connector not found' })
    const auth = String(req.headers?.authorization ?? '')
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const headerSecret = String(req.headers?.['x-kode-webhook-secret'] ?? '').trim()
    const provided = bearer || headerSecret
    if (!safeEqual(provided, connector.secret)) return send(401, { error: 'Invalid webhook secret' })
    if (connector.enabled === false) return send(409, { error: 'Connector is paused' })
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (Buffer.byteLength(body) > MAX_WEBHOOK_BODY_BYTES) return send(413, { error: 'Webhook payload too large' })
    }
    let data = {}
    if (body.trim()) {
      try { data = JSON.parse(body) } catch { data = { raw: body.trim() } }
    }
    try {
      await this.publishWebhookEvent(connector, data)
      return send(202, { accepted: true, connector_id: connector.id })
    } catch (error) {
      return send(502, { error: error.message })
    }
  }
}
