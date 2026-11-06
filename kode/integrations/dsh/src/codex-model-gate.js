/** One inference request per managed CLI decision. Never retry an uncertain dispatch. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { CodexResponseObserver } from './codex-response-observer.js'
import { drainCodexResponse } from './codex-response-drain.js'

const maxBodyBytes = 8 * 1024 * 1024
const transportCodes = new Set(['ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'])

function headersForForwarding(headers) {
  const connection = headers.get('connection')?.toLowerCase().split(',').map(name => name.trim()) ?? []
  return Object.fromEntries([...headers].filter(([name]) => !hopHeaders.has(name) && !connection.includes(name)))
}

export class CodexModelGate {
  constructor({ endpoint, deferredEndpoint = false, model, effort, tools, admit, signal, allowUserInput = true }) {
    let target
    try { target = endpoint == null && deferredEndpoint ? null : new URL(endpoint) } catch { throw new Error('Managed CLI inference endpoint rejected') }
    if (target && ((target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname)))
        || target.username || target.password || target.search || target.hash)) throw new Error('Managed CLI requires an exact HTTPS or loopback inference endpoint')
    if (typeof model !== 'string' || !model || !Array.isArray(tools)
        || tools.some(name => typeof name !== 'string' || !name) || typeof admit !== 'function'
        || (effort != null && (typeof effort !== 'string' || !effort))) throw new Error('Managed CLI inference contract required')
    this.endpoint = target
    this.model = model
    this.effort = effort
    if (typeof allowUserInput !== 'boolean') throw new Error('Managed CLI question policy required')
    this.allowUserInput = allowUserInput
    this.tools = new Set(allowUserInput ? [...tools, 'request_user_input'] : tools)
    this.admit = admit
    this.stop = new AbortController()
    this.signal = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal
    this.path = `/kode-model/${randomUUID()}/responses`
    this.inferenceId = randomUUID()
    this.state = 'ready'
    this.forwarded = 0
    this.failed = new Promise(resolve => { this.resolveFailure = resolve })
    this.settled = new Promise(resolve => { this.resolveSettled = resolve })
    this.signal.addEventListener('abort', () => this.resolveSettled(), { once: true })
    this.server = createServer((request, response) => { void this.receive(request, response) })
  }
  bindThread(threadId) {
    if (this.threadId || typeof threadId !== 'string' || !threadId || this.state !== 'ready') throw new Error('Managed CLI inference thread binding rejected')
    this.threadId = threadId
  }
  sealTurn(threadId, turnId) {
    if (!this.threadId || threadId !== this.threadId || this.turnId || typeof turnId !== 'string' || !turnId) throw new Error('Managed CLI inference turn binding rejected')
    this.turnId = turnId
  }
  usageReceipt(threadId, turnId) {
    if (threadId !== this.threadId || turnId !== this.turnId || !threadId || !turnId
        || this.forwarded !== 1 || this.failure || this.state !== 'completed'
        || !['upstream_eof', 'upstream_eof_with_peer_close'].includes(this.completionBasis) || !this.providerUsage) return null
    return Object.freeze({ source: 'codex_admitted_provider_response', inference_id: this.inferenceId,
      native_thread_id: threadId, native_turn_id: turnId, requested_model: this.model,
      reported_model: this.providerReportedModel ?? null, model_basis: 'requested_model_unverified',
      transport_basis: this.completionBasis, ...this.providerUsage })
  }
  configureEndpoint(endpoint) {
    this.signal.throwIfAborted()
    const target = new URL(endpoint)
    if (this.endpoint || this.state !== 'ready' || this.closing || target.protocol !== 'http:'
        || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.search || target.hash) {
      throw new Error('Managed wrapper transport route rejected')
    }
    this.endpoint = target
  }
  async open() {
    if (this.closing) throw new Error('Managed CLI inference gate closed')
    this.signal.throwIfAborted()
    if (this.opening) return this.opening
    this.opening = new Promise((resolve, reject) => {
      const failed = () => { cleanup(); reject(new Error('Managed CLI inference listener unavailable')) }
      const aborted = () => { cleanup(); reject(this.signal.reason) }
      const cleanup = () => { this.server.off('error', failed); this.signal.removeEventListener('abort', aborted) }
      this.server.once('error', failed)
      this.signal.addEventListener('abort', aborted, { once: true })
      this.server.listen({ port: 0, host: '127.0.0.1', signal: this.signal }, () => {
        cleanup()
        if (this.signal.aborted) { reject(this.signal.reason); return }
        const address = this.server.address()
        resolve(`http://127.0.0.1:${address.port}${this.path.slice(0, -'/responses'.length)}`)
      })
    })
    return this.opening
  }
  fail(reason, code = 'managed_cli_inference_failed') {
    if (!this.failure) {
      this.failure = new Error(reason)
      this.failure.code = code
      this.resolveFailure(this.failure)
    }
    this.state = 'failed'
    this.resolveSettled()
    return this.failure
  }
  async receive(request, response) {
    let phase = 'request_validation', upstreamStatus = null
    let streamFailureSide = null, upstreamComplete = false, peerClosed = false
    let observer
    try {
      this.signal.throwIfAborted()
      if (request.method !== 'POST' || request.url !== this.path) throw this.fail('Managed CLI inference route rejected')
      if (!this.endpoint) throw this.fail('Managed CLI inference transport unavailable')
      // Reserve before any await, including reading the request body or owner admission.
      if (this.state !== 'ready') throw this.fail('Managed CLI attempted another inference request')
      this.state = 'admitting'
      let length = 0
      const chunks = []
      for await (const chunk of request) {
        length += chunk.length
        if (length > maxBodyBytes) throw this.fail('Managed CLI inference body exceeds limit')
        chunks.push(chunk)
      }
      let bytes = Buffer.concat(chunks)
      let body
      try { body = JSON.parse(bytes) } catch { throw this.fail('Managed CLI inference body rejected') }
      if (!body || body.model !== this.model) {
        throw this.fail('Managed CLI inference model contract changed', 'managed_cli_model_contract_changed')
      }
      if (this.effort != null && body.reasoning?.effort !== this.effort) {
        throw this.fail('Managed CLI inference reasoning effort contract changed', 'managed_cli_effort_contract_changed')
      }
      // The installed engine advertises this builtin even in default mode. Roles
      // with their own question tools must not expose it to the inference peer.
      if (!this.allowUserInput && Array.isArray(body.tools)) {
        body.tools = body.tools.filter(tool => !(tool?.type === 'function' && tool.name === 'request_user_input'))
        bytes = Buffer.from(JSON.stringify(body))
      }
      if (!Array.isArray(body.tools) || body.tools.some(tool => tool?.type !== 'function' || !this.tools.has(tool.name))) {
        throw this.fail('Managed CLI inference tool contract changed', 'managed_cli_tool_contract_changed')
      }
      phase = 'admission'
      await this.admit(this.signal)
      this.signal.throwIfAborted()
      // Concurrent/invalid requests fence a pending first admission too.
      if (this.state !== 'admitting') throw this.failure ?? new Error('Managed CLI inference admission lost')
      this.state = 'forwarded'
      this.forwarded++
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else if (value !== undefined) headers.set(name, value)
      }
      // Authentication passes through opaquely. It is never included in state or errors.
      phase = 'upstream_connect'
      const upstream = await fetch(this.endpoint, { method: 'POST', headers: headersForForwarding(headers),
        body: bytes, redirect: 'manual', signal: this.signal })
      upstreamStatus = upstream.status
      phase = 'response_stream'
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel()
        throw this.fail('Managed CLI inference redirect rejected')
      }
      const outputHeaders = headersForForwarding(upstream.headers)
      // Node fetch decodes compressed bodies before exposing its ReadableStream.
      delete outputHeaders['content-encoding']
      response.writeHead(upstream.status, outputHeaders)
      if (upstream.body) {
        if (upstream.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream') {
          observer = new CodexResponseObserver()
        }
        const drained = await drainCodexResponse(upstream.body, response, { observer,
          signal: this.signal, successful: upstreamStatus === 200 })
        upstreamComplete = drained.upstream_eof
        peerClosed = drained.peer_closed
      }
      else response.end()
      if (!this.failure) {
        this.state = 'completed'
        this.completionBasis = peerClosed ? 'upstream_eof_with_peer_close' : 'upstream_eof'
        if (upstreamStatus === 200) {
          // A provider label is an observation, not proof of actual model identity.
          // The admitted request remains bound to the owner's requested-model policy.
          this.providerUsage = observer?.usageEvidence()
          this.providerReportedModel = observer?.responseModel ?? null
        }
      }
      this.resolveSettled()
    } catch (cause) {
      const code = cause?.code ?? cause?.cause?.code
      streamFailureSide ??= cause?.stream_failure_side ?? null
      upstreamComplete ||= cause?.upstream_complete === true
      this.failureDetails ??= Object.freeze({ phase, upstream_status: upstreamStatus,
        transport_code: transportCodes.has(code) ? code : null,
        stream_failure_side: streamFailureSide, upstream_complete: upstreamComplete,
        downstream_complete: response.writableFinished,
        response_terminal: observer?.terminal ?? null,
        cancelled: this.signal.aborted })
      const drainFailure = ['managed_cli_upstream_drain_timeout', 'managed_cli_upstream_drain_limit', 'managed_cli_upstream_tail_invalid'].includes(code)
      const error = this.failure ?? this.fail(this.signal.aborted ? 'Managed CLI inference cancelled' : 'Managed CLI inference dispatch failed',
        drainFailure ? code : 'managed_cli_inference_failed')
      if (!response.headersSent && !response.destroyed) {
        response.writeHead(409, { 'content-type': 'application/json', connection: 'close' })
        response.end(JSON.stringify({ error: { message: error.message, type: 'managed_cli_inference_rejected' } }))
      } else response.destroy()
    }
  }
  close() {
    return this.closing ??= (async () => {
      this.stop.abort(new Error('Managed CLI inference gate closed'))
      if (this.opening) await this.opening.catch(() => {})
      if (!this.server.listening) return
      await new Promise((resolve, reject) => {
        this.server.close(error => error ? reject(error) : resolve())
        this.server.closeAllConnections()
      })
    })()
  }
}
