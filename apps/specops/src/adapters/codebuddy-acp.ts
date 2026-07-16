import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { SpecOpsError } from '../core/errors.js'

export interface AcpQuestion {
  id: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multi_select: boolean
}

export interface CodeBuddyInterruption {
  sessionId: string
  toolCallId: string
  toolName: string
  questions: AcpQuestion[]
}

export type CodeBuddyAcpEvent =
  | { type: 'session_update'; sessionId: string; update: Record<string, unknown> }
  | { type: 'interruption'; interruption: CodeBuddyInterruption }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }

type RpcId = number
type RpcMessage = {
  jsonrpc?: string
  id?: RpcId
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface CodeBuddyAcpOptions {
  command?: string
  args?: string[]
  cwd: string
  requestTimeoutMs?: number
  onEvent?: (event: CodeBuddyAcpEvent) => void
  spawnProcess?: () => ChildProcessWithoutNullStreams
}

/**
 * Native CodeBuddy ACP transport. ACP is newline-delimited JSON-RPC over stdio;
 * it must not run through a PTY because terminal echo and line discipline can
 * corrupt frames. One instance owns one CodeBuddy process and multiple ACP
 * sessions within that process.
 */
export class CodeBuddyAcpClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<RpcId, PendingRequest>()
  private readonly requestTimeoutMs: number
  private readonly onEvent: ((event: CodeBuddyAcpEvent) => void) | undefined
  private nextId = 1
  private initialized = false

  constructor(options: CodeBuddyAcpOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.onEvent = options.onEvent
    this.child = options.spawnProcess?.() ?? spawn(
      options.command ?? 'codebuddy',
      options.args ?? ['--acp'],
      { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.receiveLine(line))
    this.child.on('exit', (code, signal) => {
      const error = new SpecOpsError('agent_exited', `CodeBuddy ACP exited before completing pending requests (${code ?? signal ?? 'unknown'})`)
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.reject(error)
      }
      this.pending.clear()
      this.onEvent?.({ type: 'exit', code, signal })
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'kode-specops', title: 'Kode SpecOps', version: '0.1.0' },
    })
    this.initialized = true
  }

  async newSession(cwd: string): Promise<string> {
    await this.initialize()
    const result = await this.request('session/new', { cwd, mcpServers: [] }) as { sessionId?: unknown }
    if (typeof result?.sessionId !== 'string' || result.sessionId === '') {
      throw new SpecOpsError('agent_protocol_error', 'CodeBuddy session/new returned no sessionId')
    }
    return result.sessionId
  }

  async prompt(sessionId: string, text: string): Promise<unknown> {
    return this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  }

  async cancel(sessionId: string): Promise<void> {
    this.notify('session/cancel', { sessionId })
  }

  /** Submit every AskUserQuestion answer atomically to the live interruption. */
  async resolveQuestions(
    interruption: Pick<CodeBuddyInterruption, 'sessionId' | 'toolCallId'>,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    await this.request('_codebuddy.ai/resolveInterruption', {
      sessionId: interruption.sessionId,
      toolCallId: interruption.toolCallId,
      decision: 'allow',
      answers,
    })
  }

  close(): void {
    this.child.kill()
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SpecOpsError('agent_timeout', `CodeBuddy ACP request timed out: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receiveLine(line: string): void {
    let message: RpcMessage
    try { message = JSON.parse(line) as RpcMessage } catch { return }
    if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
      const request = this.pending.get(message.id)
      if (request === undefined) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error !== undefined) request.reject(new SpecOpsError('agent_protocol_error', message.error.message ?? 'CodeBuddy ACP request failed'))
      else request.resolve(message.result)
      return
    }
    if (message.method === 'session/update') this.handleSessionUpdate(message.params ?? {})
  }

  private handleSessionUpdate(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const update = params.update !== null && typeof params.update === 'object'
      ? params.update as Record<string, unknown>
      : {}
    const meta = update._meta !== null && typeof update._meta === 'object'
      ? update._meta as Record<string, unknown>
      : {}
    const raw = meta['codebuddy.ai/interruptionRequest']
    if (raw !== null && typeof raw === 'object') {
      const interruption = parseInterruption(sessionId, raw as Record<string, unknown>)
      if (interruption !== null) this.onEvent?.({ type: 'interruption', interruption })
    }
    this.onEvent?.({ type: 'session_update', sessionId, update })
  }
}

export function parseInterruption(sessionId: string, raw: Record<string, unknown>): CodeBuddyInterruption | null {
  if (sessionId === '' || typeof raw.toolCallId !== 'string' || typeof raw.toolName !== 'string') return null
  const input = raw.toolInput !== null && typeof raw.toolInput === 'object'
    ? raw.toolInput as Record<string, unknown>
    : {}
  const questions = Array.isArray(input.questions) ? input.questions : []
  return {
    sessionId,
    toolCallId: raw.toolCallId,
    toolName: raw.toolName,
    questions: questions.flatMap((value, index): AcpQuestion[] => {
      if (value === null || typeof value !== 'object') return []
      const question = value as Record<string, unknown>
      if (typeof question.question !== 'string') return []
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option): AcpQuestion['options'] => {
          if (option === null || typeof option !== 'object') return []
          const item = option as Record<string, unknown>
          return typeof item.label === 'string'
            ? [{ label: item.label, ...(typeof item.description === 'string' ? { description: item.description } : {}) }]
            : []
        })
        : []
      return [{
        id: typeof question.id === 'string' && question.id !== '' ? question.id : `q_${index}`,
        question: question.question,
        ...(typeof question.header === 'string' ? { header: question.header } : {}),
        options,
        multi_select: question.multiSelect === true || question.multi_select === true,
      }]
    }),
  }
}
