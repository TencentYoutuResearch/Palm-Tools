import type { Readable, Writable } from 'node:stream'

import { ExecutionOperationError } from './types.js'

export type JsonRpcId = number | string

export interface JsonRpcStdioChild {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
}

export interface JsonRpcDiagnostic {
  kind: 'malformed_frame' | 'invalid_message' | 'unmatched_response' | 'stream_error' | 'process_exit'
  message: string
  frame?: string
}

export interface JsonRpcExit {
  code: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
}

export interface JsonRpcStdioOptions {
  child: JsonRpcStdioChild
  requestTimeoutMs?: number
  maxFrameBytes?: number
  stderrTailBytes?: number
  maxDiagnostics?: number
  /** Some JSON-RPC-compatible servers (notably Codex app-server) omit the
   * `jsonrpc` member on outbound frames while accepting standard 2.0 input. */
  allowMissingJsonrpc?: boolean
  onNotification?: (method: string, params: unknown) => void | Promise<void>
  onRequest?: (method: string, params: unknown, id: JsonRpcId) => unknown | Promise<unknown>
  onDiagnostic?: (diagnostic: JsonRpcDiagnostic) => void
  onExit?: (exit: JsonRpcExit) => void
}

export interface JsonRpcRequestOptions {
  id?: JsonRpcId
  timeoutMs?: number
  signal?: AbortSignal
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  dispatched: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  removeAbortListener: (() => void) | undefined
}

interface JsonRpcErrorPayload {
  code: number
  message: string
  data?: unknown
}

export class JsonRpcRemoteError extends ExecutionOperationError {
  readonly rpcCode: number
  readonly data: unknown

  constructor(payload: JsonRpcErrorPayload) {
    super('jsonrpc_remote_error', `JSON-RPC ${payload.code}: ${payload.message}`)
    this.name = 'JsonRpcRemoteError'
    this.rpcCode = payload.code
    this.data = payload.data
  }
}

