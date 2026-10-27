/** Newline JSON-RPC transport shared by native Agent protocols; no shell or work retries. */
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { HOST_ONLY_ENV } from './agent-profiles.js'

export class RpcProcess extends EventEmitter {
  constructor(profile, cwd) {
    super()
    this.nextId = 1; this.pending = new Map(); this.closed = false; this.buffer = ''; this.stderr = ''
    const env = { ...process.env, ...profile.env }
    for (const name of HOST_ONLY_ENV) delete env[name]
    this.child = spawn(profile.executable, [...(profile.args ?? []), 'app-server', '--listen', 'stdio://'], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    })
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
    if (message.error) pending.reject(new Error(`Agent RPC ${pending.method}: ${message.error.message ?? 'failed'}`))
    else pending.resolve(message.result)
  }
  send(message) {
    if (this.closed) throw new Error('Agent process is closed')
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
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
  }
  async close() {
    if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = once(this.child, 'exit').catch(() => {})
    this.fail(new Error('Agent process closed'))
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000)
    try { await exited } finally { clearTimeout(timer) }
  }
}
