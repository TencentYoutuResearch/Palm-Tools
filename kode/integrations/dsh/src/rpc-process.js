/** Newline JSON-RPC transport shared by native Agent protocols; no shell or work retries. */
import { EventEmitter } from 'node:events'
import { spawnAgent } from './managed-agent-process.js'

export class RpcProcess extends EventEmitter {
  constructor(profile, cwd, { appServerArgs = [], inheritEnvironment = true, gracefulCloseMs = 0 } = {}) {
    super()
    if (!Number.isSafeInteger(gracefulCloseMs) || gracefulCloseMs < 0 || gracefulCloseMs > 5000) throw new Error('Invalid Agent graceful-close deadline')
    this.gracefulCloseMs = gracefulCloseMs
    this.nextId = 1; this.pending = new Map(); this.closed = false; this.buffer = ''; this.stderr = ''
    this.process = spawnAgent(profile.executable, [...(profile.args ?? []), 'app-server', '--listen', 'stdio://', ...appServerArgs], cwd, profile.env, { inheritEnvironment })
    this.child = this.process.child
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk
      if (this.buffer.length > 8 * 1024 * 1024) return this.fail(new Error('Agent protocol frame exceeds 8 MiB'))
      let end
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
        if (!line.trim()) continue
        try { this.receive(JSON.parse(line)) } catch { this.fail(new Error('Agent emitted invalid JSON-RPC')); return }
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192) })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => this.fail(new Error(`Agent process exited (${signal ?? code})`)))
  }
  receive(message) {
    if (!message || typeof message !== 'object') throw new Error('invalid RPC envelope')
    if (message.method) { this.emit(message.id === undefined ? 'notification' : 'request', message); return }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id); pending.cleanup()
    if (message.error) pending.reject(Object.assign(new Error(`Agent RPC ${pending.method}: ${message.error.message ?? 'failed'}`), { rpcCode: message.error.code, rpcRejected: true }))
    else pending.resolve(message.result)
  }
  send(message) {
    if (this.closed || this.closing) throw new Error('Agent process is closed')
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
  notify(method, params) { this.send({ method, params }) }
  respond(id, result) { this.send({ id, result }) }
  request(method, params, { signal, timeoutMs = 30000 } = {}) {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const finish = error => { this.pending.delete(id); cleanup(); reject(error) }
      const abort = () => finish(signal.reason ?? new Error('Agent RPC cancelled'))
      const timer = setTimeout(() => finish(new Error(`Agent RPC timed out: ${method}; outcome may be uncertain`)), timeoutMs)
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
      this.pending.set(id, { resolve, reject, cleanup, method })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.send({ id, method, params }) } catch (error) { finish(error) }
    })
  }
  fail(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error) }
    this.pending.clear(); this.emit('closed', error)
    void this.process.close()
  }
  close() {
    return this.closing ??= (async () => {
      if (this.gracefulCloseMs && !this.closed) {
        let timer, onExit
        try {
          const exited = new Promise(resolve => { onExit = resolve; this.child.once('exit', onExit) })
          this.child.stdin.end()
          await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, this.gracefulCloseMs) })])
        } finally {
          clearTimeout(timer)
          if (onExit) this.child.off('exit', onExit)
        }
      }
      this.fail(new Error('Agent process closed'))
      return this.process.close()
    })()
  }
}
