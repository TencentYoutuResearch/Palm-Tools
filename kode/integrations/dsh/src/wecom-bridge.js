/**
 * WeCom (`wecom-cli`) bridge for dsh & Kode bots.
 *
 * - Polls configured/recent WeCom bot chats and publishes `wecom/message`
 *   events into Kode's watch dispatcher so any bot can watch and respond.
 * - Exposes owner-only `/api/kode/wecom` for configuration, session discovery,
 *   and testing.
 * - Exposes `wecom_*` Agent tools so bots and dsh sessions can list chats,
 *   read messages, and reply via `wecom-cli`.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants } from 'node:fs'
import { admitHostRequest } from './host-admission.js'
import { BackendDocument } from './backend-state.js'

const execFileAsync = promisify(execFile)
const MAX_BODY_BYTES = 32 * 1024
const MAX_SEEN = 2000
const DEFAULT_POLL_SECS = 30
const VALID_CHAT_ID = /^[^\x00-\x1f\s]{1,160}$/

export const DEFAULT_WECOM_CONFIG = {
  enabled: false,
  poll_interval_secs: DEFAULT_POLL_SECS,
  auto_discover_sessions: true,
  watched_chats: [],
}

export function formatWeComTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function resolveWeComBinary(configured) {
  if (configured && typeof configured === 'string') return configured
  if (process.env.WECOM_CLI_BIN) return process.env.WECOM_CLI_BIN
  for (const candidate of ['/opt/homebrew/bin/wecom-cli', '/usr/local/bin/wecom-cli']) {
    try { accessSync(candidate, fsConstants.X_OK); return candidate } catch { /* continue */ }
  }
  return 'wecom-cli'
}

export function parseWeComOutput(stdout = '') {
  const trimmed = String(stdout).trim()
  if (!trimmed) return {}
  try { return JSON.parse(trimmed) } catch { /* try NDJSON */ }
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const parsed = []
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)) } catch { /* ignore non-json line */ }
  }
  if (parsed.length === 1) return parsed[0]
  if (parsed.length > 1) return { pages: parsed }
  return { raw: trimmed }
}

function extractApiError(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const errcode = Number(parsed.errcode)
  if (!Number.isFinite(errcode) || errcode === 0) return null
  return {
    errcode,
    errmsg: String(parsed.errmsg ?? 'wecom-cli error'),
    help_message: typeof parsed.help_message === 'string' ? parsed.help_message.replace(/\\n/g, '\n') : null,
  }
}

function unwrapItems(parsed, keys) {
  if (!parsed || typeof parsed !== 'object') return []
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.pages)) return parsed.pages.flatMap(page => unwrapItems(page, keys))
  if (typeof parsed.results_json === 'string') {
    try { return unwrapItems(JSON.parse(parsed.results_json), keys) } catch { /* ignore */ }
  }
  if (parsed.results_json && typeof parsed.results_json === 'object') {
    const nested = unwrapItems(parsed.results_json, keys)
    if (nested.length) return nested
  }
  for (const key of keys) {
    if (Array.isArray(parsed[key])) return parsed[key]
    if (parsed.data && Array.isArray(parsed.data[key])) return parsed.data[key]
    if (parsed.result && Array.isArray(parsed.result[key])) return parsed.result[key]
  }
  if (Array.isArray(parsed.data)) return parsed.data
  if (Array.isArray(parsed.items)) return parsed.items
  return []
}

export function normalizeWeComSessions(parsed) {
  const rows = unwrapItems(parsed, ['sessions', 'session_list', 'groups', 'group_list', 'chat_list', 'list'])
  return rows.map(row => {
    const chatId = String(row.chat_id ?? row.chatid ?? row.id ?? row.userid ?? '').trim()
    if (!chatId) return null
    return {
      chat_id: chatId,
      name: String(row.name ?? row.chat_name ?? row.title ?? row.remark ?? chatId).trim() || chatId,
      chat_type: String(row.chat_type ?? row.type ?? 'unknown'),
      last_msg_time: row.last_msg_time ?? row.update_time ?? row.updated_at ?? null,
    }
  }).filter(Boolean)
}

