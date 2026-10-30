/** Own a native ACP process tree without a shell or inherited Host credentials. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { HOST_ONLY_ENV } from './agent-profiles.js'
export function spawnAgent(command, args, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  for (const name of HOST_ONLY_ENV) delete env[name]
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const state = { child, closed: false, stderr: '', error: undefined }
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-8192) })
  child.on('error', error => { state.error = error; state.closed = true })
  child.on('exit', (code, signal) => { state.closed = true; state.error ??= new Error(`Agent process exited (${signal ?? code})`) })
  const kill = signal => {
    if (!child.pid) return
    try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) }
    catch (error) {
      // macOS can retain a terminal process group as protected zombies while
      // reaping it. Do not let that prevent MCP sockets/temp files from closing.
      if (error.code !== 'ESRCH' && !(error.code === 'EPERM' && (child.exitCode !== null || child.signalCode !== null))) throw error
    }
  }
  state.close = async () => {
    state.closed = true
    if (!child.pid) return
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit').catch(() => {})
    kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 2000)
    try { await exited } finally { clearTimeout(timer); kill('SIGKILL') }
  }
  return state
}
