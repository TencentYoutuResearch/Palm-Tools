import { savedSessionTime } from './saved-session-state.js'
/** Kode owns SSH; the remote dsh Host owns all workspace and execution services. */
import { createServer, request as httpRequest } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { once } from 'node:events'
import { hostDirectory, hostOperation, registerHostDirectory, DIRECTORY_PATH } from './workspace-directory.js'
import { BackendDocument } from './backend-state.js'
import { createHash } from 'node:crypto'
import { importSavedSession } from './workbench-import.js'
import { deployRemote, deploymentHost, DEPLOY_STEPS } from './remote-deploy.js'
import { registerWorktreeApi } from './worktree-api.js'
import { registerBrowserApi } from './browser-host.js'
const PATH = '/api/kode/project-hosts'
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
export function validateHost(input, previous) {
  const host = String(input.host ?? '').trim(), name = String(input.name ?? '').trim(), port = Number(input.port || 22)
  if (!name || name.length > 100 || !host || host.startsWith('-') || /[\s\x00-\x1f]/.test(host) || host.length > 255) throw new Error('请输入主机名称和有效 SSH 地址。')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SSH 端口必须在 1–65535 之间。')
  const accessUrl = String(input.accessUrl ?? '').trim()
  const url = new URL(accessUrl || (previous ? `http://127.0.0.1:${previous.remote_port}/?token=${encodeURIComponent(previous.token)}` : ''))
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') throw new Error('请粘贴远端 dsh 输出的本机 HTTP 访问链接，连接只通过 SSH。')
  if (!url.searchParams.get('token')) throw new Error('访问链接需要包含 token，请复制远端 dsh 输出的完整链接。')
  return { id: input.id || randomUUID(), name, host, port, remote_port: Number(url.port || 80), token: url.searchParams.get('token'), ...((input.configFile ?? previous?.config_file) ? { config_file: String(input.configFile ?? previous.config_file) } : {}), ...(!accessUrl && previous?.managed ? { managed: true, node_id: previous.node_id } : {}) }
}
export async function openKodeTunnel(command, host) {
  const child = spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  let errorText = ''
  child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2048) })
  child.stdin.on('error', () => {})
  const lines = createInterface({ input: child.stdout })
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
    const exit = once(child, 'exit'); child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    try { await exit } finally { clearTimeout(timer) }
  }
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SSH 连接超时，请检查 SSH 配置及远端 dsh。')), 15000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`SSH 隧道退出：${errorText || '请检查密钥与 known_hosts。'}`)) })
      lines.once('line', line => { clearTimeout(timer); try { resolve(JSON.parse(line)) } catch (error) { reject(error) } })
    })
    child.stdin.write(JSON.stringify({ host: host.host, port: host.port, remote_port: host.remote_port, config_file: host.config_file ?? null }) + '\n')
    const { url } = await ready
    return { url, close, child }
  } catch (error) { await close(); throw error }
}
export class ProjectHosts {
  constructor(ctx, config, tunnel = openKodeTunnel) {
    this.ctx = ctx; this.config = config; this.tunnel = tunnel
    this.file = config.projectHostsFile ?? join(homedir(), '.config/kode/dsh-project-hosts.json')
    this.hosts = []; this.portals = new Map(); this.pending = new Map(); this.saving = Promise.resolve(); this.closed = false; this.directoryCache = new Map(); this.directoryJobs = new Map()
    this.document = config.sharedBackendState && config.backendClient ? new BackendDocument(config.backendClient, 'ssh-hosts') : undefined
    this.saved = new Map()
    this.deployments = new Map()
  }
  async load() {
    if (this.document) { const state = await this.document.read(); if (state) {
      const previous = this.hosts; this.hosts = state
      for (const host of previous) { const next = state.find(row => row.id === host.id); if (!next || next.token !== host.token || next.remote_port !== host.remote_port || next.host !== host.host) await this.disconnect(host.id) }
      return
    } }
    try { this.hosts = JSON.parse(await readFile(this.file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (this.document) await this.document.write(this.hosts)
  }
  async workspaceCatalog() {
    if (!this.config.backendClient) throw new Error('Kode workspace backend is required')
    await this.load()
    const client = this.config.backendClient
    const nodes = await client.call('/api/v1/messaging/workbench/workspaces/hosts')
    const normalize = host => String(host ?? '').split('@').at(-1).toLocaleLowerCase()
    const view = async (name, kind, node) => {
      try {
        if (!node) throw new Error('This SSH Host has no registered Kode backend node')
        const result = await client.call(`/api/v1/messaging/workbench/workspaces?node_id=${encodeURIComponent(node)}`)
        return { name, kind, node_id: node, workspaces: result.workspaces.map(row => ({ id: row.id, name: row.title, path: row.path })) }
      } catch (error) { return { name, kind, workspaces: [], error: error.message } }
    }
    return Promise.all([view('此计算机', 'local', nodes.local_node_id), ...this.hosts.map(host => view(host.name, 'ssh', nodes.hosts.find(node => normalize(node.ssh_host) === normalize(host.host))?.node_id))])
  }
  view(current = 'local') { return { current, deploymentSupported: Boolean(this.config.backendClient), hosts: [{ id: 'local', name: '此计算机' }, ...this.hosts.map(({ id, name, host, port }) => ({ id, name, host, port, connected: this.portals.has(id) }))] } }
  save() {
    this.saving = this.saving.then(async () => {
      if (this.document) { await this.document.write(this.hosts); return }
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(this.hosts), { mode: 0o600 }); await rename(temp, this.file)
    }); return this.saving
  }
  async directory(current = 'local') {
    const local = await hostDirectory(this.ctx, this.config)
    for (const host of this.hosts) {
      if (this.directoryJobs.has(host.id)) continue
      const previous = this.directoryCache.get(host.id)
      if (previous && Date.now() - previous.checkedAt < 10000) continue
      const job = (async () => {
        try {
          const portal = await this.connect(host.id), snapshot = await portal.directory()
          if (this.hosts.some(row => row.id === host.id)) this.directoryCache.set(host.id, { ...snapshot, checkedAt: Date.now(), status: 'online' })
        } catch {
          this.directoryCache.set(host.id, { ...previous, checkedAt: Date.now(), status: 'offline', error: '连接失败，点击重试' })
        }
      })().finally(() => this.directoryJobs.delete(host.id))
      this.directoryJobs.set(host.id, job)
    }
    const hosts = [{ id: 'local', name: '此计算机', status: 'online', ...local }, ...this.hosts.map(host => ({ id: host.id, name: host.name, status:'connecting', workspaces:[], sessions:[], archivedSessionIds:[], pinnedSessionIds:[], ...this.directoryCache.get(host.id) }))]
    if (this.config.backendClient) {
      const catalog = await this.config.backendClient.call('/api/v1/messaging/workbench/catalog')
      this.saved.clear()
      for (const host of hosts) for (const row of host.sessions ?? []) if (row.savedTab) this.saved.set(row.id, { tab: row.savedTab, hostId: host.id })
      for (const tab of catalog.tabs ?? []) {
        if (!tab.session_id || !tab.cwd) continue
        const endpointId = typeof tab.endpoint_id === 'object' ? tab.endpoint_id?.id : tab.endpoint_id
        const endpoint = (catalog.endpoints ?? []).find(row => row.id === endpointId)
        const remote = endpoint?.ssh_host?.split('@').at(-1)
        const target = remote ? this.hosts.find(row => row.host.split('@').at(-1) === remote) : undefined
        if (endpointId && !target) continue
        const hostId = target?.id ?? 'local', host = hosts.find(row => row.id === hostId)
        if (!host) continue
        const key = `saved:${createHash('sha256').update(`${hostId}:${tab.backend_key}:${tab.session_id}`).digest('hex').slice(0,32)}`
        const adopted = tab.dsh_session_id ?? `session-kode-${createHash('sha256').update(`${tab.backend_key}:${tab.session_id}`).digest('hex').slice(0,32)}`
        if (host.sessions.some(row => row.id === adopted || row.nativeThreadId === tab.session_id)) continue
        this.saved.set(key, { tab, hostId })
        host.sessions = [...host.sessions, { id: key, title: tab.title || '已保存的会话', cwd: tab.cwd, updatedAt: savedSessionTime(tab), running: false, nativeThreadId: tab.session_id }]
        if (host.archivedSessionIds?.includes(adopted)) host.archivedSessionIds.push(key)
        let workspace = host.workspaces.find(row => row.path === tab.cwd)
        if (workspace) { workspace = { ...workspace, sessionIds: [...workspace.sessionIds, key] }; host.workspaces = host.workspaces.map(row => row.id === workspace.id ? workspace : row) }
      }
    }
    return { current, hosts }
  }
  async handle(req, res, current = 'local') {
    try {
      if (this.document) await this.load()
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams
        if (query.has('deployment')) return this.deploymentResponse(req, res, query.get('deployment'), query.get('events') === '1')
        return json(res, 200, query.get('view') === 'directory' ? await this.directory(current) : this.view(current))
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST required' })
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON required' })
      let text = ''
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 16384) throw new Error('配置过长。') }
      const input = JSON.parse(text)
      if (input.action === 'deploy') {
        if (current !== 'local') throw new Error('请返回此计算机后添加或部署 SSH 主机。')
        return json(res, 202, this.startDeployment(input))
      }
      if (input.action === 'cancel-deployment') {
        const job = this.deployments.get(input.deploymentId)
        if (!job) throw new Error('部署任务不存在。')
        if (job.status === 'running') job.controller.abort(new Error('部署已取消。'))
        return json(res, 200, this.deploymentView(job))
      }
      if (input.action === 'import-saved') {
        await this.directory(current)
        const saved = this.saved.get(input.sessionId)
        if (!saved) throw new Error('Saved session was not found; refresh the directory')
        const result = saved.hostId === 'local' ? await importSavedSession(this.ctx, this.config.backendClient, saved.tab) : await (await this.connect(saved.hostId)).importSession(saved.tab)
        this.directoryCache.delete(saved.hostId)
        return json(res, 200, { ...result, hostId: saved.hostId })
      }
      if (input.action === 'prepare') { if (input.id !== 'local') await this.connect(input.id); return json(res, 200, { id: input.id, ready: true }) }
      if (input.action === 'host-operation') {
        if (input.args?.sessionId?.startsWith('saved:')) {
          await this.directory(current)
          const saved = this.saved.get(input.args.sessionId)
          if (!saved || saved.hostId !== input.id) throw new Error('历史会话不属于此主机，请刷新列表。')
          input.nativeSession = { backend_key: saved.tab.backend_key, session_id: saved.tab.session_id }
        }
        if (input.id === 'local') await hostOperation(this.ctx, input, this.config)
        else { const portal = await this.connect(input.id); const snapshot = await portal.operation(input); this.directoryCache.set(input.id, { ...snapshot, checkedAt: Date.now(), status: 'online' }) }
        return json(res, 200, { ok: true })
      }
      if (input.action === 'refresh') { this.directoryCache.delete(input.id); return json(res, 200, await this.directory(current)) }
      if (input.action === 'save') {
        if (current !== 'local' && input.id === current) throw new Error('请先切换到此计算机，再编辑当前主机。')
        const index = this.hosts.findIndex(row => row.id === input.id)
        const host = validateHost(input, this.hosts[index])
        if (index >= 0) { await this.disconnect(host.id); this.hosts[index] = host } else this.hosts.push(host)
        await this.save(); return json(res, 200, { id: host.id, ...this.view(current) })
      }
      if (input.action === 'delete') { if (current !== 'local' && input.id === current) throw new Error('请先切换到此计算机，再移除当前主机。'); const host = this.hosts.find(row => row.id === input.id); if (host?.managed && host.node_id && this.config.backendClient) await this.config.backendClient.call('/api/v1/messaging/workbench/peers/remove', { node_id: host.node_id }); await this.disconnect(input.id); this.hosts = this.hosts.filter(row => row.id !== input.id); await this.save(); return json(res, 200, this.view(current)) }
      if (input.action === 'connect') {
        const target = input.sessionId ? ['session', input.sessionId] : input.workspaceId ? ['workspace', input.workspaceId] : null
        if (target && (typeof target[1] !== 'string' || target[1].length > 256)) throw new Error('无效会话或项目。')
        const fragment = target ? `#kode-open-${target[0]}=${encodeURIComponent(target[1])}` : input.create ? `#kode-create-project=${encodeURIComponent(String(input.name ?? '').slice(0, 100))}` : ''
        if (input.id === 'local') return json(res, 200, { url: this.ctx.connection.authenticatedUrl(this.ctx.webServer.getOrigin() + '/') + fragment })
        const portal = await this.connect(input.id), nonce = randomBytes(24).toString('hex')
        for (const [key, expiry] of portal.tickets) if (expiry < Date.now()) portal.tickets.delete(key)
        portal.tickets.set(nonce, Date.now() + 60000)
        return json(res, 200, { url: `${portal.origin}/?kode_ticket=${nonce}${fragment}` })
      }
      throw new Error('未知项目操作。')
    } catch (error) { json(res, 400, { error: error.message }) }
  }
  deploymentView(job) { return { id: job.id, status: job.status, steps: [...job.steps.values()], ...(job.error ? { error: job.error } : {}), ...(job.result ? { result: job.result } : {}) } }
  deploymentResponse(req, res, id, events) {
    const job = this.deployments.get(id)
    if (!job) return json(res, 404, { error: '部署任务不存在，请重新连接。' })
    if (!events) return json(res, 200, this.deploymentView(job))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    const send = () => { res.write(`data: ${JSON.stringify(this.deploymentView(job))}\n\n`); if (job.status !== 'running') res.end() }
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000)
    job.listeners.add(send); res.on('close', () => { job.listeners.delete(send); clearInterval(heartbeat) }); send()
  }
  startDeployment(input) {
    if (this.closed) throw new Error('Host is stopping')
    const previous = input.id && this.hosts.find(row => row.id === input.id)
    const host = deploymentHost({ ...input, configFile: input.configFile || previous?.config_file })
    if (input.id && !previous) throw new Error('主机不存在，请刷新后重试。')
    for (const job of this.deployments.values()) if (job.status === 'running' && job.host.host === host.host && job.host.port === host.port) return this.deploymentView(job)
    if ([...this.deployments.values()].filter(job => job.status === 'running').length >= 3) throw new Error('已有多个主机正在部署，请稍后重试。')
    for (const [id, job] of this.deployments) if (this.deployments.size >= 20 && job.status !== 'running') this.deployments.delete(id)
    const job = { id: randomUUID(), host, status: 'running', controller: new AbortController(), listeners: new Set(), steps: new Map(DEPLOY_STEPS.map(step => [step, { step, status: 'pending', message: '' }])) }
    this.deployments.set(job.id, job)
    const notify = () => { for (const listener of job.listeners) { try { listener() } catch { job.listeners.delete(listener) } } }
    const progress = (step, status, message) => { job.steps.set(step, { step, status, message }); notify() }
    job.promise = (async () => {
      try {
        const deployed = await (this.config.deployRemote ?? deployRemote)(host, this.config, { signal: job.controller.signal, progress })
        job.controller.signal.throwIfAborted()
        progress('save', 'running', '保存主机并检查连接')
        await this.load()
        const same = previous ?? this.hosts.find(row => row.host === host.host && row.port === host.port)
        const record = { ...deployed, id: same?.id ?? randomUUID() }
        await this.disconnect(record.id)
        const index = this.hosts.findIndex(row => row.id === record.id)
        if (index < 0) this.hosts.push(record); else this.hosts[index] = record
        await this.save(); await this.connect(record.id)
        progress('save', 'done', '主机已连接，可以选择远端项目')
        job.result = { id: record.id, name: record.name }; job.status = 'done'
      } catch (error) {
        job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
        job.error = String(job.controller.signal.aborted ? '部署已取消；已下载的资源可在重试时复用。' : error.message).replace(/([?&]token=)[^\s&]+/g, '$1[redacted]').slice(0,800)
        for (const [step, entry] of job.steps) if (entry.status === 'running') job.steps.set(step, { ...entry, status: 'failed' })
      } finally { notify() }
    })()
    return this.deploymentView(job)
  }
  connect(id) {
    if (this.closed) throw new Error('Host is stopping')
    if (this.portals.has(id)) return Promise.resolve(this.portals.get(id))
    if (this.pending.has(id)) return this.pending.get(id)
    const task = this.createPortal(id).finally(() => this.pending.delete(id)); this.pending.set(id, task); return task
  }
  async createPortal(id) {
    const host = this.hosts.find(row => row.id === id)
    if (!host) throw new Error('远端主机不存在。')
    const tunnel = await this.tunnel(this.config.sshTunnelCommand ?? 'kode-ssh-tunnel', host)
    let server
    try {
      const login = await fetch(`${tunnel.url}/?token=${encodeURIComponent(host.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
      const cookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
      if (login.status !== 303 || !cookie) throw new Error('远端 dsh 认证失败，服务重启后请更新访问链接。')
      const capability = await fetch(`${tunnel.url}${PATH}`, { headers: { cookie }, signal: AbortSignal.timeout(10000) })
      if (!capability.ok) throw new Error('远端 dsh 需要安装同版本 @kode/dsh 插件，请先完成远端配置。')
      const upstream = new URL(tunnel.url), secret = randomBytes(32).toString('hex'), tickets = new Map()
      const cookieName = `kode_portal_${id.replace(/[^a-zA-Z0-9]/g, '')}`
      let origin
      const admitted = req => {
        if (!req.url?.startsWith('/') || req.url.startsWith('//')) return false
        if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return false
        const value = (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
        return equal(value, secret)
      }
      const headers = req => {
        const result = { ...req.headers, host: upstream.host, cookie }
        for (const name of ['authorization', 'proxy-authorization', 'forwarded', 'x-forwarded-host']) delete result[name]
        if (result.origin) result.origin = upstream.origin
        return result
      }
      const gatewaySockets = new Set()
      const forward = (req, res, path = req.url) => {
        const request = httpRequest(new URL(path, upstream), { method: req.method, headers: headers(req) }, response => {
          const outgoing = { ...response.headers }; delete outgoing['set-cookie']
          res.writeHead(response.statusCode, outgoing); response.pipe(res); res.on('close', () => response.destroy())
        })
        request.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('SSH 连接已断开，请重新连接。') })
        req.on('aborted', () => request.destroy()); res.on('close', () => request.destroy()); req.pipe(request)
      }
      const upgrade = (req, socket, head, path = req.url) => {
        gatewaySockets.add(socket); socket.once('close', () => gatewaySockets.delete(socket))
        const request = httpRequest(new URL(path, upstream), { headers: headers(req) })
        request.on('upgrade', (response, target, upstreamHead) => {
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).filter(([key]) => key !== 'set-cookie').map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
          if (head.length) target.write(head); if (upstreamHead.length) socket.write(upstreamHead)
          socket.pipe(target).pipe(socket); socket.on('error', () => target.destroy()); target.on('error', () => socket.destroy()); socket.on('close', () => target.destroy())
        })
        request.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Upstream Rejected\r\nConnection: close\r\n\r\n`); response.resume() })
        request.on('error', () => socket.destroy()); request.end()
      }
      server = createServer(async (req, res) => {
        const url = new URL(req.url, origin), ticket = url.searchParams.get('kode_ticket')
        if (req.headers.host === new URL(origin).host && req.method === 'GET' && url.pathname === '/' && ticket && tickets.get(ticket) > Date.now()) {
          tickets.delete(ticket); res.writeHead(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/` }); res.end(); return
        }
        if (!admitted(req)) { res.writeHead(401); res.end('请从本机 dsh 重新连接此主机。'); return }
        if (url.pathname === PATH) { await this.handle(req, res, id); return }
        forward(req, res)
      })
      server.on('upgrade', (req, socket, head) => {
        if (!admitted(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
        upgrade(req, socket, head)
      })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      origin = `http://127.0.0.1:${server.address().port}`
      const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
      const portal = { origin, tickets, forward, upgrade, importSession: async tab => {
        const response = await fetch(`${tunnel.url}/api/kode/session-import`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(tab), signal: AbortSignal.timeout(60000) })
        const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Cannot import saved session'); return value
      }, createSession: async (input, signal) => {
        const response = await fetch(`${tunnel.url}/api/kode/session-create`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000) })
        const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Remote session creation failed'); return value
      }, operation: async input => {
        const response = await fetch(`${tunnel.url}${DIRECTORY_PATH}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ operation: input.operation, args: input.args }), signal: AbortSignal.timeout(15000) })
        const value = await response.json(); if (!response.ok) throw new Error(value.error ?? '远端操作失败。'); return value
      }, directory: async () => {
        const response = await fetch(`${tunnel.url}${DIRECTORY_PATH}`, { headers: { cookie }, signal: AbortSignal.timeout(8000) })
        if (!response.ok) throw new Error('远端目录不可用，请更新 Kode 插件。')
        return response.json()
      }, close: async () => { server.close(); for (const socket of [...sockets, ...gatewaySockets]) socket.destroy(); await tunnel.close() } }
      if (this.closed) { await portal.close(); throw new Error('Host is stopping') }
      this.portals.set(id, portal)
      tunnel.child?.once('exit', () => { if (this.portals.get(id) === portal) { this.portals.delete(id); void portal.close() } })
      return portal
    } catch (error) { server?.close(); await tunnel.close(); throw error }
  }
  async disconnect(id) { await this.pending.get(id)?.catch(() => {}); const portal = this.portals.get(id); this.portals.delete(id); await portal?.close(); this.directoryCache.delete(id) }
  async close() { this.closed = true; for (const job of this.deployments.values()) if (job.status === 'running') job.controller.abort(new Error('Host is stopping')); await Promise.allSettled([...this.deployments.values()].map(job => job.promise)); await Promise.allSettled([...this.pending.values()]); await Promise.all([...this.portals.keys()].map(id => this.disconnect(id))); await this.saving }
}
export async function registerProjectHosts(ctx, config) {
  ctx.effect(() => registerWorktreeApi(ctx, config), 'kode.worktree-api')
  ctx.effect(() => registerBrowserApi(ctx, { ...config, browserProfileDirectory: config.browserProfileDirectory ?? join(dirname(config.stateFile ?? join(homedir(), '.config/kode/owners.json')), 'sidebar-browser') }), 'kode.browser-api')
  const manager = new ProjectHosts(ctx, config); await manager.load()
  ctx.provide('kodeProjectHosts', manager)
  ctx.effect(() => registerHostDirectory(ctx, config), 'kode.host-directory')
  ctx.effect(() => () => manager.close(), 'kode.project-hosts')
  const owner = req => { const admitted = ctx.connection.admit(req); return !('rejection' in admitted) && admitted.peer.principal.kind === 'owner' }
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/kode/session-import', handler: async (req, res) => {
    if (!owner(req)) return json(res, 403, { error: 'Host owner required' })
    if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 405, { error: 'JSON POST required' })
    try { let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 16384) throw new Error('Request too large') }; json(res, 200, await importSavedSession(ctx, config.backendClient, JSON.parse(body))) } catch (error) { json(res, 400, { error: error.message }) }
  } }), 'kode.session-import-api')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/kode/session-create', handler: async (req, res) => {
    if (!owner(req)) return json(res, 403, { error: 'Host owner required' })
    if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 405, { error: 'JSON POST required' })
    try {
      let body = ''; for await (const part of req) { body += part; if (Buffer.byteLength(body) > 65536) throw new Error('Request too large') }
      const creator = ctx.get('kodeSessionCreator'); if (!creator) throw new Error('Session creator unavailable')
      json(res, 200, await creator.create(JSON.parse(body)))
    } catch (error) { json(res, 400, { error: error.message }) }
  } }), 'kode.session-create-api')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/kode/transport', handler: async (req, res) => {
    if (!owner(req)) return json(res, 403, { error: 'Host owner required' })
    const match = /^\/api\/kode\/transport\/([^/]+)(\/api(?:\/|\?|$).*)$/.exec(req.url ?? '')
    if (!match) return json(res, 400, { error: 'Invalid Host API path' })
    try { const portal = await manager.connect(decodeURIComponent(match[1])); portal.forward(req, res, match[2]) } catch (error) { json(res, 502, { error: error.message }) }
  } }), 'kode.transport-http')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/kode/transport-ws', handler: async (req, socket, head) => {
    if (!owner(req)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    const url = new URL(req.url, 'http://localhost'), path = url.searchParams.get('path'), host = url.searchParams.get('host')
    if (!path || !/^\/api(?:\/|\?|$)/.test(path) || !host) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
    try { const portal = await manager.connect(host); portal.upgrade(req, socket, head, path) } catch { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') }
  } }), 'kode.transport-ws')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/kode/terminal-font.ttf', handler: async (req, res) => {
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) { res.writeHead(admitted.rejection); res.end(); return }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    const bytes = await readFile(new URL('../assets/fonts/SymbolsNerdFontMono-Regular.ttf', import.meta.url))
    res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'private, max-age=86400', 'content-length': bytes.length }); res.end(bytes)
  } }), 'kode.terminal-font')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: PATH, handler: async (req, res) => {
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return json(res, admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return json(res, 403, { error: 'Host owner required' })
    const requested = new URL(req.url, 'http://localhost').searchParams.get('current')
    const current = requested && manager.hosts.some(host => host.id === requested) ? requested : 'local'
    return manager.handle(req, res, current)
  } }), 'kode.project-hosts-api')
}