export function normalizeWeComMessages(parsed, chatId = '') {
  const rows = unwrapItems(parsed, ['messages', 'msg_list', 'msglist', 'list'])
  return rows.map(row => {
    const sender = String(row.sender ?? row.from ?? row.from_userid ?? row.userid ?? row.sender_id ?? '').trim()
    const senderName = String(row.sender_name ?? row.from_name ?? row.username ?? sender ?? '成员').trim()
    const msgType = String(row.msg_type ?? row.msgtype ?? row.type ?? 'text')
    let content = ''
    if (typeof row.content === 'string') content = row.content
    else if (typeof row.text?.content === 'string') content = row.text.content
    else if (typeof row.markdown?.content === 'string') content = row.markdown.content
    else if (typeof row.msg_content === 'string') content = row.msg_content
    else if (typeof row.body === 'string') content = row.body
    else if (row.text && typeof row.text === 'string') content = row.text
    const sentAt = row.send_time ?? row.msg_time ?? row.msgtime ?? row.create_time ?? row.timestamp ?? ''
    const rawId = row.msg_id ?? row.msgid ?? row.id
    const msgId = rawId ? String(rawId) : createHash('sha256').update(`${chatId}|${sender}|${sentAt}|${content}`).digest('hex').slice(0, 24)
    return {
      msg_id: msgId,
      chat_id: String(row.chat_id ?? row.chatid ?? chatId),
      sender,
      sender_name: senderName,
      msg_type: msgType,
      content: content.trim(),
      sent_at: sentAt,
    }
  }).filter(row => row.content || row.msg_type !== 'text')
}

export function sanitizeWeComConfig(input, current = DEFAULT_WECOM_CONFIG) {
  const next = { ...DEFAULT_WECOM_CONFIG, ...current }
  if (typeof input?.enabled === 'boolean') next.enabled = input.enabled
  if (typeof input?.auto_discover_sessions === 'boolean') next.auto_discover_sessions = input.auto_discover_sessions
  if (input?.poll_interval_secs !== undefined) {
    const secs = Math.round(Number(input.poll_interval_secs))
    if (!Number.isFinite(secs) || secs < 10 || secs > 300) throw new Error('轮询间隔需在 10 到 300 秒之间')
    next.poll_interval_secs = secs
  }
  if (Array.isArray(input?.watched_chats)) {
    const seen = new Set(), chats = []
    for (const row of input.watched_chats.slice(0, 50)) {
      const chatId = String(row?.chat_id ?? '').trim()
      if (!chatId || !VALID_CHAT_ID.test(chatId) || seen.has(chatId)) continue
      seen.add(chatId)
      chats.push({ chat_id: chatId, name: String(row?.name ?? chatId).trim().slice(0, 80) || chatId })
    }
    next.watched_chats = chats
  }
  return next
}

