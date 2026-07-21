import { describe, expect, test, vi } from 'vitest'

import type {
  CodeBuddyAcpEvent,
  CodeBuddyAcpOptions,
  CodeBuddyInterruption,
  CodeBuddyInterruptionResolution,
} from '../src/adapters/codebuddy-acp.js'
import { missingWorkflowCapabilities } from '../src/execution/capabilities.js'
import {
  UNSUPPORTED_EXECUTION_BACKEND,
  createAgentExecutionTransport,
  createAgentExecutionTransportFactory,
  executionTransportCapabilities,
  type CodeBuddyAcpClientLike,
} from '../src/execution/transports.js'
import type {
  AgentExecutionTransport,
  ExecutionCancelInput,
  ExecutionLoadInput,
  ExecutionProcessContext,
  ExecutionPromptInput,
  ExecutionResponse,
  ExecutionSetModeInput,
  ExecutionStartInput,
  ExecutionTurnResult,
  TransportEventListener,
  TransportExecutionEvent,
} from '../src/execution/types.js'

const CONTEXT: ExecutionProcessContext = {
  executionId: 'execution-1',
  processGeneration: 1,
  backendKey: 'codebuddy',
  cwd: '/workspace',
}

class FakeCodeBuddyClient implements CodeBuddyAcpClientLike {
  readonly capabilities = { loadSession: true }
  readonly stderr = ''
  readonly prompts: Array<{ sessionId: string; text: string }> = []
  readonly cancellations: Array<{ sessionId: string; waitForPrompt: boolean | undefined }> = []
  readonly modes: Array<{ sessionId: string; mode: string }> = []
  readonly resolutions: Array<{ interruption: CodeBuddyInterruption; resolution: CodeBuddyInterruptionResolution }> = []
  closeCount = 0

  constructor(private readonly onEvent: ((event: CodeBuddyAcpEvent) => void) | undefined) {}

  async initialize() {
    return { protocolVersion: 1, agentCapabilities: this.capabilities }
  }

  async newSession(_cwd: string): Promise<string> { return 'session-new' }
  async loadSession(sessionId: string, _cwd: string): Promise<string> { return sessionId }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    this.prompts.push({ sessionId, text })
    return { stopReason: 'end_turn' }
  }

  async cancel(sessionId: string, waitForPrompt?: boolean): Promise<void> {
    this.cancellations.push({ sessionId, waitForPrompt })
  }

  async setMode(sessionId: string, mode: string): Promise<void> {
    this.modes.push({ sessionId, mode })
  }

  currentMode(_sessionId: string): string | undefined { return undefined }

  async resolveInterruption(
    interruption: CodeBuddyInterruption,
    resolution: CodeBuddyInterruptionResolution,
  ): Promise<void> {
    this.resolutions.push({ interruption, resolution })
  }

  async close(): Promise<void> { this.closeCount += 1 }

  emit(event: CodeBuddyAcpEvent): void { this.onEvent?.(event) }
}

class FakeTransport implements AgentExecutionTransport {
  readonly starts: ExecutionStartInput[] = []
  readonly loads: ExecutionLoadInput[] = []

  constructor(private readonly probeImpl: () => Promise<{ transport: string; capabilities: readonly [] }> = async () => ({
    transport: 'fake',
    capabilities: [],
  })) {}

  probe() { return this.probeImpl() }
  async start(input: ExecutionStartInput) { this.starts.push(input); return { nativeSessionId: 'fake' } }
  async load(input: ExecutionLoadInput) { this.loads.push(input); return { nativeSessionId: input.nativeSessionId } }
  async prompt(_input: ExecutionPromptInput): Promise<ExecutionTurnResult> { return {} }
  async cancel(_input: ExecutionCancelInput): Promise<void> {}
  async respond(_input: ExecutionResponse): Promise<void> {}
  async setMode(_input: ExecutionSetModeInput): Promise<void> {}
  async close(): Promise<void> {}
  events(_listener: TransportEventListener): () => void { return () => undefined }
}

function codeBuddyFixture(profile: { model?: string; mode?: string } = {}): {
  transport: AgentExecutionTransport
  client: FakeCodeBuddyClient
  events: TransportExecutionEvent[]
  options: CodeBuddyAcpOptions
} {
  let client: FakeCodeBuddyClient | undefined
  let capturedOptions: CodeBuddyAcpOptions | undefined
  const transport = createAgentExecutionTransport(CONTEXT, {
    command: 'codebuddy-fixture',
    extraArgs: ['--fixture'],
    ...profile,
  }, {
    createCodeBuddyClient: (options) => {
      capturedOptions = options
      client = new FakeCodeBuddyClient(options.onEvent)
      return client
    },
  })
  const events: TransportExecutionEvent[] = []
  transport.events((event) => events.push(event))
  if (client === undefined || capturedOptions === undefined) throw new Error('CodeBuddy client was not created')
  return { transport, client, events, options: capturedOptions }
}

