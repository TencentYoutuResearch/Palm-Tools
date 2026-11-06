/** Own a native ACP process tree without a shell or inherited Host credentials. */
import { spawn } from 'node:child_process'
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
export function spawnAgent(command, args, cwd, extraEnv = {}, { inheritEnvironment = true } = {}) {
  const env = { ...(inheritEnvironment ? process.env : {}), ...extraEnv }
  for (const name of HOST_ONLY_ENV) delete env[name]
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const state = { child, closed: false, stderr: '', error: undefined }
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk).slice(-8192) })
  child.on('error', error => { state.error = error; state.closed = true })
  child.on('exit', (code, signal) => { state.closed = true; state.error ??= new Error(`Agent process exited (${signal ?? code})`) })
  const kill = signal => signalAgentProcess(child, signal)
  state.close = () => state.closing ??= (async () => {
    state.closed = true
    const failures = []
    const signalGroup = signal => {
      try { kill(signal) } catch (error) { failures.push(error.code ?? 'SIGNAL_FAILED') }
    }
    let timeout, escalation, onExit, onError
    const hasExited = () => child.exitCode !== null || child.signalCode !== null
    try {
      if (child.pid) {
        const exited = hasExited() ? Promise.resolve() : new Promise(resolve => {
          onExit = resolve; onError = resolve
          child.once('exit', onExit); child.once('error', onError)
        })
        signalGroup('SIGTERM')
        escalation = setTimeout(() => signalGroup('SIGKILL'), 2000)
        await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(resolve, 5000) })])
        // The leader can exit before its children. Still signal our owned group.
        signalGroup('SIGKILL')
      }
    } finally {
      clearTimeout(timeout); clearTimeout(escalation)
      if (onExit) child.off('exit', onExit)
      if (onError) child.off('error', onError)
    }
    // A successful signal and an exited leader do not establish group drainage.
    // ESRCH is the only positive observation; permission errors remain uncertain.
    let processGroupEmpty = false
    if (child.pid && process.platform !== 'win32') {
      const until = Date.now() + 250
      do {
        let permissionDenied = false
        try { process.kill(-child.pid, 0) }
        catch (error) {
          if (error.code === 'ESRCH') { processGroupEmpty = true; break }
          if (error.code !== 'EPERM') { failures.push(error.code ?? 'GROUP_CHECK_FAILED'); break }
          permissionDenied = true
        }
        if (Date.now() >= until) { if (permissionDenied) failures.push('EPERM'); break }
        await new Promise(resolve => setTimeout(resolve, 10))
      } while (true)
    }
    return state.stopEvidence = {
      spawned: Boolean(child.pid), leader_exited: Boolean(child.pid) && hasExited(), exit_code: child.exitCode, exit_signal: child.signalCode,
      signal_scope: process.platform === 'win32' ? 'leader' : 'process_group',
      process_group_empty: processGroupEmpty,
      descendants_confirmed: false, signal_failures: failures,
    }
  })()
  return state
}
