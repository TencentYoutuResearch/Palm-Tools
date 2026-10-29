/** Executed on the SSH Host from an uploaded, checksum-verified private staging directory. */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { chmod, cp, mkdir, open, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const staging = dirname(fileURLToPath(import.meta.url)), base = join(homedir(), '.local/share/kode/dsh-host')
const data = join(base, 'state'), stateFile = join(base, 'deployment.json'), lock = join(base, 'install.lock')
const request = JSON.parse(await readFile(join(staging, 'request.json'), 'utf8'))
if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(request.localNode) || !/^[a-f0-9]{64}$/.test(request.linkToken) || !/^[a-f0-9]{64}$/.test(request.revision)) throw new Error('Invalid deployment request')
const stop = new AbortController(), children = new Set()
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stop.abort(new Error('部署已取消。')); for (const child of children) child.kill('SIGTERM') })
const progress = (step, status, message) => process.stdout.write(JSON.stringify({ step, status, message }) + '\n')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function save(path, value) { const tmp = `${path}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(tmp, path) }
function alive(pid) { if (!Number.isInteger(pid) || pid < 2) return false; try { process.kill(pid, 0); return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z') } catch { return false } }
async function port() { const s = createServer(); await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve) }); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p }
async function backend(state, path, body) {
  const response = await fetch(`http://127.0.0.1:${state.backendPort}/api/v1/messaging/${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${state.adminToken}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error('远端 Kode 服务健康检查失败。')
  return response.json()
}
async function web(state, path, body) {
  const login = await fetch(`http://127.0.0.1:${state.webPort}/?token=${encodeURIComponent(state.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
  const cookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  if (login.status !== 303 || !cookie) throw new Error('远端 dsh 认证失败。')
  const response = await fetch(`http://127.0.0.1:${state.webPort}${path}`, { method: body ? 'POST' : 'GET', headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('远端 dsh 尚未就绪。')
  return response.json()
}
async function healthy(state) { if (!state?.token || !alive(state.webPid) || !alive(state.backendPid)) return false; try { const node = await backend(state, 'node'); await web(state, '/api/kode/agents'); return node.node_id === state.nodeId && node.managed_peers } catch { return false } }
async function waitFor(check, message, recovering = false) {
  for (let i = 0; i < 120; i++) { if (!recovering) stop.signal.throwIfAborted(); try { return await check() } catch {} await sleep(500) }
  throw new Error(message)
}
async function stopOwned(pid) {
  if (!alive(pid)) return
  let command
  try { command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }) } catch { return }
  if (!command.includes(base + '/')) throw new Error('远端进程身份不匹配，未停止该进程。')
  process.kill(pid, 'SIGINT')
  for (let i = 0; i < 100; i++) { if (!alive(pid)) return; await sleep(100) }
  throw new Error('远端服务尚未结束，请稍后重试。')
}
async function installDependencies(release) {
  progress('dependencies', 'running', '安装官方 dsh 和 Kode 插件依赖')
  const log = await open(join(data, 'install.log'), 'a', 0o600)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: release, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, stdio: ['ignore', log.fd, log.fd], signal: stop.signal })
      children.add(child); child.once('error', reject); child.once('exit', code => { children.delete(child); code === 0 ? resolve() : reject(new Error('依赖安装失败；详细信息保存在 ~/.local/share/kode/dsh-host/state/install.log。')) })
    })
  } finally { await log.close() }
  progress('dependencies', 'done', '运行依赖已安装')
}
async function startService(argv, logPath, env) {
  const log = await open(logPath, 'a', 0o600)
  try {
    const shell = /\/(bash|zsh|sh)$/.test(process.env.SHELL ?? '') ? process.env.SHELL : '/bin/sh'
    const child = spawn(shell, ['-lc', 'exec "$@"', 'kode-managed-service', ...argv], { detached: true, cwd: base, env, stdio: ['ignore', log.fd, log.fd] })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref(); return child.pid
  } finally { await log.close() }
}
async function start(state, recovering = false) {
  const dshHome = join(data, 'dsh'), profile = join(dshHome, 'profiles/web')
  const runtime = join(state.release, 'node_modules'), bin = join(state.release, 'bin')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await save(join(profile, 'package.json'), { name: 'kode-managed-dsh-web', private: true, dependencies: { '@kode/dsh': `file:${join(state.release, 'plugin')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@kode/dsh'] } } })
  const modules = join(profile, 'node_modules')
  // This link belongs exclusively to the managed profile, never to a user's existing dsh home.
  await rm(modules, { force: true }); await symlink(runtime, modules, 'dir')
  await save(join(data, 'backend.json'), { node_id: state.nodeId, database: join(data, 'messages.sqlite'), peers: [] })
  await writeFile(join(data, 'admin.token'), state.adminToken + '\n', { mode: 0o600 })
  const patch = [{ id: 'kode', config: { url: `http://127.0.0.1:${state.backendPort}`, tokenFile: join(data, 'admin.token'), serverConfig: join(data, 'backend.json'), serverCommand: join(bin, 'kode-session-server'), sshTunnelCommand: join(bin, 'kode-ssh-tunnel'), sharedBackendState: true, publishWorkbenchConnection: false, stateFile: join(data, 'owners.json'), agentProfilesFile: join(data, 'agents.json'), projectHostsFile: join(data, 'ssh-hosts.json') } }, { id: 'directory-picker', disabled: true }, { insert: [{ id: 'kode-directory-browse-host', name: '@deepseek-ai/dsh-host-directory-picker-browse' }] }]
  await save(join(data, 'kode.patch.yml'), patch)
  const env = { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1', PATH: `${dirname(process.execPath)}:${bin}:${process.env.PATH}` }
  for (const key of Object.keys(env)) if (key.startsWith('KODE_')) delete env[key]
  state.backendPid = await startService([join(bin, 'kode-session-server'), '--config', join(data, 'backend.json'), '--token-file', join(data, 'admin.token'), '--bind', `127.0.0.1:${state.backendPort}`], join(data, 'backend.log'), env)
  await save(stateFile, state)
  await waitFor(() => backend(state, 'node'), '远端 Kode 服务启动超时。', recovering)
  const webLog = join(data, 'web.log'); const before = (await readFile(webLog, 'utf8').catch(() => '')).length
  state.webPid = await startService([process.execPath, join(runtime, '@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', join(data, 'kode.patch.yml'), '--host', '127.0.0.1', '--port', String(state.webPort), '--no-open'], webLog, env)
  await save(stateFile, state)
  await waitFor(async () => {
    const text = (await readFile(webLog, 'utf8')).slice(before)
    const match = /dsh web: (http:\/\/[^\s]+)/.exec(text)
    if (!match) throw new Error('Starting')
    state.token = new URL(match[1]).searchParams.get('token')
    await web(state, '/api/kode/agents')
  }, '远端 dsh 启动超时；请查看 ~/.local/share/kode/dsh-host/state/web.log。', recovering)
}
async function pair(state) {
  state.links ??= {}
  const token = state.links[request.localNode] ?? request.linkToken
  state.links[request.localNode] = token
  await save(stateFile, state)
  await backend(state, 'workbench/peers', { node_id: request.localNode, link_token: token, url: null, ssh: null })
  process.stdout.write(JSON.stringify({ kind: 'ready', nodeId: state.nodeId, webPort: state.webPort, backendPort: state.backendPort, token: state.token, linkToken: token }) + '\n')
}

await mkdir(data, { recursive: true, mode: 0o700 })
try { await mkdir(lock, { mode: 0o700 }) } catch (error) {
  if (error.code !== 'EEXIST') throw error
  const owner = await readJson(join(lock, 'owner.json'))
  if (!owner || alive(owner.pid)) throw new Error('此主机已有部署任务，请稍后重试。')
  await rm(lock, { recursive: true }); await mkdir(lock, { mode: 0o700 })
}
await save(join(lock, 'owner.json'), { pid: process.pid })
let previous, next, replacing = false
try {
  progress('runtime', 'done', 'Node.js 运行环境已就绪')
  previous = await readJson(stateFile)
  if (previous?.revision === request.revision && await healthy(previous)) {
    progress('dependencies', 'done', '复用已安装的服务'); progress('start', 'done', '远端服务正在运行'); progress('health', 'done', '健康检查通过'); await pair(previous)
  } else {
    if (previous && (alive(previous.webPid) || alive(previous.backendPid))) {
      if (!await healthy(previous)) throw new Error('已有远端服务状态异常，未覆盖；请检查其运行状态后重试。')
      const listing = await web(previous, '/api/session/list', { type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } } })
      if (!listing.result?.ok || listing.result.value.items.some(row => row.running || Object.values(row.projections?.values?.inbox ?? {}).some(queue => Array.isArray(queue) && queue.length))) throw new Error('远端有运行中或排队的会话，请在其结束后重试。')
    }
    const release = join(base, 'releases', request.revision)
    await mkdir(release, { recursive: true, mode: 0o700 }); await cp(join(staging, 'plugin'), join(release, 'plugin'), { recursive: true }); await cp(join(staging, 'bin'), join(release, 'bin'), { recursive: true })
    for (const name of ['kode-session-server', 'kode-ssh-tunnel']) await chmod(join(release, 'bin', name), 0o700)
    await save(join(release, 'package.json'), { name: 'kode-managed-dsh-host', private: true, dependencies: { '@deepseek-ai/dsh': request.dshVersion, '@kode/dsh': 'file:./plugin' }, allowScripts: { [`@deepseek-ai/dsh-subprocess-local@${request.dshVersion}`]: true, 'node-pty@1.2.0-beta.15': true, 'koffi@3.1.1': true, 'protobufjs@7.6.6': true } })
    await installDependencies(release)
    stop.signal.throwIfAborted()
    if (previous) {
      // Installation can take minutes. Recheck immediately before stopping the
      // old service so a conversation started during dependency setup survives.
      const listing = await web(previous, '/api/session/list', { type: 'client-request', rpcId: randomUUID(), method: 'session/list', payload: { args: { _request: {} } } })
      if (!listing.result?.ok || listing.result.value.items.some(row => row.running || Object.values(row.projections?.values?.inbox ?? {}).some(queue => Array.isArray(queue) && queue.length))) throw new Error('远端会话已开始运行，安装包已准备，服务未重启；请在其结束后重试。')
      await stopOwned(previous.webPid); await stopOwned(previous.backendPid); replacing = true
    }
    next = { ...previous, nodeId: previous?.nodeId ?? 'ssh-' + randomBytes(8).toString('hex'), adminToken: previous?.adminToken ?? randomBytes(32).toString('hex'), webPort: previous?.webPort ?? await port(), backendPort: previous?.backendPort ?? await port(), release, revision: request.revision, links: previous?.links ?? {} }
    if (next.webPort === next.backendPort) next.webPort = await port()
    delete next.webPid; delete next.backendPid
    await save(stateFile, next)
    progress('start', 'running', '启动 Kode 会话服务和 dsh'); await start(next); progress('start', 'done', '服务已启动')
    progress('health', 'running', '检查远端认证、插件和会话接口')
    if (!await healthy(next)) throw new Error('远端服务健康检查失败。')
    progress('health', 'done', '远端服务已就绪'); await pair(next)
    for (const entry of await readdir(join(base, 'releases'), { withFileTypes: true })) {
      const path = join(base, 'releases', entry.name)
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && path !== next.release && path !== previous?.release) await rm(path, { recursive: true, force: true }).catch(() => {})
    }
  }
} catch (error) {
  if (next) { await stopOwned(next.webPid).catch(() => {}); await stopOwned(next.backendPid).catch(() => {}) }
  if (replacing && previous) { await start(previous, true).then(() => save(stateFile, previous)).catch(() => {}) }
  process.stderr.write(String(error.message).slice(0,1000) + '\n'); process.exitCode = 1
} finally { await rm(lock, { recursive: true, force: true }); await rm(staging, { recursive: true, force: true }) }
