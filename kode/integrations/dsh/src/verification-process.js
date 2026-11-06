/** Bounded observation of an explicitly configured local command; no shell or inherited environment. */
import { spawn } from 'node:child_process'
export async function runVerificationProcess(definition, cwd, signal) {
  signal?.throwIfAborted()
  if (process.platform === 'win32') throw new Error('Verification process-group adapter unavailable')
  const child = spawn(definition.executable, definition.args, { cwd, env: definition.env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = [], failures = []
  let bytes = 0, reason, timer, escalation, deadline, spawnError, settle
  const kill = name => {
    if (!child.pid) return
    try { process.kill(-child.pid, name) } catch (error) { if (error.code !== 'ESRCH') failures.push(error.code ?? 'SIGNAL_FAILED') }
  }
  const stop = why => {
    reason ??= why
    kill('SIGTERM')
    escalation ??= setTimeout(() => kill('SIGKILL'), 250)
    deadline ??= setTimeout(() => { reason = 'stop_unconfirmed'; child.stdout.destroy(); child.stderr.destroy(); child.unref(); settle?.({ code: child.exitCode, signal: child.signalCode }) }, 3000)
  }
  const abort = () => stop('cancelled')
  const capture = stream => data => {
    if (chunks.length >= 4096) { stop('output_limit'); return }
    const keep = Math.min(data.length, Math.max(0, definition.max_output_bytes - bytes))
    if (keep) { chunks.push({ stream, data: data.subarray(0, keep).toString('base64') }); bytes += keep }
    if (keep < data.length) stop('output_limit')
  }
  child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'))
  child.on('error', error => { spawnError = error.code ?? 'SPAWN_FAILED' })
  // A leader must not leave background work behind while claiming verification finished.
  child.on('exit', () => {
    if (!child.pid) return
    try { process.kill(-child.pid, 0); stop('descendants_pending') }
    catch (error) { if (error.code !== 'ESRCH') { failures.push(error.code ?? 'GROUP_CHECK_FAILED'); stop('group_unconfirmed') } }
  })
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  timer = setTimeout(() => stop('timeout'), definition.timeout_ms)
  try {
    const exit = await new Promise(resolve => { settle = resolve; child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal })) })
    if (reason) kill('SIGKILL')
    let processGroupEmpty = false
    if (child.pid) {
      try { process.kill(-child.pid, 0) }
      catch (error) { if (error.code === 'ESRCH') processGroupEmpty = true; else failures.push(error.code ?? 'GROUP_CHECK_FAILED') }
    }
    return { exit_code: exit.code, exit_signal: exit.signal, reason: reason ?? (spawnError ? 'spawn_error' : 'exited'),
      spawn_error: spawnError ?? null, output: chunks, output_bytes: bytes, signal_failures: failures,
      passed: !reason && !spawnError && !failures.length && exit.code === 0 && processGroupEmpty,
      process_group_empty: processGroupEmpty,
      signal_scope: 'process_group', descendants_confirmed: false }
  } finally { clearTimeout(timer); clearTimeout(escalation); clearTimeout(deadline); signal?.removeEventListener('abort', abort) }
}
