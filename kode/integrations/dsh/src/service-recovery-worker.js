/** Detached recovery worker: wait for graceful Host exit, replace its verified backend, relaunch. */
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
  child.once('error', reject); child.once('spawn', () => { child.unref(); resolve() })
})
let committed = false
const timeout = setTimeout(() => process.exit(1), 10000)
process.once('message', async message => {
  if (!message.commit) return
  committed = true; clearTimeout(timeout)
  let hostStopped = false
  try {
    await waitForExit(plan.parent); hostStopped = true
    if (alive(plan.backend.pid)) {
      if (await processCommand(plan.backend.pid) !== plan.backend.command) throw new Error('Backend identity changed')
      process.kill(plan.backend.pid, 'SIGINT'); await waitForExit(plan.backend.pid)
    }
    await launch(plan.command, plan.args)
    if (plan.url) {
      const token = (await readFile(plan.tokenFile, 'utf8')).trim(), deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`${plan.url}/api/v1/messaging/node`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000), redirect: 'error' })
          if (response.ok) break
        } catch { /* Wait for the backend listener before resuming the Host. */ }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
  } catch { /* The UI probes readiness and reports a bounded recovery failure. */ }
  finally {
    // Bring the Host back even when backend replacement fails, so recovery stays accessible.
    if (hostStopped) await launch(plan.executable, plan.argv).catch(() => {})
    await rm(dirname(file), { recursive: true, force: true })
  }
})
process.once('disconnect', () => { if (!committed) process.exit(1) })
process.send({ ready: true })