function interruptionBase(sessionId: string, toolCallId: string, toolName: string) {
  return { sessionId, toolCallId, toolName, raw: {}, metadata: {} }
}

describe('execution transport factory', () => {
  test('selects native transports, applies profile argv/defaults, and never falls back to PTY', async () => {
    const codebuddy = codeBuddyFixture({ model: 'default-model', mode: 'plan' })
    expect(codebuddy.options).toMatchObject({
      cwd: '/workspace',
      command: 'codebuddy-fixture',
      args: ['--acp', '--fixture', '--permission-mode', 'bypassPermissions', '--model', 'default-model'],
    })
    await expect(codebuddy.transport.probe()).resolves.toMatchObject({
      transport: 'codebuddy-acp',
      capabilities: expect.arrayContaining(['session.create', 'session.resume', 'conversation.permission']),
    })
    await expect(codebuddy.transport.start({ ...CONTEXT })).resolves.toMatchObject({
      nativeSessionId: 'session-new', model: 'default-model', mode: 'plan',
    })
    expect(codebuddy.client.modes).toEqual([{ sessionId: 'session-new', mode: 'plan' }])

    const codex = new FakeTransport()
    const claude = new FakeTransport()
    const codexFactory = vi.fn(() => codex)
    const claudeFactory = vi.fn(() => claude)
    const factory = createAgentExecutionTransportFactory({
      profiles: {
        codex: { command: 'codex-fixture', extraArgs: ['--experimental'] },
        claude: { command: 'claude-fixture', args: ['--custom'] },
      },
      createCodexTransport: codexFactory,
      createClaudeTransport: claudeFactory,
    })
    expect(await factory({ ...CONTEXT, backendKey: 'codex' })).toBe(codex)
    expect(await factory({ ...CONTEXT, backendKey: 'claude' })).toBe(claude)
    expect(codexFactory).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace', command: 'codex-fixture', args: ['app-server', '--stdio', '--experimental'],
    }))
    expect(claudeFactory).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude-fixture', args: ['--custom'] }))

    expect(() => createAgentExecutionTransport({ ...CONTEXT, backendKey: 'unknown' })).toThrow(expect.objectContaining({
      code: UNSUPPORTED_EXECUTION_BACKEND,
      message: 'Unsupported execution backend: unknown',
    }))
    await codebuddy.transport.close()
  })

  test('derives workflow gates from declared and registered transport capabilities', () => {
    const declared = ['conversation.ask', 'conversation.plan']
    expect(missingWorkflowCapabilities('clarify', declared, executionTransportCapabilities('codebuddy'))).toEqual([])
    expect(missingWorkflowCapabilities('pre_plan', declared, executionTransportCapabilities('claude'))).toEqual([])
    expect(missingWorkflowCapabilities('clarify', declared, executionTransportCapabilities('codex'))).toEqual([])
    expect(missingWorkflowCapabilities('clarify', declared, executionTransportCapabilities('unknown'))).toEqual([
      'conversation.ask',
    ])
  })

  test('gates claude-internal explicitly when its Claude-compatible probe fails', async () => {
    const unavailable = new FakeTransport(async () => { throw new Error('missing stream-json flags') })
    const transport = createAgentExecutionTransport(
      { ...CONTEXT, backendKey: 'claude-internal' },
      {},
      { createClaudeTransport: () => unavailable },
    )
    await expect(transport.probe()).rejects.toMatchObject({
      code: 'claude_internal_transport_unavailable',
      message: expect.stringContaining('Backend claude-internal'),
    })
  })
})

