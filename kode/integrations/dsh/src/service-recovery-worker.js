/** Restart the verified backend. CLI Web also exits and relaunches its Host. */
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { processCommand } from './service-recovery.js'

const file = process.argv[2], plan = JSON.parse(await readFile(file, 'utf8'))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const waitForExit = async pid => {
  const deadline = Date.now() + 20000
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error('Process did not stop gracefully')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
const launch = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: plan.cwd, env: plan.env, detached: true, stdio: 'ignore', shell: false })
  child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(child.pid) })
})
let committed = false
const timeout = setTimeout(() => process.exit(1), 10000)
process.once('message', async message => {
  if (!message.commit) return
  committed = true; clearTimeout(timeout)
  let hostStopped = false
  let result = { status: 'done' }
  try {
    if (!plan.backendOnly) { await waitForExit(plan.parent); hostStopped = true }
    if (alive(plan.backend.pid)) {
      if (await processCommand(plan.backend.pid) !== plan.backend.command) throw new Error('Backend identity changed')
      process.kill(plan.backend.pid, 'SIGINT'); await waitForExit(plan.backend.pid)
    } else if (plan.backendOnly) throw new Error('Backend process already exited')
    const pid = await launch(plan.command, plan.args)
    if (plan.url) {
      const token = (await readFile(plan.tokenFile, 'utf8')).trim(), deadline = Date.now() + 15000
      let ready = false
      while (Date.now() < deadline) {
        if (!alive(pid)) break
        try {
          const response = await fetch(`${plan.url}/api/v1/messaging/node`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000), redirect: 'error' })
          // Verify that readiness is reported by the *new* service rather than
          // an older listener or another process that started on this port.
          if (response.ok && (!plan.backendOnly || (await response.json()).pid === pid)) { ready = true; break }
        } catch { /* Wait for the backend listener before resuming the Host. */ }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      if (!ready) throw new Error('Backend readiness check failed')
    }
  } catch { result = { status: 'failed', error: '未能确认 Kode 服务已重新启动，请重新连接后检查。' } }
  finally {
    // Bring the Host back even when backend replacement fails, so recovery stays accessible.
    if (hostStopped) await launch(plan.executable, plan.argv).catch(() => {})
    await rm(dirname(file), { recursive: true, force: true })
    if (plan.backendOnly && process.connected) process.send({ result }, () => { if (process.connected) process.disconnect() })
  }
})
process.once('disconnect', () => { if (!committed) process.exit(1) })
process.send({ ready: true })
