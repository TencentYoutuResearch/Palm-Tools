import { spawn } from 'node:child_process'

import {
  JsonRpcRemoteError,
  JsonRpcStdioTransport,
  type JsonRpcId,
  type JsonRpcStdioChild,
} from '../execution/jsonrpc-stdio.js'
import {
  ExecutionOperationError,
  type AgentExecutionTransport,
  type ExecutionCancelInput,
  type ExecutionCapability,
  type ExecutionLoadInput,
  type ExecutionPromptInput,
  type ExecutionQuestion,
  type ExecutionResponse,
  type ExecutionSession,
  type ExecutionSetModeInput,
  type ExecutionStartInput,
  type ExecutionTurnResult,
  type TransportEventListener,
  type TransportExecutionEvent,
} from '../execution/types.js'
import type { DiscoveredModel } from '../domain/model-discovery.js'

export interface CodexAppServerTransportOptions {
  cwd: string
  command?: string
  args?: readonly string[]
  requestTimeoutMs?: number
  spawnProcess?: () => JsonRpcStdioChild
}

type PendingInteraction =
  | {
      kind: 'permission'
      requestId: string
      rpcId: JsonRpcId
      method: string
      params: Record<string, unknown>
      resolve: (result: unknown) => void
      reject: (error: Error) => void
    }
  | {
      kind: 'questions'
      requestId: string
      rpcId: JsonRpcId
      method: string
      params: Record<string, unknown>
      questions: readonly ExecutionQuestion[]
      resolve: (result: unknown) => void
      reject: (error: Error) => void
    }

interface TurnWaiter {
  resolve: (result: ExecutionTurnResult) => void
  reject: (error: Error) => void
}

interface ModeParameters {
  update: Readonly<Record<string, unknown>>
}

export const CODEX_APP_SERVER_CAPABILITIES = [
  'session.create',
  'session.resume',
  'session.prompt',
  'session.interrupt',
  'conversation.permission',
  'conversation.ask',
  'session.mode',
  'events.tools',
  'output.structured',
  'model.select',
] as const satisfies readonly ExecutionCapability[]

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
])

/** One structured Codex app-server process and one thread per transport instance. */
export class CodexAppServerTransport implements AgentExecutionTransport {
  private readonly rpc: JsonRpcStdioTransport
  private readonly listeners = new Set<TransportEventListener>()
  private readonly pendingInteractions = new Map<string, PendingInteraction>()
  private readonly turnWaiters = new Map<string, TurnWaiter>()
  private readonly completedTurns = new Map<string, ExecutionTurnResult | Error>()
  private initializePromise: Promise<Record<string, unknown>> | undefined
  private initialized: Record<string, unknown> | undefined
  private threadId: string | undefined
  private activeTurnId: string | undefined
  private currentModel: string | undefined
  private currentMode: string | undefined
  private state: 'open' | 'closing' | 'closed' = 'open'
  private closePromise: Promise<void> | undefined