export class JsonRpcTransportError extends ExecutionOperationError {
  constructor(code: string, message: string, options: { outcomeUnknown?: boolean; cause?: unknown } = {}) {
    super(code, message, options)
    this.name = 'JsonRpcTransportError'
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function idKey(id: JsonRpcId): string {
  return typeof id === 'number' ? `number:${id}` : `string:${id}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Newline-delimited JSON-RPC 2.0 over a child process's stdio streams. */
export class JsonRpcStdioTransport {
  private readonly child: JsonRpcStdioChild
  private readonly requestTimeoutMs: number
  private readonly maxFrameBytes: number
  private readonly stderrTailBytes: number
  private readonly maxDiagnostics: number
  private readonly allowMissingJsonrpc: boolean
  private readonly onNotification: JsonRpcStdioOptions['onNotification']
  private readonly onRequest: JsonRpcStdioOptions['onRequest']
  private readonly onDiagnostic: JsonRpcStdioOptions['onDiagnostic']
  private readonly onExit: JsonRpcStdioOptions['onExit']
  private readonly pending = new Map<string, PendingRequest>()
  private readonly diagnosticLog: JsonRpcDiagnostic[] = []
  private readBuffer = Buffer.alloc(0)
  private stderrBuffer = Buffer.alloc(0)
  private nextId = 1
  private writeTail: Promise<void> = Promise.resolve()
  private state: 'open' | 'closing' | 'closed' = 'open'
  private closePromise: Promise<void> | undefined
  private exitReported = false
  private readonly exited: Promise<void>
  private resolveExited!: () => void

  constructor(options: JsonRpcStdioOptions) {
    this.exited = new Promise((resolve) => { this.resolveExited = resolve })
    this.child = options.child
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.maxFrameBytes = options.maxFrameBytes ?? 8 * 1024 * 1024
    this.stderrTailBytes = options.stderrTailBytes ?? 64 * 1024
    this.maxDiagnostics = options.maxDiagnostics ?? 100
    this.allowMissingJsonrpc = options.allowMissingJsonrpc ?? false
    this.onNotification = options.onNotification
    this.onRequest = options.onRequest
    this.onDiagnostic = options.onDiagnostic
    this.onExit = options.onExit

    this.child.stdout.on('data', (chunk: Buffer | string) => this.receiveChunk(chunk))
    this.child.stdout.once('end', () => this.handleEof())
    this.child.stdout.once('error', (error: Error) => {
      this.report({ kind: 'stream_error', message: `JSON-RPC stdout failed: ${error.message}` })
      this.terminate(new JsonRpcTransportError('jsonrpc_stdout_error', `JSON-RPC stdout failed: ${error.message}`, { outcomeUnknown: true, cause: error }))
    })
    this.child.stderr.on('data', (chunk: Buffer | string) => this.captureStderr(chunk))
    this.child.once('error', (error) => {
      this.report({ kind: 'stream_error', message: `JSON-RPC process failed: ${error.message}` })
      this.terminate(new JsonRpcTransportError('jsonrpc_process_error', `JSON-RPC process failed: ${error.message}`, { outcomeUnknown: true, cause: error }))
    })
    this.child.once('exit', (code, signal) => this.handleExit(code, signal))
  }

  get isClosed(): boolean {
    return this.state === 'closed'
  }

  get stderrTail(): string {
    return this.stderrBuffer.toString('utf8')
  }

  get diagnostics(): readonly JsonRpcDiagnostic[] {
    return [...this.diagnosticLog]
  }

  request<T = unknown>(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<T> {
    this.assertOpen()
    if (options.signal?.aborted === true) {
      return Promise.reject(new JsonRpcTransportError('jsonrpc_aborted', `JSON-RPC request aborted: ${method}`))
    }
    const id = options.id ?? this.nextId++
    const key = idKey(id)
    if (this.pending.has(key)) {
      return Promise.reject(new JsonRpcTransportError('jsonrpc_duplicate_id', `JSON-RPC request id is already pending: ${String(id)}`))
    }

    let pending!: PendingRequest
    const result = new Promise<T>((resolve, reject) => {
      pending = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        dispatched: false,
        timer: undefined,
        removeAbortListener: undefined,
      }
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.removePending(key, pending)) return
          reject(new JsonRpcTransportError(
            'jsonrpc_timeout',
            `JSON-RPC request timed out: ${method}`,
            { outcomeUnknown: pending.dispatched },
          ))
        }, timeoutMs)
      }
      if (options.signal !== undefined) {
        const abort = (): void => {
          if (!this.removePending(key, pending)) return
          reject(new JsonRpcTransportError('jsonrpc_aborted', `JSON-RPC request aborted: ${method}`, { outcomeUnknown: pending.dispatched }))
        }
        options.signal.addEventListener('abort', abort, { once: true })
        pending.removeAbortListener = () => options.signal?.removeEventListener('abort', abort)
      }
    })

    this.pending.set(key, pending)
    const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    void this.enqueueMessage(message, () => { pending.dispatched = true }).catch((error: unknown) => {
      if (!this.removePending(key, pending)) return
      pending.reject(error instanceof Error
        ? error
        : new JsonRpcTransportError('jsonrpc_write_error', errorMessage(error), { outcomeUnknown: pending.dispatched, cause: error }))
    })
    return result
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    await this.enqueueMessage(message)
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.enqueueMessage({ jsonrpc: '2.0', id, result })
  }

  async respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    const error: Record<string, unknown> = { code, message }
    if (data !== undefined) error.data = data
    await this.enqueueMessage({ jsonrpc: '2.0', id, error })
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = (async () => {
      if (this.state !== 'closed') {
        this.state = 'closing'
        this.terminate(new JsonRpcTransportError('jsonrpc_closed', 'JSON-RPC transport closed', { outcomeUnknown: true }))
      }
      if (!this.child.stdin.destroyed) this.child.stdin.end()
      try { this.child.kill('SIGTERM') } catch { /* process may already be gone */ }
      await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 500))])
      if (!this.exitReported) {
        try { this.child.kill('SIGKILL') } catch { /* process may already be gone */ }
        await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 250))])
      }
    })()
    return this.closePromise
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new JsonRpcTransportError('jsonrpc_closed', 'JSON-RPC transport is closed')
  }

  private receiveChunk(chunk: Buffer | string): void {
    if (this.state === 'closed') return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.readBuffer = Buffer.concat([this.readBuffer, bytes])
    for (;;) {
      const newline = this.readBuffer.indexOf(0x0a)
      if (newline < 0) break
      let frame = this.readBuffer.subarray(0, newline)
      this.readBuffer = this.readBuffer.subarray(newline + 1)
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1)
      this.dispatchFrame(frame)
    }
    if (this.readBuffer.length > this.maxFrameBytes) {
      this.report({
        kind: 'malformed_frame',
        message: `JSON-RPC frame exceeded ${this.maxFrameBytes} bytes without a newline`,
        frame: this.readBuffer.subarray(0, 512).toString('utf8'),
      })
      this.readBuffer = Buffer.alloc(0)
    }
  }

  private dispatchFrame(frame: Buffer): void {
    if (frame.length === 0) return
    if (frame.length > this.maxFrameBytes) {
      this.report({ kind: 'malformed_frame', message: `JSON-RPC frame exceeded ${this.maxFrameBytes} bytes`, frame: frame.subarray(0, 512).toString('utf8') })
      return
    }
    const text = frame.toString('utf8')
    let decoded: unknown
    try {
      decoded = JSON.parse(text)
    } catch (error) {
      this.report({ kind: 'malformed_frame', message: `Malformed JSON-RPC frame: ${errorMessage(error)}`, frame: text.slice(0, 2_048) })
      return
    }
    if (!isRecord(decoded) || (decoded.jsonrpc !== '2.0'
      && !(this.allowMissingJsonrpc && decoded.jsonrpc === undefined))) {
      this.report({ kind: 'invalid_message', message: 'JSON-RPC message must be an object with jsonrpc="2.0"', frame: text.slice(0, 2_048) })
      return
    }

    if (typeof decoded.method === 'string') {
      const id = decoded.id
      if (id === undefined || id === null) {
        void Promise.resolve(this.onNotification?.(decoded.method, decoded.params)).catch((error: unknown) => {
          this.report({ kind: 'stream_error', message: `JSON-RPC notification handler failed: ${errorMessage(error)}` })
        })
      } else if (isJsonRpcId(id)) {
        void this.handleServerRequest(decoded.method, decoded.params, id)
      } else {
        this.report({ kind: 'invalid_message', message: 'JSON-RPC request id must be a number or string', frame: text.slice(0, 2_048) })
      }
      return
    }

    if (isJsonRpcId(decoded.id) && (hasOwn(decoded, 'result') || hasOwn(decoded, 'error'))) {
      this.completeResponse(decoded.id, decoded)
      return
    }
    this.report({ kind: 'invalid_message', message: 'Unrecognized JSON-RPC message', frame: text.slice(0, 2_048) })
  }

  private async handleServerRequest(method: string, params: unknown, id: JsonRpcId): Promise<void> {
    if (this.onRequest === undefined) {
      await this.respondError(id, -32601, `Method not found: ${method}`).catch(() => undefined)
      return
    }
    try {
      const result = await this.onRequest(method, params, id)
      await this.respond(id, result)
    } catch (error) {
      if (error instanceof JsonRpcRemoteError) {
        await this.respondError(id, error.rpcCode, error.message, error.data).catch(() => undefined)
      } else {
        await this.respondError(id, -32603, errorMessage(error)).catch(() => undefined)
      }
    }
  }

  private completeResponse(id: JsonRpcId, message: Record<string, unknown>): void {
    const key = idKey(id)
    const pending = this.pending.get(key)
    if (pending === undefined) {
      this.report({ kind: 'unmatched_response', message: `No pending JSON-RPC request for id ${String(id)}` })
      return
    }
    this.removePending(key, pending)
    if (hasOwn(message, 'error')) {
      const error = message.error
      if (isRecord(error) && typeof error.code === 'number' && typeof error.message === 'string') {
        const payload: JsonRpcErrorPayload = {
          code: error.code,
          message: error.message,
          ...(hasOwn(error, 'data') ? { data: error.data } : {}),
        }
        pending.reject(new JsonRpcRemoteError(payload))
      } else {
        pending.reject(new JsonRpcTransportError('jsonrpc_invalid_error', `JSON-RPC response for ${pending.method} contained an invalid error object`))
      }
      return
    }
    pending.resolve(message.result)
  }

  private removePending(key: string, pending: PendingRequest): boolean {
    if (this.pending.get(key) !== pending) return false
    this.pending.delete(key)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    return true
  }

  private captureStderr(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.stderrBuffer = Buffer.concat([this.stderrBuffer, bytes])
    if (this.stderrBuffer.length > this.stderrTailBytes) {
      this.stderrBuffer = this.stderrBuffer.subarray(this.stderrBuffer.length - this.stderrTailBytes)
    }
  }

  private handleEof(): void {
    if (this.readBuffer.length > 0) {
      let frame = this.readBuffer
      this.readBuffer = Buffer.alloc(0)
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1)
      this.dispatchFrame(frame)
    }
    this.terminate(new JsonRpcTransportError('jsonrpc_eof', 'JSON-RPC stdout reached EOF', { outcomeUnknown: true }))
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.exitReported) {
      this.exitReported = true
      this.resolveExited()
      this.onExit?.({ code, signal, stderrTail: this.stderrTail })
    }
    const detail = signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`
    this.report({ kind: 'process_exit', message: `JSON-RPC process exited with ${detail}` })
    const suffix = this.stderrTail.trim() === '' ? '' : `; stderr: ${this.stderrTail.trim()}`
    this.terminate(new JsonRpcTransportError('jsonrpc_process_exited', `JSON-RPC process exited with ${detail}${suffix}`, { outcomeUnknown: true }))
  }

  private terminate(error: Error): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    for (const [key, pending] of this.pending) {
      this.removePending(key, pending)
      if (error instanceof ExecutionOperationError) {
        pending.reject(new JsonRpcTransportError(error.code, error.message, {
          outcomeUnknown: pending.dispatched || error.outcomeUnknown,
          cause: error,
        }))
      } else {
        pending.reject(error)
      }
    }
  }

