/** Exactly one native Messages request per decision. Native tools and retries are prohibited. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
const limit = 8 * 1024 * 1024
export async function readBoundedResponse(response, maximum = limit) {
  let length = 0; const chunks = []
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > maximum) throw Error('Claude response exceeds limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1e12
export function claudeUsage(raw) {
  const read = raw?.cache_read_input_tokens ?? 0, write = raw?.cache_creation_input_tokens ?? 0
  if (![raw?.input_tokens, raw?.output_tokens, read, write].every(count)) throw Error('Invalid Claude usage evidence')
  return { input_tokens: raw.input_tokens + read + write, cached_input_tokens: read, cache_write_input_tokens: write, output_tokens: raw.output_tokens }
}
function modelMismatch(model, reported) {
  const observed = typeof reported === 'string' && reported.length <= 256 && !/[\x00-\x1f\x7f]/.test(reported) ? reported : null
  return Object.assign(Error('Claude response model identity mismatch'), { code: 'managed_cli_model_contract_changed',
    managedInferenceFailure: { reason: 'reported_model_mismatch', expected_reported_model: model, reported_model: observed } })
}
export function parseClaudeResponse(bytes, contentType, model) {
  let message, stop, ended = false
  if (contentType.includes('text/event-stream')) {
    for (const frame of bytes.toString('utf8').split(/\r?\n\r?\n/)) {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      const e = JSON.parse(data)
      if (ended) throw Error('Claude response continued after terminal')
      if (e.type === 'error') throw Error('Claude provider error')
      if (e.type === 'message_start') {
        if (message || !e.message?.id) throw Error('Claude response identity mismatch')
        if (e.message.model !== model) throw modelMismatch(model, e.message.model)
        message = e.message
        if (message.content?.some(b => !['text', 'thinking', 'redacted_thinking'].includes(b.type))) throw Error('Claude returned an unauthorized native tool')
      }
      if (e.type === 'content_block_start' && !['text', 'thinking', 'redacted_thinking'].includes(e.content_block?.type)) throw Error('Claude returned an unauthorized native tool')
      if (e.type === 'content_block_delta' && !['text_delta', 'thinking_delta', 'signature_delta'].includes(e.delta?.type)) throw Error('Claude returned an unsupported content delta')
      if (e.type === 'message_delta') { if (!message) throw Error('Claude usage before identity'); message.usage = { ...message.usage, ...e.usage }; stop = e.delta?.stop_reason ?? stop }
      if (e.type === 'message_stop') { if (!message || ended) throw Error('Invalid Claude terminal'); ended = true }
    }
  } else {
    message = JSON.parse(bytes); stop = message.stop_reason; ended = true
    if (message.content?.some(b => !['text', 'thinking', 'redacted_thinking'].includes(b.type))) throw Error('Claude returned an unauthorized native tool')
  }
  if (message?.model !== model) throw modelMismatch(model, message?.model)
  if (!ended || !message?.id || stop !== 'end_turn') throw Error('Claude response is incomplete or model changed')
  return { usage: claudeUsage(message.usage), responseId: message.id, reportedModel: message.model }
}
export class ClaudeModelGate {
  constructor({ model, responseModel = model, effort, admit, signal }) {
    this.model = model; this.responseModel = responseModel; this.effort = effort; this.admit = admit
    this.stop = new AbortController(); this.signal = AbortSignal.any([this.stop.signal, signal])
    this.id = randomUUID(); this.path = `/kode-claude/${this.id}`; this.state = 'ready'; this.forwarded = 0
    this.failed = new Promise(resolve => { this.resolveFailure = resolve })
    this.settled = new Promise(resolve => { this.resolveSettled = resolve })
    this.server = createServer((req, res) => { void this.receive(req, res) })
  }
  open() {
    this.signal.throwIfAborted()
    if (this.closing) throw Error('Claude inference gate closed')
    return this.opening ??= new Promise((resolve, reject) => {
      const cleanup = () => { this.server.off('error', failed); this.signal.removeEventListener('abort', aborted) }
      const failed = () => { cleanup(); reject(Error('Claude inference listener unavailable')) }
      const aborted = () => { cleanup(); reject(this.signal.reason) }
      this.server.once('error', failed)
      this.signal.addEventListener('abort', aborted, { once: true })
      this.server.listen({ port: 0, host: '127.0.0.1', signal: this.signal }, () => {
        cleanup()
        if (this.signal.aborted) { reject(this.signal.reason); return }
        resolve(`http://127.0.0.1:${this.server.address().port}${this.path}`)
      })
    })
  }
  fail(error) { this.failure ??= error; this.state = 'failed'; this.resolveFailure(this.failure); this.resolveSettled(); return this.failure }
  async receive(req, res) {
    try {
      this.signal.throwIfAborted()
      if (req.method !== 'POST' || req.url.split('?')[0] !== `${this.path}/v1/messages` || !this.endpoint || this.state !== 'ready') throw Error('Claude inference route or single-request contract rejected')
      this.state = 'admitting'
      let length = 0; const chunks = []
      for await (const chunk of req) { length += chunk.length; if (length > limit) throw Error('Claude request too large'); chunks.push(chunk) }
      const body = Buffer.concat(chunks), input = JSON.parse(body)
      if (input.model !== this.model || (input.tools != null && (!Array.isArray(input.tools) || input.tools.length !== 0)) || input.tool_choice != null
          || (this.effort != null && input.output_config?.effort !== this.effort)) throw Error('Claude model, effort or native tool contract changed')
      await this.admit(this.signal); this.signal.throwIfAborted()
      if (this.state !== 'admitting') throw Error('Claude admission lost')
      this.state = 'forwarded'; this.forwarded++
      const headers = {}
      for (const [key, value] of Object.entries(req.headers)) if (['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type', 'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-claude-code-prompt-id', 'x-tclaude-workspace'].includes(key)) headers[key] = value
      const upstream = await fetch(new URL('/v1/messages', this.endpoint), { method: 'POST', body, headers, redirect: 'manual', signal: this.signal })
      if (!upstream.ok) { await upstream.body?.cancel(); throw Error(`Claude provider HTTP ${upstream.status}`) }
      const bytes = await readBoundedResponse(upstream)
      this.signal.throwIfAborted()
      if (this.state !== 'forwarded') throw this.failure ?? Error('Claude inference fenced')
      const type = upstream.headers.get('content-type') ?? ''
      this.receipt = parseClaudeResponse(bytes, type, this.responseModel)
      this.state = 'completed'; this.resolveSettled()
      res.writeHead(200, { 'content-type': type }); res.end(bytes)
    } catch (error) {
      if (error.managedInferenceFailure) error.managedInferenceFailure = { ...error.managedInferenceFailure, wire_model: this.model }
      this.fail(error); if (!res.headersSent) res.writeHead(502); res.end('Managed Claude inference rejected') }
  }
  close() { return this.closing ??= (async () => { this.stop.abort(); this.resolveSettled(); this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)) })() }
}