  constructor(options: CodexAppServerTransportOptions) {
    const child = options.spawnProcess?.() ?? spawn(
      options.command ?? 'codex',
      [...(options.args ?? ['app-server', '--stdio'])],
      { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.rpc = new JsonRpcStdioTransport({
      child: child as JsonRpcStdioChild,
      allowMissingJsonrpc: true,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params, id) => this.handleServerRequest(method, params, id),
      onExit: ({ code, signal, stderrTail }) => {
        this.state = 'closed'
        this.failPending(new ExecutionOperationError(
          'codex_process_exited',
          `Codex app-server exited (${code ?? signal ?? 'unknown'})`,
          { outcomeUnknown: true },
        ))
        this.emit({
          type: 'process_exited',
          code,
          signal,
          ...(stderrTail === '' ? {} : { stderrTail }),
        })
      },
    })
  }

  async probe() {
    const initialized = await this.ensureInitialized()
    const protocolVersion = firstString(initialized.protocolVersion, initialized.protocol_version)
    return {
      transport: 'codex-app-server',
      capabilities: CODEX_APP_SERVER_CAPABILITIES,
      ...(protocolVersion === undefined ? {} : { version: protocolVersion }),
      metadata: {
        protocol: 'jsonrpc-stdio',
        modes: ['default', 'plan', 'acceptEdits', 'full-auto', 'bypassPermissions'],
      },
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    await this.ensureInitialized()
    const models: DiscoveredModel[] = []
    let cursor: string | undefined
    do {
      const params: Record<string, unknown> = { includeHidden: false }
      if (cursor !== undefined) params.cursor = cursor
      const result = recordResult(await this.rpc.request('model/list', params), 'model/list')
      const data = Array.isArray(result.data) ? result.data : []
      for (const value of data) {
        if (!isRecord(value)) continue
        const id = firstString(value.model, value.id)
        if (id === undefined) continue
        models.push({
          id,
          label: firstString(value.displayName, value.name) ?? id,
          ...(typeof value.description === 'string' && value.description !== '' ? { description: value.description } : {}),
          is_default: value.isDefault === true,
        })
      }
      cursor = firstString(result.nextCursor)
    } while (cursor !== undefined)
    return models
  }

  async start(input: ExecutionStartInput): Promise<ExecutionSession> {
    await this.ensureInitialized()
    this.assertNoThread()
    const params: Record<string, unknown> = {
      cwd: input.cwd,
      experimentalRawEvents: false,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.mode === undefined ? {} : threadModeParameters(input.mode)),
    }
    const result = recordResult(await this.rpc.request('thread/start', params), 'thread/start')
    return this.acceptThread(result, input.mode)
  }

  async load(input: ExecutionLoadInput): Promise<ExecutionSession> {
    await this.ensureInitialized()
    this.assertNoThread()
    const params: Record<string, unknown> = {
      threadId: input.nativeSessionId,
      cwd: input.cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.mode === undefined ? {} : threadModeParameters(input.mode)),
    }
    const result = recordResult(await this.rpc.request('thread/resume', params), 'thread/resume')
    return this.acceptThread(result, input.mode)
  }