export class WeComBridge {
  constructor(backend, { runner, binary, logger } = {}) {
    this.backend = backend
    this.binary = resolveWeComBinary(binary)
    this.runner = runner ?? ((args, signal) => execFileAsync(this.binary, args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, signal }))
    this.logger = logger ?? console
    this.document = backend ? new BackendDocument(backend, 'wecom-bridge') : null
    this.config = { ...DEFAULT_WECOM_CONFIG }
    this.seen = new Set()
    this.seeded = false
    this.botId = null
    this.authNotice = null
    this.lastPoll = null
    this.recentEvents = []
    this.timer = null
    this.polling = false
    this.stopped = false
  }

  async run(args, signal) {
    try {
      const { stdout, stderr } = await this.runner(args, signal)
      return { ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { ok: false, notInstalled: true, error: '未检测到 wecom-cli，请先安装并执行 wecom-cli auth init。' }
      }
      const stdout = String(error.stdout ?? '')
      if (stdout.trim().startsWith('{')) return { ok: true, stdout, stderr: String(error.stderr ?? '') }
      return { ok: false, error: (error.stderr || error.message || 'wecom-cli 执行失败').trim() }
    }
  }

  async loadConfig() {
    if (!this.document) return this.config
    try {
      const stored = await this.document.read()
      if (stored && typeof stored === 'object') this.config = sanitizeWeComConfig(stored, DEFAULT_WECOM_CONFIG)
    } catch { /* keep default */ }
    return this.config
  }

  async saveConfig(patch) {
    const next = sanitizeWeComConfig(patch, this.config)
    if (this.document) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await this.document.read() ?? {}
        const merged = { ...current, ...next, version: 1 }
        try { await this.document.write(merged); break } catch (error) {
          if (attempt === 3 || !/configuration changed/.test(error.message)) throw error
        }
      }
    }
    const wasEnabled = this.config.enabled
    this.config = next
    if (!wasEnabled && next.enabled) this.seeded = false
    this.reschedule()
    return this.config
  }

  async status(signal) {
    const res = await this.run(['auth', 'show'], signal)
    if (res.notInstalled) return { installed: false, authorized: false, bot_id: null, binary: this.binary, error: res.error }
    if (!res.ok) return { installed: true, authorized: false, bot_id: null, binary: this.binary, error: res.error }
    const text = res.stdout
    const authorized = /status\s*:\s*authorized/i.test(text)
    const botMatch = /bot\s*id\s*:\s*([^\s]+)/i.exec(text)
    this.botId = botMatch?.[1] ?? this.botId
    return { installed: true, authorized, bot_id: this.botId, binary: this.binary, error: authorized ? '' : text.trim() }
  }

  async listSessions({ includeGroups = false, hours = 24 } = {}, signal) {
    const res = await this.run(['message', 'aibot', 'sessions', 'list'], signal)
    if (!res.ok) throw new Error(res.error)
    const parsed = parseWeComOutput(res.stdout)
    const apiError = extractApiError(parsed)
    if (apiError) {
      if (apiError.help_message) this.authNotice = apiError.help_message
      return { sessions: [], error: apiError.errmsg, errcode: apiError.errcode, help_message: apiError.help_message }
    }
    this.authNotice = null
    const sessions = normalizeWeComSessions(parsed)
    if (includeGroups) {
      const end = new Date()
      const begin = new Date(end.getTime() - Math.max(1, Math.min(168, Number(hours) || 24)) * 3600_000)
      const gRes = await this.run(['chat', 'groups', 'list', '--begin-time', formatWeComTime(begin), '--end-time', formatWeComTime(end)], signal)
      if (gRes.ok) {
        const gParsed = parseWeComOutput(gRes.stdout)
        if (!extractApiError(gParsed)) {
          const seenIds = new Set(sessions.map(s => s.chat_id))
          for (const g of normalizeWeComSessions(gParsed)) {
            if (!seenIds.has(g.chat_id)) { seenIds.add(g.chat_id); sessions.push({ ...g, chat_type: 'group' }) }
          }
        }
      }
    }
    return { sessions, help_message: null }
  }

  async listMessages({ chat_id, hours = 24, begin_time, end_time, cursor } = {}, signal) {
    const id = String(chat_id ?? '').trim()
    if (!id || !VALID_CHAT_ID.test(id)) throw new Error('请提供有效的 chat_id')
    const now = new Date()
    const windowHours = Math.max(1, Math.min(168, Number(hours) || 24))
    const begin = begin_time || formatWeComTime(new Date(now.getTime() - windowHours * 3600_000))
    const end = end_time || formatWeComTime(now)
    const args = ['chat', 'messages', 'list', '--chat-id', id, '--begin-time', begin, '--end-time', end]
    if (cursor) args.push('--cursor', String(cursor))
    const res = await this.run(args, signal)
    if (!res.ok) throw new Error(res.error)
    const parsed = parseWeComOutput(res.stdout)
    const apiError = extractApiError(parsed)
    if (apiError) {
      if (apiError.help_message) this.authNotice = apiError.help_message
      return { messages: [], error: apiError.errmsg, errcode: apiError.errcode, help_message: apiError.help_message }
    }
    this.authNotice = null
    return { messages: normalizeWeComMessages(parsed, id), next_cursor: parsed.next_cursor ?? null, help_message: null }
  }

  async sendMessage({ chat_id, content, format = 'markdown' } = {}, signal) {
    const id = String(chat_id ?? '').trim()
    if (!id || !VALID_CHAT_ID.test(id)) throw new Error('请提供有效的 chat_id')
    const text = String(content ?? '').trim()
    if (!text) throw new Error('消息内容不能为空')
    if (text.length > 4096) throw new Error('消息内容不能超过 4096 字')
    const args = format === 'text'
      ? ['message', 'send', '--chat-id', id, '--msg-type', 'text', '--text', JSON.stringify({ content: text })]
      : ['message', 'aibot', 'send', '--chat-id', id, '--msg-type', 'markdown', '--markdown', JSON.stringify({ content: text })]
    const res = await this.run(args, signal)
    if (!res.ok) throw new Error(res.error)
    const parsed = parseWeComOutput(res.stdout)
    const apiError = extractApiError(parsed)
    if (apiError) {
      if (apiError.help_message) this.authNotice = apiError.help_message
      return { ok: false, error: apiError.errmsg, errcode: apiError.errcode, help_message: apiError.help_message }
    }
    this.authNotice = null
    return { ok: true, result: parsed }
  }

  rememberSeen(id) {
    this.seen.add(id)
    if (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value
      this.seen.delete(oldest)
    }
  }

  async pollOnce({ seed = !this.seeded } = {}, signal) {
    if (this.polling) return { skipped: true }
    this.polling = true
    const published = []
    try {
      const targets = new Map()
      for (const chat of this.config.watched_chats) targets.set(chat.chat_id, chat.name || chat.chat_id)
      if (this.config.auto_discover_sessions) {
        const discovered = await this.listSessions({}, signal)
        if (discovered.help_message) {
          this.lastPoll = { at: Date.now(), ok: false, error: discovered.error, help_message: discovered.help_message, published: 0 }
          return { published: 0, error: discovered.error, help_message: discovered.help_message }
        }
        for (const s of discovered.sessions.slice(0, 10)) {
          if (!targets.has(s.chat_id)) targets.set(s.chat_id, s.name)
        }
      }
      const now = new Date()
      const begin = formatWeComTime(new Date(now.getTime() - 15 * 60_000))
      const end = formatWeComTime(now)
      for (const [chatId, chatName] of targets) {
        const page = await this.listMessages({ chat_id: chatId, begin_time: begin, end_time: end }, signal)
        if (page.help_message) {
          this.lastPoll = { at: Date.now(), ok: false, error: page.error, help_message: page.help_message, published: published.length }
          return { published: published.length, error: page.error, help_message: page.help_message }
        }
        for (const msg of page.messages) {
          const key = `${chatId}:${msg.msg_id}`
          if (this.seen.has(key)) continue
          this.rememberSeen(key)
          if (seed) continue
          if (this.botId && msg.sender === this.botId) continue
          const payload = {
            chat_id: chatId,
            chat_name: chatName,
            sender: msg.sender,
            sender_name: msg.sender_name,
            content: msg.content,
            msg_id: msg.msg_id,
            msg_type: msg.msg_type,
            sent_at: msg.sent_at,
          }
          if (this.backend) {
            await this.backend.call('/api/v1/messaging/workbench/events', { topic: 'wecom/message', payload }, signal)
          }
          published.push(payload)
          this.recentEvents = [payload, ...this.recentEvents].slice(0, 20)
        }
      }
      this.seeded = true
      this.lastPoll = { at: Date.now(), ok: true, checked_chats: targets.size, published: published.length }
      return { published: published.length, checked_chats: targets.size, seeded: seed }
    } catch (error) {
      this.lastPoll = { at: Date.now(), ok: false, error: error.message, published: published.length }
      return { published: published.length, error: error.message }
    } finally {
      this.polling = false
    }
  }

  reschedule() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.stopped || !this.config.enabled) return
    const ms = Math.max(10, Math.min(300, this.config.poll_interval_secs || DEFAULT_POLL_SECS)) * 1000
    void this.pollOnce({ seed: !this.seeded }).catch(() => {})
    this.timer = setInterval(() => {
      if (!this.stopped && this.config.enabled) void this.pollOnce().catch(() => {})
    }, ms)
    this.timer.unref?.()
  }

  async start() {
    this.stopped = false
    await this.loadConfig()
    await this.status().catch(() => {})
    this.reschedule()
  }

  stop() {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }
}

