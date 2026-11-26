/** Owner-requested recovery of a local Kode service. Never signal an unidentified process. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBundledServer } from './bundle-runtime.js'

const exec = promisify(execFile)
export function hasPendingSessions(items) {
  return items.some(row => row.running || ['inbox', 'kodeInbox'].some(key => Object.values(row.projections?.values?.[key] ?? {}).some(queue => Array.isArray(queue) && queue.length)))
}
function localRecoveryMode(ctx, argv, config, versions) {
  if (typeof ctx.get?.('appExit') === 'function' && /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/.test(argv[1] ?? '') && argv.includes('web')) return 'web'
  if (!versions.electron || !/[/\\]@deepseek-ai[/\\]dsh-desktop-host[/\\]lib[/\\]index\.js$/.test(argv[1] ?? '')) return
  // Desktop does not own services started by the Kode application or custom supervisors.
  const command = config?.serverCommand ?? ''
  if (!isAbsolute(command) || basename(command) !== 'kode-session-server' || !config?.backendClient) return
  try { backendArguments(config); return 'desktop' } catch { /* no verifiable local launch configuration */ }
}
export function localRecoverySupported(ctx, argv = process.argv, config, versions = process.versions) {
  return localRecoveryMode(ctx, argv, config, versions) !== undefined
}
export function backendArguments(config) {
  const url = new URL(config.url)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !config.serverConfig || !config.tokenFile || !config.serverCommand) throw new Error('此后端没有可验证的本机启动配置，请手动更新并重启 Kode 服务。')
  return [...(config.serverArgs ?? []), '--config', config.serverConfig, '--token-file', config.tokenFile, '--bind', `${url.hostname}:${url.port || '80'}`]
}
export async function processCommand(pid) {
  return (await exec('ps', ['-ww', '-p', String(pid), '-o', 'command='])).stdout.trim()
}
async function backendProcess(config, args) {
  const port = new URL(config.url).port || '80'
  const { stdout } = await exec('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
  const candidates = [...new Set(stdout.trim().split(/\s+/).map(Number))].filter(pid => Number.isSafeInteger(pid) && pid > 1)
  const expected = [config.serverCommand, ...args].join(' ')
  const matches = []
  for (const pid of candidates) if (await processCommand(pid) === expected) matches.push(pid)
  if (matches.length !== 1) throw new Error('无法确认本机 Kode 服务的进程身份，未执行重启。请手动更新并重启该服务。')
  return { pid: matches[0], command: expected }
}
async function backendCwd(pid) {
  const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  const cwd = stdout.split('\n').find(line => line.startsWith('n'))?.slice(1)
  if (!cwd || !isAbsolute(cwd)) throw new Error('Backend working directory is unavailable')
  return cwd
}

export async function prepareLocalRecovery(ctx, config, { argv = process.argv, versions = process.versions, confirmedSessions = [] } = {}) {
  const mode = localRecoveryMode(ctx, argv, config, versions)
  if (!mode) throw new Error('此启动方式不支持自动重启，请从管理此服务的应用或启动器重启 Kode 服务。')
  // Desktop replaces only the standalone service. DSH and GUI own their
  // Agent processes and reconnect, so their published status is irrelevant.
  const backendOnly = mode === 'desktop'
  const controller = backendOnly ? undefined : ctx.get?.('sessionController')
  const affectedSessions = async () => {
    if (backendOnly) return []
    const result = await controller?.list({})
    if (!Array.isArray(result?.items)) throw new Error('无法检查本机 Web Host 的会话，未执行重启。')
    return result.items.filter(row => hasPendingSessions([row]))
  }
  const checkImpact = async () => {
    const rows = await affectedSessions()
    if (rows.some(row => !row.sessionId || !confirmedSessions.includes(row.sessionId))) {
      const error = new Error('重启 Web Host 会中断本机运行中或排队的会话。')
      error.affectedSessions = rows.map(row => ({ id: row.sessionId, title: row.title || row.sessionId }))
      throw error
    }
    return rows
  }
  await checkImpact()
  const args = backendArguments(config)
  let backend, cwd
  try {
    backend = await backendProcess(config, args)
    // A manually deployed backend is allowed to resolve its database relative
    // to its own working directory. Keep that directory when restarting.
    cwd = backendOnly ? await backendCwd(backend.pid) : process.cwd()
  }
  catch { throw new Error('无法确认本机 Kode 服务的进程身份，未执行重启。请手动更新并重启该服务。') }
  const command = mode === 'web' && basename(config.serverCommand) === 'kode-session-server' ? await resolveBundledServer() ?? config.serverCommand : config.serverCommand
  await access(command, constants.X_OK)
  const root = await mkdtemp(join(tmpdir(), 'kode-service-recovery-'))
  const planFile = join(root, 'plan.json')
  let child
  try {
    await writeFile(planFile, JSON.stringify({ backendOnly, parent: process.pid, backend, command, args, tokenFile: resolve(cwd, config.tokenFile), url: config.url, executable: process.execPath, argv: [...process.execArgv, ...process.argv.slice(1)], cwd, env: process.env }), { mode: 0o600 })
    child = spawn(process.execPath, [fileURLToPath(new URL('./service-recovery-worker.js', import.meta.url)), planFile], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false, env: mode === 'desktop' ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('重启准备超时，服务未停止。')), 5000)
      const finish = fn => value => { clearTimeout(timer); fn(value) }
      child.once('error', finish(reject))
      child.once('exit', finish(() => reject(new Error('重启准备失败，服务未停止。'))))
      child.once('message', finish(message => message.ready ? resolve() : reject(new Error('重启准备失败，服务未停止。'))))
    })
    // Recheck immediately before arming the worker; preparation must not stop a new turn.
    const affected = await checkImpact()
    return {
      backendOnly,
      commit() {
        if (backendOnly) return new Promise(resolve => {
          const failed = { status: 'failed', error: 'Kode 服务重启失败，请重新连接后重试。' }
          if (!child.connected) { void rm(root, { recursive: true, force: true }); resolve(failed); return }
          child.once('message', message => resolve(message.result ?? failed))
          child.once('exit', () => resolve(failed))
          child.send({ commit: true }, error => { if (error) { child.kill('SIGTERM'); void rm(root, { recursive: true, force: true }); resolve(failed) } })
        })
        if (!child.connected) { void rm(root, { recursive: true, force: true }); return }
        for (const row of affected) {
          const agent = ctx.get?.('agents')?.get(row.sessionId)
          if (agent?.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
        }
        child.send({ commit: true }, error => {
          if (error) { child.kill('SIGTERM'); void rm(root, { recursive: true, force: true }); return }
          child.disconnect(); child.unref(); ctx.get('appExit')(0)
        })
      },
      async cancel() { child.kill('SIGTERM'); await rm(root, { recursive: true, force: true }) },
    }
  } catch (error) { child?.kill('SIGTERM'); await rm(root, { recursive: true, force: true }); throw error }
}