  async prompt(input: ExecutionPromptInput): Promise<ExecutionTurnResult> {
    await this.ensureInitialized()
    const threadId = this.requireThread()
    if (this.activeTurnId !== undefined) {
      throw new ExecutionOperationError('codex_turn_active', `Codex turn ${this.activeTurnId} is still active`)
    }
    const result = recordResult(await this.rpc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: input.text, text_elements: [] }],
      clientUserMessageId: input.requestId,
    }), 'turn/start')
    const turn = recordResult(result.turn, 'turn/start turn')
    const turnId = requiredString(turn.id, 'turn/start turn.id')
    this.activeTurnId = turnId

    const completed = this.completedTurns.get(turnId)
    if (completed !== undefined) {
      this.completedTurns.delete(turnId)
      if (this.activeTurnId === turnId) this.activeTurnId = undefined
      if (completed instanceof Error) throw completed
      return completed
    }
    return new Promise<ExecutionTurnResult>((resolve, reject) => {
      this.turnWaiters.set(turnId, { resolve, reject })
    })
  }

  async cancel(_input: ExecutionCancelInput): Promise<void> {
    await this.ensureInitialized()
    const threadId = this.requireThread()
    const turnId = this.activeTurnId
    if (turnId === undefined) return
    await this.rpc.request('turn/interrupt', { threadId, turnId })
  }

  async respond(input: ExecutionResponse): Promise<void> {
    if (input.kind === 'plan') {
      throw new ExecutionOperationError('capability_not_supported', 'Codex app-server does not expose plan approval responses')
    }
    const pending = this.pendingInteractions.get(input.requestId)
    if (pending === undefined) {
      throw new ExecutionOperationError('codex_unknown_request', `Unknown Codex request: ${input.requestId}`)
    }
    if (pending.kind !== input.kind) {
      throw new ExecutionOperationError(
        'codex_response_kind_mismatch',
        `Codex request ${input.requestId} expects ${pending.kind}, not ${input.kind}`,
      )
    }
    this.pendingInteractions.delete(input.requestId)

    if (input.kind === 'questions') {
      if (pending.kind !== 'questions') {
        throw new ExecutionOperationError('codex_response_kind_mismatch', `Codex request ${input.requestId} is not a question request`)
      }
      const answers: Record<string, { answers: string[] }> = {}
      for (const question of pending.questions) {
        const value = input.answers[question.id]
        if (typeof value === 'string') answers[question.id] = { answers: [value] }
        else if (Array.isArray(value)) answers[question.id] = { answers: [...value] }
      }
      pending.resolve({ answers })
      return
    }

    if (pending.method === 'item/permissions/requestApproval') {
      const permissions = input.decision === 'allow' && isRecord(pending.params.permissions)
        ? pending.params.permissions
        : {}
      pending.resolve({
        permissions,
        ...(input.decision === 'allow' ? { scope: input.remember === true ? 'session' : 'turn' } : {}),
      })
      return
    }

    const canRemember = Array.isArray(pending.params.availableDecisions)
      && pending.params.availableDecisions.includes('acceptForSession')
    pending.resolve({
      decision: input.decision === 'allow'
        ? input.remember === true && canRemember ? 'acceptForSession' : 'accept'
        : 'decline',
    })
  }

  async setMode(input: ExecutionSetModeInput): Promise<void> {
    await this.ensureInitialized()
    await this.applyMode(input.mode)
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.state = 'closing'
    this.failPending(new ExecutionOperationError('codex_transport_closed', 'Codex app-server transport is closed'))
    this.closePromise = this.rpc.close().finally(() => { this.state = 'closed' })
    return this.closePromise
  }

  events(listener: TransportEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private ensureInitialized(): Promise<Record<string, unknown>> {
    this.assertOpen()
    if (this.initialized !== undefined) return Promise.resolve(this.initialized)
    if (this.initializePromise !== undefined) return this.initializePromise
    const initializing = this.rpc.request('initialize', {
      clientInfo: { name: 'kode-specops', title: 'Kode SpecOps', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }).then(async (value) => {
      const result = recordResult(value, 'initialize')
      await this.rpc.notify('initialized')
      this.initialized = result
      return result
    })
    this.initializePromise = initializing
    void initializing.catch(() => {
      if (this.initializePromise === initializing) this.initializePromise = undefined
    })
    return initializing
  }

  private async acceptThread(result: Record<string, unknown>, mode: string | undefined): Promise<ExecutionSession> {
    const thread = recordResult(result.thread, 'Codex thread')
    const threadId = requiredString(thread.id, 'Codex thread.id')
    this.threadId = threadId
    this.currentModel = firstString(result.model)
    if (mode !== undefined) await this.applyMode(mode)

    const session: ExecutionSession = { nativeSessionId: threadId, metadata: result }
    if (this.currentModel !== undefined) session.model = this.currentModel
    if (this.currentMode !== undefined) session.mode = this.currentMode
    this.emit({ type: 'status', status: 'thread_ready', detail: threadId })
    return session
  }

  private async applyMode(mode: string): Promise<void> {
    const threadId = this.requireThread()
    const parameters = modeParameters(mode, this.currentModel)
    await this.rpc.request('thread/settings/update', { threadId, ...parameters.update })
    this.currentMode = mode
  }

  private handleNotification(method: string, value: unknown): void {
    const params = isRecord(value) ? value : {}
    switch (method) {
      case 'thread/started': {
        const thread = isRecord(params.thread) ? params.thread : params
        const id = firstString(thread.id, params.threadId)
        this.emit({ type: 'status', status: 'thread_started', ...(id === undefined ? {} : { detail: id }) })
        return
      }
      case 'thread/status/changed': {
        const status = isRecord(params.status) ? firstString(params.status.type) : firstString(params.status)
        if (status !== undefined) this.emit({ type: 'status', status })
        return
      }
      case 'turn/started': {
        const turn = isRecord(params.turn) ? params.turn : {}
        const turnId = firstString(turn.id, params.turnId)
        if (turnId !== undefined) this.activeTurnId = turnId
        this.emit({ type: 'status', status: 'turn_started', ...(turnId === undefined ? {} : { detail: turnId }) })
        return
      }
      case 'turn/completed':
        this.handleTurnCompleted(params)
        return
      case 'item/agentMessage/delta':
        this.emitTextDelta(params, false)
        return
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        this.emitTextDelta(params, true)
        return
      case 'item/plan/delta': {
        const requestId = firstString(params.itemId, params.turnId)
        const delta = firstString(params.delta)
        if (requestId !== undefined && delta !== undefined) {
          this.emit({ type: 'message_delta', messageId: `plan:${requestId}`, delta, role: 'assistant' })
        }
        return
      }
      case 'turn/plan/updated':
        this.emitTurnPlan(params)
        return
      case 'item/started':
        if (isRecord(params.item)) this.handleItemStarted(params.item)
        return
      case 'item/completed':
        if (isRecord(params.item)) this.handleItemCompleted(params.item)
        return
      case 'item/fileChange/patchUpdated': {
        const id = firstString(params.itemId)
        if (id !== undefined) this.emit({ type: 'tool_call', toolCallId: id, name: 'Patch', input: params.changes, status: 'inProgress' })
        return
      }
      case 'item/mcpToolCall/progress': {
        const id = firstString(params.itemId)
        if (id !== undefined) this.emit({ type: 'tool_call', toolCallId: id, name: 'MCP', input: params.message, status: 'inProgress' })
        return
      }
      case 'error':
      case 'warning': {
        const detail = firstString(params.message, params.summary)
        if (detail !== undefined) this.emit({ type: 'status', status: method, detail })
        return
      }
      default:
        return
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = isRecord(params.turn) ? params.turn : {}
    const turnId = firstString(turn.id, params.turnId)
    if (turnId === undefined) return
    const status = firstString(turn.status) ?? 'completed'
    if (this.activeTurnId === turnId) this.activeTurnId = undefined

    if (status === 'failed') {
      const errorValue = isRecord(turn.error) ? turn.error : {}
      const message = firstString(errorValue.message, errorValue.additionalDetails) ?? 'Codex turn failed'
      const error = new ExecutionOperationError('codex_turn_failed', message)
      this.emit({ type: 'turn_failed', turnId, error: message })
      this.settleTurn(turnId, error)
      return
    }
    const result: ExecutionTurnResult = { turnId, stopReason: status }
    this.emit({ type: 'turn_completed', turnId, stopReason: status })
    this.settleTurn(turnId, result)
  }

  private settleTurn(turnId: string, outcome: ExecutionTurnResult | Error): void {
    const waiter = this.turnWaiters.get(turnId)
    if (waiter === undefined) {
      this.completedTurns.set(turnId, outcome)
      return
    }
    this.turnWaiters.delete(turnId)
    if (outcome instanceof Error) waiter.reject(outcome)
    else waiter.resolve(outcome)
  }

  private emitTextDelta(params: Record<string, unknown>, reasoning: boolean): void {
    const itemId = firstString(params.itemId)
    const delta = firstString(params.delta)
    if (itemId === undefined || delta === undefined) return
    this.emit({
      type: 'message_delta',
      messageId: reasoning ? `reasoning:${itemId}` : itemId,
      delta,
      role: 'assistant',
    })
  }

  private emitTurnPlan(params: Record<string, unknown>): void {
    const requestId = firstString(params.turnId)
    if (requestId === undefined || !Array.isArray(params.plan)) return
    const steps = params.plan.flatMap((value): string[] => {
      if (!isRecord(value) || typeof value.step !== 'string') return []
      const checked = value.status === 'completed' ? 'x' : ' '
      return [`- [${checked}] ${value.step}`]
    })
    const explanation = firstString(params.explanation)
    const markdown = [...(explanation === undefined ? [] : [explanation]), ...steps].join('\n')
    this.emit({ type: 'message_upsert', messageId: `plan:${requestId}`, text: markdown, role: 'assistant' })
  }

  private handleItemStarted(item: Record<string, unknown>): void {
    const id = firstString(item.id)
    const type = firstString(item.type)
    if (id === undefined || type === undefined) return
    const tool = toolDescriptor(item)
    if (tool !== undefined) {
      this.emit({ type: 'tool_call', toolCallId: id, name: tool.name, input: tool.input, status: firstString(item.status) ?? 'inProgress' })
    }
  }

  private handleItemCompleted(item: Record<string, unknown>): void {
    const id = firstString(item.id)
    const type = firstString(item.type)
    if (id === undefined || type === undefined) return
    if (type === 'agentMessage' && typeof item.text === 'string') {
      this.emit({ type: 'message_upsert', messageId: id, text: item.text, role: 'assistant' })
      return
    }
    if (type === 'reasoning') {
      const text = stringList(item.summary).join('\n') || stringList(item.content).join('\n')
      if (text !== '') this.emit({ type: 'message_upsert', messageId: `reasoning:${id}`, text, role: 'assistant' })
      return
    }
    if (type === 'plan' && typeof item.text === 'string') {
      this.emit({ type: 'message_upsert', messageId: `plan:${id}`, text: item.text, role: 'assistant' })
      return
    }
    const tool = toolDescriptor(item)
    if (tool === undefined) return
    const status = firstString(item.status)
    this.emit({
      type: 'tool_result',
      toolCallId: id,
      output: toolOutput(type, item),
      isError: toolFailed(status, item),
    })
  }

  private handleServerRequest(method: string, value: unknown, id: JsonRpcId): Promise<unknown> {
    const params = isRecord(value) ? value : {}
    if (APPROVAL_METHODS.has(method)) return this.waitForPermission(method, params, id)
    if (method === 'item/tool/requestUserInput') return this.waitForQuestions(method, params, id)
    if (method === 'item/tool/call') {
      return Promise.resolve({
        success: false,
        contentItems: [{ type: 'inputText', text: 'tool not available on this client' }],
      })
    }
    throw new JsonRpcRemoteError({ code: -32601, message: `Method not found: ${method}` })
  }

  private waitForPermission(method: string, params: Record<string, unknown>, rpcId: JsonRpcId): Promise<unknown> {
    const requestId = this.reserveRequestId(rpcId)
    return new Promise((resolve, reject) => {
      const pending: PendingInteraction = { kind: 'permission', requestId, rpcId, method, params, resolve, reject }
      this.pendingInteractions.set(requestId, pending)
      const title = method === 'item/commandExecution/requestApproval'
        ? 'Run command'
        : method === 'item/fileChange/requestApproval' ? 'Apply file changes' : 'Grant permissions'
      const description = permissionDescription(method, params)
      const options = permissionOptions(method, params)
      this.emit({
        type: 'permission',
        requestId,
        title,
        ...(description === undefined ? {} : { description }),
        options,
      })
    })
  }

  private waitForQuestions(method: string, params: Record<string, unknown>, rpcId: JsonRpcId): Promise<unknown> {
    const requestId = this.reserveRequestId(rpcId)
    const questions = Array.isArray(params.questions)
      ? params.questions.flatMap(parseQuestion)
      : []
    if (questions.length === 0) return Promise.resolve({ answers: {} })
    return new Promise((resolve, reject) => {
      const pending: PendingInteraction = { kind: 'questions', requestId, rpcId, method, params, questions, resolve, reject }
      this.pendingInteractions.set(requestId, pending)
      this.emit({ type: 'questions', requestId, questions })
    })
  }

  private reserveRequestId(rpcId: JsonRpcId): string {
    const requestId = String(rpcId)
    if (this.pendingInteractions.has(requestId)) {
      throw new JsonRpcRemoteError({ code: -32600, message: `Duplicate request id: ${requestId}` })
    }
    return requestId
  }

  private failPending(error: Error): void {
    for (const pending of this.pendingInteractions.values()) pending.reject(error)
    this.pendingInteractions.clear()
    for (const waiter of this.turnWaiters.values()) waiter.reject(error)
    this.turnWaiters.clear()
    this.completedTurns.clear()
  }

  private assertNoThread(): void {
    if (this.threadId !== undefined) throw new ExecutionOperationError('codex_thread_exists', 'Codex transport already owns a thread')
  }

  private requireThread(): string {
    if (this.threadId === undefined) throw new ExecutionOperationError('codex_thread_missing', 'Codex thread has not been started or resumed')
    return this.threadId
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new ExecutionOperationError('codex_transport_closed', 'Codex app-server transport is closed')
  }

  private emit(event: TransportExecutionEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* observers must not break protocol handling */ }
    }
  }
}

