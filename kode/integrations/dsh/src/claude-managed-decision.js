/** Native Claude inference with declarative Host actions, never native filesystem/shell tools. */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnAgent } from './managed-agent-process.js'
import { prepareClaudeBootstrap, claudeWrapperEndpoint } from './claude-managed-bootstrap.js'
import { isDeepStrictEqual } from 'node:util'
import { ClaudeModelGate, claudeUsage, readBoundedResponse } from './claude-model-gate.js'

export function serializeClaudeInput(messages, tools) {
  const input = JSON.stringify({ messages, tools })
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw Error('Claude input exceeds limit')
  return input
}
export function parseClaudeDecision(text, tools) {
  const result = JSON.parse(text)
  if (!result || Object.keys(result).some(key => !['texts', 'calls'].includes(key))
      || !Array.isArray(result.texts) || result.texts.some(text => typeof text !== 'string')
      || !Array.isArray(result.calls) || result.calls.length > 32) throw Error('Invalid Claude Host decision')
  const names = new Set(tools.map(tool => tool.name))
  const calls = result.calls.map(call => {
    if (!call || Object.keys(call).some(key => !['name', 'arguments'].includes(key)) || !names.has(call.name)
        || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw Error('Unauthorized Claude Host action')
    return { type: 'tool-call', id: randomUUID(), name: call.name, arguments: JSON.stringify(call.arguments) }
  })
  return { calls, texts: result.texts }
}
export class ClaudeManagedDecision {
  constructor({ profile, cwd, stateRoot, model, effort, bootstrap, responseModels, admit, signal, timeoutMs = 300000 }) {
    if (profile?.type !== 'claude' || !bootstrap?.provider || !bootstrap.home || !cwd || !stateRoot || !model
        || profile.args?.length || (effort != null && !profile.managedInference.reasoningEfforts.includes(effort))) throw Error('Managed Claude configuration rejected')
    this.options = { profile, cwd, stateRoot, model, effort, bootstrap, responseModels, admit }
    this.stop = new AbortController(); this.signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
    this.events = []; this.bytes = 0; this.wake = () => { this.waiter?.(); this.waiter = null }
    this.signal.addEventListener('abort', this.wake)
  }
  async prepare(input) {
    if (this.preparing) throw Error('Claude decision already prepared')
    this.preparing = true
    this.preparation = this.prepareOwned(input)
    try { return await this.preparation } catch (error) { await this.close(); throw error }
  }
  async prepareOwned({ messages, tools }) {
    this.signal.throwIfAborted()
    if (!Array.isArray(messages) || !Array.isArray(tools)
        || messages.some(m => !Array.isArray(m.content) || m.content.some(b => !['text', 'tool-call', 'tool-result'].includes(b.type)))
        || tools.some(t => !t?.name || !t.parameters)) throw Error('Claude requires explicit text workflow and Host tool schemas')
    this.tools = tools
    this.input = serializeClaudeInput(messages, tools)
    const { profile, cwd, stateRoot, model, effort, bootstrap, admit } = this.options
    // [1m] is the CLI context-window selector, not a different inference model.
    this.wireModel = model.replace(/\[1m\]$/, '')
    this.responseModel = this.options.responseModels?.[model] ?? this.wireModel
    this.gate = new ClaudeModelGate({ model: this.wireModel, responseModel: this.responseModel, effort, admit, signal: this.signal })
    const base = await this.gate.open()
    this.signal.throwIfAborted()
    await mkdir(stateRoot, { recursive: true, mode: 0o700 }); this.directory = await mkdtemp(join(stateRoot, 'claude-decision-'))
    const instruction = 'Continue the supplied workflow conversation. All tools are Host-owned. Return ONLY a JSON object with keys texts (array of strings) and calls (array of objects with name and arguments). Use only the supplied tools and their schemas. Request the next needed action, never replay completed tools. No markdown fences. Do not invoke native tools. Empty arrays are allowed.'
    const args = ['--print', '--bare', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-chrome',
      '--permission-mode', 'manual', '--permission-prompts', 'none', '--no-session-persistence', '--model', model,
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--system-prompt', instruction,
      ...(effort == null ? [] : ['--effort', effort])]
    const prepared = await prepareClaudeBootstrap(this.directory, bootstrap, args, base)
    this.signal.throwIfAborted()
    this.process = spawnAgent(profile.executable, [], cwd, { PATH: process.env.PATH, LANG: 'en_US.UTF-8', ...profile.env,
      HOME: bootstrap.home, TCLAUDE_SKIP_UPDATE: '1', ...prepared.env }, { inheritEnvironment: false })
    this.rpc = { child: this.process.child }
    let buffer = ''
    this.rpc.child.stdout.setEncoding('utf8')
    this.rpc.child.stdout.on('data', chunk => {
      this.bytes += Buffer.byteLength(chunk)
      if (this.bytes > 8 * 1024 * 1024) { this.error = Error('Claude output exceeds limit'); this.wake(); return }
      buffer += chunk
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try { if (this.events.length >= 4096) throw Error('Claude event limit'); this.events.push(JSON.parse(line)) } catch { this.error = Error('Claude emitted invalid JSON stream') }
      }
      this.wake()
    })
    this.rpc.child.stdin.on('error', () => { this.error ??= Error('Claude input stream closed'); this.wake() })
    this.rpc.child.on('error', () => { this.error ??= Error('Claude process unavailable'); this.wake() })
    this.rpc.child.on('exit', () => { this.exited = true; this.wake() })
    void this.gate.failed.then(error => { this.error ??= error; this.wake() })
    let transport
    for (let attempt = 0; attempt < 300; attempt++) {
      this.signal.throwIfAborted()
      try { transport = JSON.parse(await readFile(prepared.report, 'utf8')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (this.exited || this.error) throw this.error ?? Error('Claude wrapper exited before bootstrap')
      await delay(50, undefined, { signal: this.signal })
    }
    if (!transport) throw Error('Claude wrapper bootstrap timed out')
    this.gate.endpoint = claudeWrapperEndpoint(transport.endpoint)
    const response = await fetch(new URL('/v1/models', this.gate.endpoint), { redirect: 'error', signal: this.signal })
    if (!response.ok) throw Error('Claude model directory unavailable')
    const catalogText = (await readBoundedResponse(response, 1024 * 1024)).toString('utf8')
    this.signal.throwIfAborted()
    const catalog = JSON.parse(catalogText)
    if (!Array.isArray(catalog.data) || !catalog.data.some(row => row.id === model)) throw Error('Exact Claude model is absent from live directory')
    this.configuration = Object.freeze({ model, reasoningEffort: effort ?? null, modelProvider: bootstrap.provider,
      wire_model: this.wireModel, expected_reported_model: this.responseModel, source: 'claude_live_gateway_directory_and_pinned_cli', inference_verified: false })
    return this.configuration
  }
  async next() {
    while (!this.events.length) {
      this.signal.throwIfAborted()
      if (this.error) throw this.error
      if (this.exited) throw Error('Claude process exited before result')
      await new Promise(resolve => { this.waiter = resolve })
    }
    this.signal.throwIfAborted(); if (this.error) throw this.error
    return this.events.shift()
  }
  async execute() {
    if (!this.configuration || this.executed || this.closing) throw Error('Claude decision unavailable')
    this.executed = true
    let decision = { calls: [], texts: [] }, failure, usage = null, terminal = null
    try {
      this.rpc.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: this.input } }) + '\n')
      while (true) {
        const event = await this.next()
        if (event.type !== 'result') continue
        if (event.is_error || event.subtype !== 'success' || typeof event.result !== 'string') throw Error('Claude native decision did not complete')
        if (this.gate.forwarded !== 1 || this.gate.state !== 'completed' || !this.gate.receipt) throw Error('Claude inference bypassed admission')
        terminal = 'completed'; usage = this.gate.receipt.usage
        try {
          if (!isDeepStrictEqual(claudeUsage(event.usage), usage)) throw Error('Claude native and provider usage conflict')
        } catch (error) { this.usageRejected = true; throw error }
        decision = parseClaudeDecision(event.result, this.tools)
        break
      }
    } catch (error) { failure = error }
    const stop = await this.close()
    if (!stop?.leader_exited || !stop.process_group_empty || stop.signal_failures.length) failure ??= Error('Claude process stop is unconfirmed')
    // Known provider usage remains accountable even when a declarative action is invalid.
    usage = this.usageRejected ? null : usage ?? this.gate.receipt?.usage ?? null
    return { ...(failure ? { calls: [], texts: [] } : decision), failure, usage, terminal, stop,
      failure_details: failure?.managedInferenceFailure ?? null, owner_question: null,
      usage_evidence: usage ? { source: 'claude_admitted_provider_response', inference_id: this.gate.id,
        response_id: this.gate.receipt.responseId, requested_model: this.options.model,
        wire_model: this.wireModel, expected_reported_model: this.responseModel,
        reported_model: this.gate.receipt.reportedModel, transport_basis: 'upstream_eof' } : null,
      transport_completion: this.gate.receipt ? 'upstream_eof' : null, configuration: this.configuration }
  }
  close() {
    return this.closing ??= (async () => {
      this.stop.abort(Error('Claude decision closed')); this.signal.removeEventListener('abort', this.wake)
      await this.preparation?.catch(() => {})
      const stopped = await this.process?.close(); await this.gate?.close()
      if (this.directory && (!stopped || stopped.process_group_empty)) await rm(this.directory, { recursive: true, force: true })
      return stopped
    })()
  }
}