export const wecomTools = [
  {
    name: 'wecom_sessions_list',
    description: 'List recent WeCom (企业微信) AI bot chats and group chats via wecom-cli. Returns chat_id and name for reading or replying.',
    parameters: {
      include_groups: { type: 'boolean', description: 'Also query recent group chats from the last 24h.' },
      hours: { type: 'integer', description: 'Lookback hours for groups (1-168, default 24).' },
    },
  },
  {
    name: 'wecom_messages_list',
    description: 'Read recent messages from a WeCom (企业微信) single chat or group chat via wecom-cli.',
    parameters: {
      chat_id: { type: 'string', required: true, description: 'WeCom chat_id (userid for single chat, group chat_id for group chat).' },
      hours: { type: 'integer', description: 'Lookback hours (1-168, default 24).' },
      begin_time: { type: 'string', description: 'Optional start time YYYY-MM-DD HH:MM:SS.' },
      end_time: { type: 'string', description: 'Optional end time YYYY-MM-DD HH:MM:SS.' },
      cursor: { type: 'string', description: 'Optional pagination cursor.' },
    },
  },
  {
    name: 'wecom_message_send',
    description: 'Send a message to a WeCom (企业微信) single chat or group chat via wecom-cli. Supports markdown (AI bot identity) or plain text.',
    parameters: {
      chat_id: { type: 'string', required: true, description: 'Target WeCom chat_id (userid or group chat_id).' },
      content: { type: 'string', required: true, description: 'Message content to send.' },
      format: { type: 'string', enum: ['markdown', 'text'], description: 'Message format: markdown (default, AI bot) or text.' },
    },
  },
]