describe('CodeBuddy ACP transport normalization', () => {
  test('turns a generic failed AskUserQuestion call into prompt-backed questions', async () => {
    const { transport, client, events } = codeBuddyFixture()
    await transport.start({ ...CONTEXT })
    client.emit({
      type: 'session_update', sessionId: 'session-new',
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'failed-ask', title: 'tool', status: 'pending',
        rawInput: { questions: JSON.stringify([{
          question: 'Framework?',
          options: [{ label: 'Svelte' }, { label: 'React' }],
        }]) },
      },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'questions', requestId: 'failed-ask', responseMode: 'prompt',
      questions: [expect.objectContaining({ prompt: 'Framework?' })],
    }))
    await vi.waitFor(() => expect(client.cancellations).toEqual([
      { sessionId: 'session-new', waitForPrompt: false },
    ]))
    await transport.close()
  })

  test('starts a new assistant message segment after a tool boundary', async () => {
    const { transport, client, events } = codeBuddyFixture()
    await transport.start({ ...CONTEXT })

    const turn = transport.prompt({ requestId: 'turn-segments', text: 'inspect it' })
    client.emit({
      type: 'session_update',
      sessionId: 'session-new',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Before tool.' } },
    })
    client.emit({
      type: 'session_update',
      sessionId: 'session-new',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', status: 'pending' },
    })
    client.emit({
      type: 'session_update',
      sessionId: 'session-new',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'After tool.' } },
    })

    const messages = events.filter((event) => event.type === 'message_delta')
    expect(messages).toEqual([
      expect.objectContaining({ messageId: 'assistant:turn-segments:segment:1', delta: 'Before tool.' }),
      expect.objectContaining({ messageId: 'assistant:turn-segments:segment:2', delta: 'After tool.' }),
    ])
    await turn
    await transport.close()
  })

  test('normalizes session updates, interruptions, responses, cancellation, completion, and exit', async () => {
    const { transport, client, events } = codeBuddyFixture()
    await transport.start({ ...CONTEXT })

    client.emit({
      type: 'session_update',
      sessionId: 'session-new',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
    })
    client.emit({
      type: 'session_update',
      sessionId: 'session-new',
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', rawInput: { file_path: 'a.ts' }, status: 'pending' },
    })
    client.emit({
      type: 'session_update',
      sessionId: 'session-new',
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'source' },
    })
    client.emit({
      type: 'session_update',
      sessionId: 'session-new',
      update: { sessionUpdate: 'plan', id: 'plan-stream', entries: [{ content: 'Implement', status: 'completed' }] },
    })

    const questions: CodeBuddyInterruption = {
      ...interruptionBase('session-new', 'questions-1', 'AskUserQuestion'),
      kind: 'questions',
      toolName: 'AskUserQuestion',
      questions: [{ id: 'framework', question: 'Framework?', options: [{ label: 'Svelte' }], multi_select: false }],
    }
    const plan: CodeBuddyInterruption = {
      ...interruptionBase('session-new', 'plan-1', 'ExitPlanMode'),
      kind: 'plan',
      toolName: 'ExitPlanMode',
      plan: '# Plan',
    }
    const permission: CodeBuddyInterruption = {
      ...interruptionBase('session-new', 'tool-2', 'Bash'),
      kind: 'permission',
      requestId: 'permission-1',
      toolCall: { toolCallId: 'tool-2', title: 'Run command', rawInput: { command: 'pnpm test' } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'allow-session', name: 'Allow for session', kind: 'allow_session' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    }
    client.emit({ type: 'interruption', interruption: questions })
    client.emit({ type: 'interruption', interruption: plan })
    client.emit({ type: 'interruption', interruption: permission })

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message_delta', delta: 'hello', role: 'assistant' }),
      expect.objectContaining({ type: 'tool_call', toolCallId: 'tool-1', name: 'Read' }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'tool-1', output: 'source' }),
      expect.objectContaining({ type: 'message_upsert', messageId: 'plan:plan-stream', text: '- [x] Implement' }),
      expect.objectContaining({ type: 'questions', requestId: 'questions-1' }),
      expect.objectContaining({ type: 'plan', requestId: 'plan-1', markdown: '# Plan' }),
      expect.objectContaining({ type: 'permission', requestId: 'permission-1', title: 'Run command' }),
    ]))

    await transport.respond({ kind: 'questions', requestId: 'questions-1', answers: { framework: 'Svelte' } })
    await transport.respond({ kind: 'plan', requestId: 'plan-1', decision: 'reject', feedback: 'Add tests' })
    await transport.respond({ kind: 'permission', requestId: 'permission-1', decision: 'allow', remember: true })
    expect(client.resolutions.map((entry) => entry.resolution)).toEqual([
      { decision: 'allow', answers: { framework: 'Svelte' } },
      { decision: 'deny', feedback: 'Add tests' },
      { decision: 'allow', optionId: 'allow-session' },
    ])
    await expect(transport.respond({
      kind: 'permission', requestId: 'permission-1', decision: 'deny',
    })).rejects.toMatchObject({ code: 'codebuddy_unknown_request' })

    await transport.cancel({ requestId: 'cancel-1' })
    expect(client.cancellations).toEqual([{ sessionId: 'session-new', waitForPrompt: false }])
    await expect(transport.prompt({ requestId: 'turn-1', text: 'continue' })).resolves.toEqual({
      turnId: 'turn-1', stopReason: 'end_turn',
    })
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_completed', turnId: 'turn-1' }))

    client.emit({ type: 'exit', code: 17, signal: null, stderr: 'fixture failed' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'process_exited', code: 17, signal: null, stderrTail: 'fixture failed',
    }))
    await transport.close()
  })
})