function threadModeParameters(mode: string): Readonly<Record<string, unknown>> {
  switch (mode) {
    case 'default':
    case 'plan':
      return {}
    case 'acceptEdits':
    case 'auto-edit':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    case 'full-auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    case 'bypass':
    case 'bypassPermissions':
    case 'yolo':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    default:
      throw new ExecutionOperationError('codex_mode_unsupported', `Unsupported Codex mode: ${mode}`)
  }
}

function modeParameters(mode: string, model: string | undefined): ModeParameters {
  switch (mode) {
    case 'default':
    case 'plan':
      if (model === undefined || model === '') {
        throw new ExecutionOperationError('codex_mode_requires_model', `Codex ${mode} mode requires a selected model`)
      }
      return {
        update: {
          collaborationMode: {
            mode,
            settings: { model, reasoning_effort: null, developer_instructions: null },
          },
        },
      }
    case 'acceptEdits':
    case 'auto-edit':
      return { update: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } } }
    case 'full-auto':
      return { update: { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } } }
    case 'bypass':
    case 'bypassPermissions':
    case 'yolo':
      return { update: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } }
    default:
      throw new ExecutionOperationError('codex_mode_unsupported', `Unsupported Codex mode: ${mode}`)
  }
}

function toolDescriptor(item: Record<string, unknown>): { name: string; input: unknown } | undefined {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'Bash', input: { command: item.command, cwd: item.cwd } }
    case 'fileChange':
      return { name: 'Patch', input: item.changes }
    case 'mcpToolCall': {
      const server = firstString(item.server) ?? 'mcp'
      const tool = firstString(item.tool) ?? 'tool'
      return { name: `${server}:${tool}`, input: item.arguments }
    }
    case 'dynamicToolCall':
      return { name: firstString(item.tool) ?? 'tool', input: item.arguments }
    case 'webSearch':
      return { name: 'WebSearch', input: item.query }
    default:
      return undefined
  }
}

