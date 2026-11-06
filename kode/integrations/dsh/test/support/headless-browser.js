/** Owned, empty-profile browser for UI tests. Never attach to a user's running browser. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
export async function headlessBrowser(binary, profile) {
  const child = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--hide-crash-restore-bubble', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { detached: process.platform!=='win32', stdio: ['ignore', 'ignore', 'pipe'] })
  let socket, next = 0,closed=false
  child.once('close',()=>{closed=true})
  const pending = new Map(), listeners = new Set()
  const close = async (signal = 'SIGTERM') => {
    let failure
    try{socket?.close()}catch(error){failure=error}
    if (!child.pid) return
    const stop=nextSignal=>{try{if(process.platform!=='win32')process.kill(-child.pid,nextSignal);else if(child.exitCode===null&&child.signalCode===null)child.kill(nextSignal)}catch(error){if(error.code!=='ESRCH')throw error}}
    const done=closed?Promise.resolve():once(child,'close')
    stop(signal)
    const timer = setTimeout(() => {stop('SIGKILL');child.stderr?.destroy()}, 3000)
    try { await done } finally { clearTimeout(timer) }
    if(failure)throw failure
  }
  try {
    const address = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => finish(Error('Isolated browser startup timed out')), 15000)
      const finish = (error, value) => { clearTimeout(timer); child.stderr.off('data', data); child.off('error', failed); child.off('exit', failed); error ? reject(error) : resolve(value) }
      const failed = () => finish(Error('Isolated browser could not start'))
      const data = bytes => { output = (output + bytes).slice(-8192); const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-zA-Z0-9-]+)/); if (match) finish(null, match[1]) }
      child.stderr.on('data', data); child.once('error', failed); child.once('exit', failed)
    })
    socket = new WebSocket(address)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(Error('Browser debugging connection failed')), { once: true }) })
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data)
      if (value.id) { const job = pending.get(value.id); if (job) { clearTimeout(job.timer); pending.delete(value.id); value.error ? job.reject(Error('Browser command failed')) : job.resolve(value.result) } }
      else for (const listener of listeners) listener(value)
    })
    socket.addEventListener('close', () => { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(Error('Browser closed')) } pending.clear() })
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error(`Browser command timed out: ${method}`)) }, 20000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    const page = async url => {
      const { targetId } = await call('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
      await call('Page.enable', {}, sessionId)
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(listener); reject(Error('Browser page load timed out')) }, 15000)
        const listener = event => { if (event.sessionId === sessionId && event.method === 'Page.loadEventFired') { clearTimeout(timer); listeners.delete(listener); resolve() } }
        listeners.add(listener)
      })
      await call('Page.navigate', { url }, sessionId); await loaded
      return {
        async evaluate(expression) { const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description ?? 'Browser script failed'); return value.result.value },
        close: () => call('Target.closeTarget', { targetId }),
        call: (method, params) => call(method, params, sessionId),
      }
    }
    return { page, close }
  } catch (error) { await close('SIGKILL'); throw error }
}