  private enqueueMessage(message: Record<string, unknown>, beforeWrite?: () => void): Promise<void> {
    this.assertOpen()
    const frame = `${JSON.stringify(message)}\n`
    const write = this.writeTail.then(async () => {
      this.assertOpen()
      beforeWrite?.()
      await this.writeFrame(frame)
    })
    this.writeTail = write.catch(() => undefined)
    return write
  }

  private writeFrame(frame: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let writeReturned = false
      let callbackDone = false
      let needsDrain = false
      let drainDone = false
      let settled = false
      const cleanup = (): void => {
        this.child.stdin.off('drain', onDrain)
      }
      const finish = (): void => {
        if (settled || !writeReturned || !callbackDone || (needsDrain && !drainDone)) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new JsonRpcTransportError('jsonrpc_write_error', `JSON-RPC write failed: ${error.message}`, { outcomeUnknown: true, cause: error }))
      }
      const onDrain = (): void => {
        drainDone = true
        finish()
      }
      try {
        const accepted = this.child.stdin.write(frame, (error?: Error | null) => {
          if (error != null) { fail(error); return }
          callbackDone = true
          finish()
        })
        needsDrain = !accepted
        drainDone = accepted
        writeReturned = true
        if (needsDrain) this.child.stdin.once('drain', onDrain)
        finish()
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private report(diagnostic: JsonRpcDiagnostic): void {
    this.diagnosticLog.push(diagnostic)
    if (this.diagnosticLog.length > this.maxDiagnostics) this.diagnosticLog.splice(0, this.diagnosticLog.length - this.maxDiagnostics)
    this.onDiagnostic?.(diagnostic)
  }
}