function toolOutput(type: string, item: Record<string, unknown>): unknown {
  switch (type) {
    case 'commandExecution':
      return { output: item.aggregatedOutput, exitCode: item.exitCode, status: item.status }
    case 'fileChange':
      return item.changes
    case 'mcpToolCall':
      return item.error ?? item.result
    case 'dynamicToolCall':
      return item.contentItems
    case 'webSearch':
      return item.query
    default:
      return undefined
  }
}

function toolFailed(status: string | undefined, item: Record<string, unknown>): boolean {
  if (typeof item.exitCode === 'number') return item.exitCode !== 0
  return status === 'failed' || status === 'declined' || item.success === false || item.error != null
}

function permissionDescription(method: string, params: Record<string, unknown>): string | undefined {
  const reason = firstString(params.reason)
  if (method === 'item/commandExecution/requestApproval') {
    const command = firstString(params.command)
    const cwd = firstString(params.cwd)
    const detail = [command, cwd === undefined ? undefined : `(in ${cwd})`, reason].filter((value): value is string => value !== undefined)
    return detail.length === 0 ? undefined : detail.join('\n')
  }
  if (method === 'item/fileChange/requestApproval') return reason ?? 'Codex wants to modify files'
  if (method === 'item/permissions/requestApproval') {
    return reason ?? JSON.stringify(params.permissions ?? {})
  }
  return reason
}

