/** Owner-requested recovery of a CLI Web Host. Never signal an unidentified service. */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBundledServer } from './bundle-runtime.js'

const exec = promisify(execFile)
export function hasPendingSessions(items) {
  return items.some(row => row.running || ['inbox', 'kodeInbox'].some(key => Object.values(row.projections?.values?.[key] ?? {}).some(queue => Array.isArray(queue) && queue.length)))
}
export function localRecoverySupported(ctx, argv = process.argv) {
  return typeof ctx.get?.('appExit') === 'function' && /[/\\]@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/.test(argv[1] ?? '') && argv.includes('web')
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

export async function prepareLocalRecovery(ctx, config) {
  if (!localRecoverySupported(ctx)) throw new Error('此启动方式不支持自动重启。Desktop 请退出并重新打开应用；其他启动方式请手动重启 Web Host 和 Kode 服务。')
  const controller = ctx.get?.('sessionController')
  if (!controller?.list) throw new Error('无法检查运行中的会话，未执行重启。')
  const checkIdle = async () => {
    const { items } = await controller.list({})
    if (!Array.isArray(items) || hasPendingSessions(items)) throw new Error('此计算机有运行中或排队的会话，请在其结束后重试。')
  }
  await checkIdle()
  const args = backendArguments(config)
  let backend
  try { backend = await backendProcess(config, args) }
  catch { throw new Error('无法确认本机 Kode 服务的进程身份，未执行重启。请手动更新并重启该服务。') }
  const command = basename(config.serverCommand) === 'kode-session-server' ? await resolveBundledServer() ?? config.serverCommand : config.serverCommand
  await access(command)
  const root = await mkdtemp(join(tmpdir(), 'kode-service-recovery-'))
  const planFile = join(root, 'plan.json')
  await writeFile(planFile, JSON.stringify({ parent: process.pid, backend, command, args, tokenFile: config.tokenFile, url: config.url, executable: process.execPath, argv: [...process.execArgv, ...process.argv.slice(1)], cwd: process.cwd(), env: process.env }), { mode: 0o600 })
  let child
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL('./service-recovery-worker.js', import.meta.url)), planFile], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('重启准备超时，服务未停止。')), 5000)
      const finish = fn => value => { clearTimeout(timer); fn(value) }
      child.once('error', finish(reject))
      child.once('exit', finish(() => reject(new Error('重启准备失败，服务未停止。'))))
      child.once('message', finish(message => message.ready ? resolve() : reject(new Error('重启准备失败，服务未停止。'))))
    })
    // Recheck immediately before arming the worker; preparation must not stop a new turn.
    await checkIdle()
    return {
      commit() {
        if (!child.connected) { void rm(root, { recursive: true, force: true }); return }
        child.send({ commit: true }, error => {
          if (error) { child.kill('SIGTERM'); void rm(root, { recursive: true, force: true }); return }
          child.disconnect(); child.unref(); ctx.get('appExit')(0)
        })
      },
      async cancel() { child.kill('SIGTERM'); await rm(root, { recursive: true, force: true }) },
    }
  } catch (error) { child?.kill('SIGTERM'); await rm(root, { recursive: true, force: true }); throw error }
}
