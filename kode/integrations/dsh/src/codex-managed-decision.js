/** A fresh native decision yields Host tool requests only after its CLI process has stopped. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { RpcProcess } from './rpc-process.js'
import { CodexModelGate } from './codex-model-gate.js'
import { usageCounters } from './native-usage.js'
import { observeCodexOutputDrain } from './codex-output-drain.js'
import { workerQuestions } from './worker-questions.js'
import { isDeepStrictEqual } from 'node:util'
import { prepareManagedBootstrap, readManagedBootstrapReport } from './codex-managed-bootstrap.js'

const defaultProvider = 'kode_workflow'
const permissions = 'kode_workflow'
const workflowInstructions = 'The turn input is a JSON array of the existing workflow conversation. '
  + 'Continue after its final message. Tool-role messages are completed Host tool results. '
  + 'Use those results as context and request only the next needed action. Do not replay completed calls.'
const disabledFeatures = ['multi_agent', 'plugins', 'hooks', 'apps', 'shell_tool', 'code_mode',
  'browser_use', 'computer_use', 'tool_suggest', 'skill_mcp_dependency_install', 'remote_plugin',
  'view_image', 'image_generation', 'sleep_tool', 'goals']

export class CodexManagedDecision {
  constructor({ profile, cwd, stateRoot, endpoint, model, effort, apiKeyVariable, bootstrap, admit, signal, timeoutMs = 300000, allowUserInput = true }) {
    if (!(profile?.type === 'codex' || profile?.protocol === 'codex') || !cwd || !stateRoot
        || (apiKeyVariable != null && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyVariable))
        || (apiKeyVariable && bootstrap?.pathVariable === apiKeyVariable)
        || (bootstrap?.provider && (endpoint != null || apiKeyVariable != null))
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) throw new Error('Managed Codex decision configuration rejected')
    if (typeof allowUserInput !== 'boolean') throw new Error('Managed Codex question policy required')
    this.allowUserInput = allowUserInput
    this.options = { profile, cwd, stateRoot, endpoint, model, effort, apiKeyVariable, bootstrap, admit }
    this.stop = new AbortController()
    this.signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
    this.events = []
    this.eventBytes = 0
    this.wake = () => { this.waiter?.(); this.waiter = undefined }
    this.signal.addEventListener('abort', this.wake, { once: true })
  }
  push(event) {
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (this.events.length >= 4096 || this.eventBytes + bytes > 8 * 1024 * 1024) {
      this.error ??= new Error('Managed Codex notification limit exceeded')
    } else {
      this.events.push({ event, bytes })
      this.eventBytes += bytes
    }
    this.wake()
  }
  async prepare(input) {
    if (this.preparing) throw new Error('Managed Codex decision already prepared')
    this.preparing = true
    this.preparation = this.prepareOwned(input)
    try { return await this.preparation } catch (error) { await this.close(); throw error }
  }
  async prepareOwned({ messages, tools }) {
    this.signal.throwIfAborted()
    const { profile, cwd, stateRoot, endpoint, model, effort, apiKeyVariable, bootstrap, admit } = this.options
    if (!Array.isArray(messages) || !Array.isArray(tools)
        || messages.some(message => !Array.isArray(message.content)
          || message.content.some(block => !['text', 'tool-call', 'tool-result'].includes(block.type)))
        || tools.some(tool => !tool?.name || !tool.parameters)) throw new Error('Managed Codex requires text workflow input and explicit tool schemas')
    const input = JSON.stringify(messages.filter(message => message.role !== 'system'))
    const systems = messages.filter(message => message.role === 'system')
    if (systems.some(message => message.content.some(block => block.type !== 'text'))
        || Buffer.byteLength(input) > 2 * 1024 * 1024) throw new Error('Managed Codex input rejected')
    this.input = input
    this.tools = new Set(tools.map(tool => tool.name))
    const provider = bootstrap?.provider ?? defaultProvider
    this.gate = new CodexModelGate({ endpoint, deferredEndpoint: Boolean(bootstrap?.provider), model, effort, tools: [...this.tools], admit, signal: this.signal, allowUserInput: this.allowUserInput })
    const base = await this.gate.open()
    this.signal.throwIfAborted()
    await mkdir(stateRoot, { recursive: true, mode: 0o700 })
    this.directory = await mkdtemp(join(stateRoot, 'codex-decision-'))
    const providerSettings = bootstrap?.provider ? [
      `model_providers.${provider}.base_url=${JSON.stringify(base)}`, `model_providers.${provider}.wire_api="responses"`,
      `model_providers.${provider}.supports_websockets=false`, `model_providers.${provider}.request_max_retries=0`,
      `model_providers.${provider}.stream_max_retries=0`,
    ] : [`model_providers.${provider}={name="Kode managed",base_url=${JSON.stringify(base)},wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0${apiKeyVariable ? `,env_key=${JSON.stringify(apiKeyVariable)}` : ''}}`]
    const settings = [`model_provider=${JSON.stringify(provider)}`, `model=${JSON.stringify(model)}`, ...providerSettings,
      'mcp_servers={}', 'web_search="disabled"', 'project_doc_max_bytes=0', 'check_for_update_on_startup=false',
      `projects={${JSON.stringify(cwd)}={trust_level="untrusted"}}`,
      `default_permissions=${JSON.stringify(permissions)}`,
      `permissions.${permissions}.filesystem={":minimal"="read"}`,
      `permissions.${permissions}.network.enabled=false`,
      ...disabledFeatures.map(name => `features.${name}=false`),
      ...(effort == null ? [] : [`model_reasoning_effort=${JSON.stringify(effort)}`])]
    const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', ...profile.env,
      HOME: this.directory, CODEX_HOME: join(this.directory, 'codex'), XDG_CONFIG_HOME: join(this.directory, 'config') }
    await Promise.all([mkdir(env.CODEX_HOME, { mode: 0o700 }), mkdir(env.XDG_CONFIG_HOME, { mode: 0o700 })])
    const preparedBootstrap = bootstrap ? await prepareManagedBootstrap(this.directory, bootstrap, settings) : null
    Object.assign(env, preparedBootstrap?.env)
    if (bootstrap?.home) env.HOME = bootstrap.home
    this.signal.throwIfAborted()
    this.rpc = new RpcProcess({ ...profile, env }, cwd, {
      inheritEnvironment: false, gracefulCloseMs: 2000, appServerArgs: ['--strict-config', ...settings.flatMap(value => ['-c', value])],
    })
    this.rpc.on('notification', event => this.push(event))
    this.rpc.on('request', event => this.push(event))
    this.rpc.on('closed', () => {
      if (!this.closing) this.error ??= new Error('Managed Codex process ended unexpectedly')
      this.wake()
    })
    void this.gate.failed.then(error => { this.error ??= error; this.wake() })
    await this.rpc.request('initialize', { clientInfo: { name: 'kode-managed-decision', version: '1' },
      capabilities: { experimentalApi: true } }, { signal: this.signal })
    this.rpc.notify('initialized', {})
    const bootstrapState = preparedBootstrap ? await readManagedBootstrapReport(preparedBootstrap.reportPath, bootstrap?.provider) : null
    if (bootstrap?.provider) this.gate.configureEndpoint(bootstrapState.endpoint)
    const metadata = await this.rpc.request('thread/start', { cwd, model, modelProvider: provider,
      permissions, approvalPolicy: 'never', baseInstructions: systems.flatMap(message => message.content.map(block => block.text)).join('\n'),
      developerInstructions: workflowInstructions,
      dynamicTools: tools.map(tool => ({ name: tool.name,
        description: tool.description ?? '', inputSchema: tool.parameters })) }, { signal: this.signal })
    this.threadId = metadata.thread.id
    if (metadata.model !== model || metadata.modelProvider !== provider || metadata.cwd !== cwd
        || (effort != null && metadata.reasoningEffort !== effort) || metadata.activePermissionProfile?.id !== permissions) {
      throw new Error('Managed Codex effective configuration mismatch')
    }
    this.gate.effort = metadata.reasoningEffort ?? undefined
    this.gate.bindThread(this.threadId)
    this.configuration = Object.freeze({ model, reasoningEffort: metadata.reasoningEffort ?? null,
      ...(bootstrapState ? { bootstrap: bootstrapState.configuration } : {}),
      modelProvider: provider, native_thread_id: this.threadId, source: 'codex_thread_start_metadata', inference_verified: false })
    return this.configuration
  }
  async next() {
    this.signal.throwIfAborted()
    if (this.error) throw this.error
    if (!this.events.length) await new Promise(resolve => { this.waiter = resolve })
    this.signal.throwIfAborted()
    if (this.error) throw this.error
    const item = this.events.shift()
    if (!item) return
    this.eventBytes -= item.bytes
    return item.event
  }
  async execute() {
    if (!this.configuration || this.executed || this.closing) throw new Error('Managed Codex decision unavailable')
    this.executed = true
    const calls = [], texts = []
    let failure, usage, terminal, usageEvidence, nativeUsageObserved = false, nativeUsageInvalid = false
    let outputDrainUnconfirmed = false, usageEvidenceRejected = false
    const collectUsage = event => {
      if (event.method !== 'thread/tokenUsage/updated' || event.params?.threadId !== this.threadId
          || (event.params.turnId && event.params.turnId !== this.turnId)) return
      nativeUsageObserved = true
      usage = usageCounters(event.params.tokenUsage?.total)
      nativeUsageInvalid ||= !usage || !Number.isSafeInteger(usage.cache_write_input_tokens)
        || usage.cache_write_input_tokens < 0 || usage.cache_write_input_tokens > 1_000_000_000_000
        || usage.cached_input_tokens + usage.cache_write_input_tokens > usage.input_tokens
    }
    try {
      const { model, reasoningEffort } = this.configuration
      const started = await this.rpc.request('turn/start', { threadId: this.threadId,
        input: [{ type: 'text', text: this.input }], permissions, approvalPolicy: 'never', model,
        collaborationMode: { mode: this.allowUserInput ? 'plan' : 'default', settings: { model, reasoning_effort: reasoningEffort, developer_instructions: workflowInstructions } },
      }, { signal: this.signal })
      this.turnId = started.turn.id
      this.gate.sealTurn(this.threadId, this.turnId)
      let interrupting, textBytes = 0
      while (!terminal) {
        const event = await this.next()
        if (!event) continue
        const { method, params = {} } = event
        if (params.threadId !== this.threadId || (params.turnId && params.turnId !== this.turnId)) continue
        collectUsage(event)
        if (method === 'model/rerouted') throw new Error('Managed Codex model rerouted')
        if (event.id !== undefined) {
          if (method === 'item/tool/requestUserInput' && this.allowUserInput) {
            this.ownerQuestion = workerQuestions(params.questions)
            failure = Object.assign(new Error('Managed Worker requires owner information'), { code: 'worker_clarification_required' })
          } else if (method === 'item/tool/call' && this.tools.has(params.tool)
              && typeof params.callId === 'string' && !calls.some(call => call.id === params.callId)) {
            if (calls.length >= 32) throw new Error('Managed Codex tool request limit exceeded')
            calls.push({ type: 'tool-call', id: params.callId, name: params.tool, arguments: JSON.stringify(params.arguments) })
          } else throw new Error('Managed Codex requested an unsupported operation')
          // A dynamic tool can arrive before the provider finishes its usage trailer.
          // Drain that admitted response before interrupting the native tool wait.
          await this.gate.settled
          this.signal.throwIfAborted()
          if (this.gate.failure) throw this.gate.failure
          interrupting ??= this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, { timeoutMs: 5000 })
          void interrupting.catch(error => { this.error ??= error; this.wake() })
        }
        if (method === 'item/completed' && params.item?.type === 'agentMessage') {
          textBytes += Buffer.byteLength(params.item.text ?? '')
          if (textBytes > 1024 * 1024) throw new Error('Managed Codex output limit exceeded')
          texts.push(params.item.text ?? '')
        }
        if (method === 'turn/completed' && params.turn?.id === this.turnId) terminal = params.turn.status
      }
      if (interrupting) await interrupting
      if (this.gate.forwarded !== 1) throw this.gate.failure ?? new Error('Managed Codex inference bypassed admission')
      await this.gate.settled
      this.signal.throwIfAborted()
      if (this.gate.failure) throw this.gate.failure
      if (terminal !== (calls.length || this.ownerQuestion ? 'interrupted' : 'completed')) throw new Error('Managed Codex decision did not complete')
    } catch (error) { failure = error }
    finally {
      // Preserve an already received usage notification when a simultaneous gate failure woke next().
      const collectQueuedUsage = () => {
        for (const { event } of this.events) {
          collectUsage(event)
        }
      }
      const outputDrain = observeCodexOutputDrain(this.rpc?.child?.stdout)
      try {
        collectQueuedUsage()
        this.stopEvidence = await this.close()
        const drained = await outputDrain.wait()
        if (drained.drained) collectQueuedUsage()
        else {
          outputDrainUnconfirmed = true
          usage = null
          const cause = failure
          failure = Object.assign(new Error('Managed Codex output drain is unconfirmed', cause ? { cause } : undefined), {
            code: 'managed_cli_output_drain_unconfirmed',
          })
        }
      } finally { outputDrain.dispose() }
    }
    if (!this.stopEvidence?.leader_exited || !this.stopEvidence.process_group_empty || this.stopEvidence.signal_failures.length) {
      failure ??= new Error('Managed Codex process stop is unconfirmed')
    }
    if (!outputDrainUnconfirmed) {
      const provider = this.gate.usageReceipt(this.threadId, this.turnId)
      if (nativeUsageInvalid || (nativeUsageObserved && usage && provider && !isDeepStrictEqual(usage, provider.usage))) {
        usageEvidenceRejected = true
        usage = null
        const cause = failure
        failure = Object.assign(new Error('Managed Codex usage evidence is invalid or conflicting', cause ? { cause } : undefined), {
          code: nativeUsageInvalid ? 'managed_cli_native_usage_invalid' : 'managed_cli_usage_evidence_conflict',
        })
      } else if (nativeUsageObserved && usage) {
        usageEvidence = Object.freeze({ source: 'codex_thread_token_usage', inference_id: this.gate.inferenceId,
          native_thread_id: this.threadId, native_turn_id: this.turnId })
      } else if (!nativeUsageObserved && provider && (!failure || failure.code === 'worker_clarification_required')
          && terminal === (calls.length || this.ownerQuestion ? 'interrupted' : 'completed')) {
        usage = provider.usage
        const { usage: _counters, ...evidence } = provider
        usageEvidence = Object.freeze(evidence)
      }
    }
    if (failure && this.gate.failureDetails) failure.managedInferenceFailure = this.gate.failureDetails
    return { calls: failure ? [] : calls, texts: failure ? [] : texts, usage, usage_evidence: usageEvidence ?? null, terminal,
      transport_completion: this.gate.completionBasis ?? null,
      failure, failure_details: this.gate.failureDetails ?? null,
      configuration: this.configuration, stop: this.stopEvidence,
      owner_question: outputDrainUnconfirmed || usageEvidenceRejected ? null : this.ownerQuestion ?? null }
  }
  close() {
    return this.closing ??= (async () => {
      this.stop.abort(new Error('Managed Codex decision closed'))
      await this.preparation?.catch(() => {})
      const stopped = await this.rpc?.close()
      await this.gate?.close()
      this.signal.removeEventListener('abort', this.wake)
      if (this.directory && (!stopped || stopped.process_group_empty)) await rm(this.directory, { recursive: true, force: true })
      return stopped
    })()
  }
}
