/** Bounded SSE terminal framing. Response content never leaves this observer. */
import { codexProviderUsage, codexUsageBasis } from './codex-provider-usage.js'
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
export class CodexResponseObserver {
  constructor() {
    this.decoder = new TextDecoder('utf-8', { fatal: true })
    this.line = ''
    this.linePresent = false
    this.data = ''
    this.skipLF = false
    this.oversized = false
    this.terminal = null
    this.responseId = null
    this.invalidEvidence = false
    this.responseUsage = null
    this.responseModel = null
    this.ended = false
  }
  push(bytes) {
    if (this.ended) { this.invalidEvidence = true; return }
    let text
    try { text = this.decoder.decode(bytes, { stream: true }) }
    catch { this.invalidEvidence = true; return }
    for (const character of text) {
      if (this.skipLF && character === '\n') { this.skipLF = false; continue }
      this.skipLF = false
      if (character === '\r' || character === '\n') {
        this.consumeLine()
        this.skipLF = character === '\r'
      } else {
        this.linePresent = true
        if (!this.oversized) {
          this.line += character
          if (this.line.length + this.data.length > 8 * 1024 * 1024) {
            this.line = ''
            this.data = ''
            this.oversized = true
            this.invalidEvidence = true
          }
        }
      }
    }
  }
  consumeLine() {
    const line = this.line
    const present = this.linePresent
    this.line = ''
    this.linePresent = false
    if (!present) {
      if (!this.oversized && this.data) {
        try {
          const value = this.data === '[DONE]' && this.terminal ? null : JSON.parse(this.data)
          if (value?.response_id !== undefined) this.identify(value.response_id)
          if (value?.response?.model !== undefined) {
            const model = value.response.model
            if (!validId(model) || (this.responseModel && model !== this.responseModel)) this.invalidEvidence = true
            else this.responseModel = model
          }
          if (['response.created', 'response.in_progress'].includes(value?.type)) this.identify(value.response?.id)
          if (['response.completed', 'response.failed', 'response.incomplete'].includes(value?.type)) {
            if (this.terminal) this.invalidEvidence = true
            this.identify(value.response?.id)
            this.terminal = Object.freeze({ event: value.type,
              status: ['completed', 'failed', 'incomplete'].includes(value.response?.status) ? value.response.status : null })
            this.responseUsage = codexProviderUsage(value.response?.usage)
          }
        } catch { this.invalidEvidence = true /* Malformed frames cannot establish usage. */ }
      }
      this.data = ''
      this.oversized = false
    } else if (!this.oversized && line.startsWith('data:')) {
      this.data += (this.data ? '\n' : '') + line.slice(line[5] === ' ' ? 6 : 5)
    }
  }
  identify(id) {
    if (!validId(id) || (this.responseId && id !== this.responseId)) this.invalidEvidence = true
    else this.responseId = id
  }
  finish() {
    this.ended = true
    try {
      if (this.linePresent || this.data || this.oversized || this.decoder.decode()) this.invalidEvidence = true
    } catch { this.invalidEvidence = true }
  }
  usageEvidence() {
    if (!this.ended || this.invalidEvidence || !this.responseId || !this.responseUsage
        || this.terminal?.event !== 'response.completed' || this.terminal.status !== 'completed') return null
    return Object.freeze({ response_id: this.responseId, codec_basis: codexUsageBasis, usage: this.responseUsage })
  }
}