export async function runWeComTool(bridge, name, args, signal) {
  if (!bridge) throw new Error('企业微信机器人桥接尚未就绪')
  if (name === 'wecom_sessions_list') return bridge.listSessions({ includeGroups: Boolean(args?.include_groups), hours: args?.hours }, signal)
  if (name === 'wecom_messages_list') return bridge.listMessages(args, signal)
  if (name === 'wecom_message_send') return bridge.sendMessage(args, signal)
  throw new Error(`Unknown WeCom tool: ${name}`)
}

export function registerWeComApi(ctx, bridge) {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/api/kode/wecom',
    handler: async (req, res, peer) => {
      const send = (status, value) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(value))
      }
      const admitted = admitHostRequest(ctx, req, peer)
      if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') {
        return send(403, { error: 'Host owner required' })
      }
      try {
        if (req.method === 'GET') {
          await bridge.loadConfig()
          const status = await bridge.status()
          return send(200, {
            status,
            config: bridge.config,
            last_poll: bridge.lastPoll,
            auth_notice: bridge.authNotice,
            recent_events: bridge.recentEvents,
          })
        }
        if (req.method !== 'POST') return send(405, { error: 'GET or POST required' })
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > MAX_BODY_BYTES) return send(413, { error: 'Request too large' })
        }
        const input = JSON.parse(body || '{}')
        if (input.action === 'configure') {
          const config = await bridge.saveConfig(input.config ?? input)
          return send(200, { config, status: await bridge.status(), last_poll: bridge.lastPoll, auth_notice: bridge.authNotice })
        }
        if (input.action === 'sessions') {
          return send(200, await bridge.listSessions({ includeGroups: Boolean(input.include_groups), hours: input.hours }))
        }
        if (input.action === 'messages') {
          return send(200, await bridge.listMessages(input))
        }
        if (input.action === 'send') {
          return send(200, await bridge.sendMessage(input))
        }
        if (input.action === 'poll_now') {
          const result = await bridge.pollOnce({ seed: false })
          return send(200, { ...result, last_poll: bridge.lastPoll, auth_notice: bridge.authNotice, recent_events: bridge.recentEvents })
        }
        return send(400, { error: 'Unknown wecom action' })
      } catch (error) {
        return send(400, { error: error.message })
      }
    },
  })
}
