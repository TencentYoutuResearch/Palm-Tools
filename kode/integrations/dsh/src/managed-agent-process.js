/** Own a native ACP process tree without a shell or inherited Host credentials. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { HOST_ONLY_ENV } from './agent-profiles.js'
export function signalAgentProcess(child, signal, { platform = process.platform, killGroup = process.kill } = {}) {
  if (!child.pid) return
  try { return platform === 'win32' ? child.kill(signal) : killGroup(-child.pid, signal) }
  catch (error) {
    if (error.code === 'ESRCH') return
    if (error.code !== 'EPERM') throw error
    // A protected/reaped process group must not crash the Host's cleanup timer.
    // Fall back to the specific child we own; never signal an unrelated PID.
    if (child.exitCode !== null || child.signalCode !== null) return
    try { return child.kill(signal) } catch (fallback) { if (fallback.code !== 'ESRCH' && fallback.code !== 'EPERM') throw fallback }
  }
}
export function spawnAgent(command, args, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  for (const name of HOST_ONLY_ENV) delete env[name]
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const state = { child, closed: false, stderr: '', error: undefined }
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-8192) })
  child.on('error', error => { state.error = error; state.closed = true })
  child.on('exit', (code, signal) => { state.closed = true; state.error ??= new Error(`Agent process exited (${signal ?? code})`) })
  const kill = signal => signalAgentProcess(child, signal)
  state.close = async () => {
    state.closed = true
    if (!child.pid) return
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit').catch(() => {})
    kill('SIGTERM')
    let timer
    const forced = new Promise((resolve, reject) => { timer = setTimeout(() => { try { kill('SIGKILL'); resolve() } catch (error) { reject(error) } }, 2000) })
    try { await Promise.race([exited, forced]) } finally { clearTimeout(timer); kill('SIGKILL') }
  }
  return state
}