function permissionOptions(method: string, params: Record<string, unknown>): readonly string[] {
  if (method !== 'item/commandExecution/requestApproval' || !Array.isArray(params.availableDecisions)) {
    return ['allow', 'deny']
  }
  const options = params.availableDecisions.flatMap((value): string[] => typeof value === 'string' ? [value] : [])
  return options.length === 0 ? ['allow', 'deny'] : options
}

function parseQuestion(value: unknown, index: number): ExecutionQuestion[] {
  if (!isRecord(value) || typeof value.question !== 'string') return []
  const id = firstString(value.id) ?? `q_${index}`
  const options = Array.isArray(value.options)
    ? value.options.flatMap((option): Array<{ label: string; description?: string }> => {
        if (!isRecord(option) || typeof option.label !== 'string') return []
        return [{
          label: option.label,
          ...(typeof option.description === 'string' && option.description !== '' ? { description: option.description } : {}),
        }]
      })
    : []
  return [{
    id,
    prompt: value.question,
    ...(typeof value.header === 'string' && value.header !== '' ? { header: value.header } : {}),
    options,
    multiSelect: false,
  }]
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): string[] => {
    if (typeof entry === 'string') return entry === '' ? [] : [entry]
    if (isRecord(entry) && typeof entry.text === 'string' && entry.text !== '') return [entry.text]
    return []
  })
}

function recordResult(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ExecutionOperationError('codex_protocol_error', `${label} returned an invalid object`)
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ExecutionOperationError('codex_protocol_error', `${label} is missing`)
  }
  return value
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
