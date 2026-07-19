import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, test, vi } from 'vitest'

import {
  ClaudeStreamJsonTransport,
  type ClaudeProbeOutput,
  type ClaudeSpawnOptions,
  type ClaudeStreamJsonChild,
} from '../src/adapters/claude-stream-json.js'
import type { TransportExecutionEvent } from '../src/execution/types.js'

const HELP = `
  --print
  --input-format <format>
  --output-format <format>
  --permission-prompt-tool <tool>
  --replay-user-messages
  --include-partial-messages
  --resume <session>
  --verbose
  --permission-mode <mode>
  --model <model>
`

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killCount = 0
  exited = false

  constructor() {
    super()
    this.stdin.once('finish', () => queueMicrotask(() => this.exit(0, null)))
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killCount += 1
    const normalized = typeof signal === 'string' ? signal : 'SIGTERM'
    queueMicrotask(() => this.exit(null, normalized))
    return true
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, signal)
  }

  asChild(): ClaudeStreamJsonChild {
    return this as unknown as ClaudeStreamJsonChild
  }
}

class FrameReader {
  private buffer = ''
  private readonly frames: Array<Record<string, unknown>> = []
  private readonly waiters: Array<(frame: Record<string, unknown>) => void> = []

  constructor(stream: PassThrough) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) return
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line === '') continue
        const frame = JSON.parse(line) as Record<string, unknown>
        const waiter = this.waiters.shift()
        if (waiter === undefined) this.frames.push(frame)
        else waiter(frame)
      }
    })
  }

  next(): Promise<Record<string, unknown>> {
    const frame = this.frames.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

interface Harness {
  transport: ClaudeStreamJsonTransport
  child: FakeChild
  frames: FrameReader
  events: TransportExecutionEvent[]
  spawnArgs: string[][]
  spawnOptions: ClaudeSpawnOptions[]
}

function createHarness(help = HELP): Harness {
  const child = new FakeChild()
  const events: TransportExecutionEvent[] = []
  const spawnArgs: string[][] = []
  const spawnOptions: ClaudeSpawnOptions[] = []
  const probeCommand = vi.fn(async (_command: string, args: readonly string[]): Promise<ClaudeProbeOutput> => {
    if (args.includes('--version')) return { stdout: '2.1.0 (Claude Code)\n', stderr: '' }
    return { stdout: help, stderr: '' }
  })
  const transport = new ClaudeStreamJsonTransport({
    command: 'claude-fixture',
    args: ['--fixture'],
    probeCommand,
    spawnProcess: (_command, args, options) => {
      spawnArgs.push([...args])
      spawnOptions.push(options)
      return child.asChild()
    },
    closeTimeoutMs: 10,
  })
  transport.events((event) => events.push(event))
  return { transport, child, frames: new FrameReader(child.stdin), events, spawnArgs, spawnOptions }
}

function send(child: FakeChild, message: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(message)}\n`)
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function start(harness: Harness): Promise<void> {
  await harness.transport.start({
    executionId: 'exec-1',
    processGeneration: 1,
    backendKey: 'claude',
    cwd: '/workspace',
  })
}

describe('Claude stream-json probe and process launch', () => {
  test('probes version and required flags, then starts one structured stdio process', async () => {
    const harness = createHarness()
    const probe = await harness.transport.probe()
    expect(probe).toMatchObject({
      transport: 'claude-stream-json',
      version: '2.1.0 (Claude Code)',
      metadata: { includePartialMessages: true, printMode: true },
    })
    expect(probe.capabilities).toEqual(expect.arrayContaining([
      'session.create',
      'session.resume',
      'session.prompt',
      'session.interrupt',
      'conversation.permission',
      'conversation.ask',
      'conversation.plan',
      'session.mode',
      'output.structured',
    ]))

    const session = await harness.transport.start({
      executionId: 'exec-1',
      processGeneration: 1,
      backendKey: 'claude',
      cwd: '/workspace',
      model: 'sonnet',
      mode: 'plan',
    })
    expect(session).toMatchObject({ nativeSessionId: null, model: 'sonnet', mode: 'plan' })
    expect(harness.spawnArgs).toHaveLength(1)
    expect(harness.spawnArgs[0]).toEqual([
      '--fixture',
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--replay-user-messages',
      '--verbose',
      '--include-partial-messages',
      '--model', 'sonnet',
      '--permission-mode', 'plan',
    ])
    expect(harness.spawnOptions[0]).toMatchObject({ cwd: '/workspace', stdio: ['pipe', 'pipe', 'pipe'] })
    expect(harness.spawnOptions[0]?.env.CLAUDECODE).toBeUndefined()
    await expect(harness.transport.start({
      executionId: 'exec-1',
      processGeneration: 2,
      backendKey: 'claude',
      cwd: '/workspace',
    })).rejects.toMatchObject({ code: 'transport_already_started' })
    await harness.transport.close()
  })

  test('loads a native session with --resume', async () => {
    const harness = createHarness()
    await expect(harness.transport.load({
      executionId: 'exec-2',
      processGeneration: 1,
      backendKey: 'claude',
      cwd: '/workspace',
      nativeSessionId: 'session-old',
    })).resolves.toMatchObject({ nativeSessionId: 'session-old' })
    expect(harness.spawnArgs[0]?.slice(-2)).toEqual(['--resume', 'session-old'])
    await harness.transport.close()
  })

  test('fails probe explicitly when the command lacks a required protocol flag', async () => {
    const harness = createHarness(HELP.replace('  --permission-prompt-tool <tool>\n', ''))
    await expect(harness.transport.probe()).rejects.toMatchObject({
      code: 'claude_missing_stream_json_capability',
      message: expect.stringContaining('--permission-prompt-tool'),
    })
    expect(harness.spawnArgs).toHaveLength(0)
  })
})

describe('Claude stream-json events and turn completion', () => {
  test('writes prompts as NDJSON and parses session, deltas, tools, results, and usage', async () => {
    const harness = createHarness()
    await start(harness)
    const turn = harness.transport.prompt({ requestId: 'turn-1', text: 'implement it' })
    await expect(harness.frames.next()).resolves.toEqual({
      type: 'user',
      message: { role: 'user', content: 'implement it' },
    })

    send(harness.child, { type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-sonnet' })
    send(harness.child, {
      type: 'stream_event',
      session_id: 'session-1',
      event: { type: 'message_start', message: { id: 'message-1' } },
    })
    send(harness.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
    })
    send(harness.child, {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} } },
    })
    send(harness.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.ts"}' } },
    })
    send(harness.child, { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
    send(harness.child, {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'After tool.' } },
    })
    send(harness.child, {
      type: 'assistant',
      message: { id: 'message-1', content: [
        { type: 'text', text: 'Hello world' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
        { type: 'text', text: 'After tool.' },
      ] },
    })
    send(harness.child, {
      type: 'user',
      message: { id: 'user-tool', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'source', is_error: false }] },
    })
    send(harness.child, {
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      uuid: 'result-1',
      result: 'Hello world',
      usage: { input_tokens: 10, output_tokens: 2 },
    })

    await expect(turn).resolves.toEqual({
      turnId: 'result-1',
      stopReason: 'completed',
      metadata: {
        session_id: 'session-1',
        result: 'Hello world',
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    })
    expect(harness.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'status', status: 'ready', detail: 'session session-1' }),
      expect.objectContaining({ type: 'message_delta', messageId: 'message-1:block:0', delta: 'Hello ' }),
      expect.objectContaining({ type: 'message_upsert', messageId: 'message-1:block:0', text: 'Hello world' }),
      expect.objectContaining({ type: 'message_delta', messageId: 'message-1:block:2', delta: 'After tool.' }),
      expect.objectContaining({ type: 'message_upsert', messageId: 'message-1:block:2', text: 'After tool.' }),
      expect.objectContaining({ type: 'tool_call', toolCallId: 'tool-1', status: 'in_progress' }),
      expect.objectContaining({ type: 'tool_call', toolCallId: 'tool-1', input: { file_path: 'a.ts' }, status: 'complete' }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'tool-1', output: 'source', isError: false }),
      expect.objectContaining({ type: 'turn_completed', turnId: 'result-1', stopReason: 'completed' }),
    ]))
    await harness.transport.close()
  })

  test('does not complete a turn on compaction and rejects authoritative error results', async () => {
    const harness = createHarness()
    await start(harness)
    const turn = harness.transport.prompt({ requestId: 'turn-error', text: 'fail' })
    await harness.frames.next()
    send(harness.child, { type: 'result', subtype: 'compact' })
    await tick()
    expect(harness.events).toContainEqual(expect.objectContaining({ type: 'status', status: 'compacted' }))
    send(harness.child, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API failed' })
    await expect(turn).rejects.toMatchObject({ code: 'claude_turn_failed', message: 'API failed' })
    expect(harness.events).toContainEqual(expect.objectContaining({ type: 'turn_failed', error: 'API failed' }))
    await harness.transport.close()
  })
})

describe('Claude stream-json structured interactions', () => {
  test('surfaces and answers permission requests with Claude control_response', async () => {
    const harness = createHarness()
    await start(harness)
    send(harness.child, {
      type: 'control_request',
      request_id: 'permission-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } },
    })
    await tick()
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'permission', requestId: 'permission-1', title: 'Bash', options: ['allow', 'deny'],
    }))

    await harness.transport.respond({ kind: 'permission', requestId: 'permission-1', decision: 'allow' })
    await expect(harness.frames.next()).resolves.toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'permission-1',
        response: { behavior: 'allow', updatedInput: { command: 'pwd' } },
      },
    })
    await harness.transport.close()
  })

  test('parses all AskUserQuestion items and returns answers in updatedInput', async () => {
    const harness = createHarness()
    await start(harness)
    send(harness.child, {
      type: 'control_request',
      request_id: 'questions-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [
          { id: 'framework', question: 'Framework?', header: 'Stack', options: [{ label: 'Svelte', description: 'lean' }] },
          { question: 'Checks?', options: [{ label: 'TypeScript' }, { label: 'Vitest' }], multiSelect: true },
        ] },
      },
    })
    await tick()
    expect(harness.events).toContainEqual(expect.objectContaining({
      type: 'questions',
      requestId: 'questions-1',
      questions: [
        expect.objectContaining({ id: 'framework', prompt: 'Framework?', header: 'Stack' }),
        expect.objectContaining({ id: 'q_1', prompt: 'Checks?', multiSelect: true }),
      ],
    }))

    await harness.transport.respond({
      kind: 'questions',
      requestId: 'questions-1',
      answers: { framework: 'Svelte', q_1: ['TypeScript', 'Vitest'] },
    })
    const frame = await harness.frames.next()
    expect(frame).toMatchObject({
      type: 'control_response',
      response: {
        request_id: 'questions-1',
        response: {
          behavior: 'allow',
          updatedInput: { answers: { 'Framework?': 'Svelte', 'Checks?': 'TypeScript, Vitest' } },
        },
      },
    })
    await harness.transport.close()
  })

  test('handles ExitPlanMode only through its structured permission request', async () => {
    const harness = createHarness()
    await start(harness)
    send(harness.child, {
      type: 'control_request',
      request_id: 'plan-1',
      request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan\n- edit' } },
    })
    await tick()
    expect(harness.events).toContainEqual({ type: 'plan', requestId: 'plan-1', markdown: '# Plan\n- edit' })

    await harness.transport.respond({ kind: 'plan', requestId: 'plan-1', decision: 'reject', feedback: 'Add tests' })
    await expect(harness.frames.next()).resolves.toMatchObject({
      type: 'control_response',
      response: { request_id: 'plan-1', response: { behavior: 'deny', message: 'Add tests' } },
    })
    await expect(harness.transport.respond({
      kind: 'plan', requestId: 'plan-1', decision: 'approve',
    })).rejects.toMatchObject({ code: 'interaction_not_found' })
    await harness.transport.close()
  })
})

describe('Claude stream-json cancel and lifecycle', () => {
  test('sends interrupt control requests and preserves write ordering under backpressure', async () => {
    const harness = createHarness()
    await start(harness)
    const originalWrite = harness.child.stdin.write.bind(harness.child.stdin)
    let first = true
    vi.spyOn(harness.child.stdin, 'write').mockImplementation(((...args: Parameters<typeof harness.child.stdin.write>) => {
      const accepted = originalWrite(...args)
      if (first) {
        first = false
        queueMicrotask(() => harness.child.stdin.emit('drain'))
        return false
      }
      return accepted
    }) as typeof harness.child.stdin.write)

    const turn = harness.transport.prompt({ requestId: 'turn-cancel', text: 'long task' })
    const cancelling = harness.transport.cancel({ requestId: 'cancel-command', reason: 'user requested' })
    expect(await harness.frames.next()).toEqual({ type: 'user', message: { role: 'user', content: 'long task' } })
    expect(await harness.frames.next()).toEqual({
      type: 'control_request', request_id: 'cancel-command', request: { subtype: 'interrupt' },
    })
    await cancelling
    send(harness.child, { type: 'result', subtype: 'interrupted' })
    await expect(turn).resolves.toMatchObject({ stopReason: 'interrupted' })
    await harness.transport.close()
  })

  test('captures bounded stderr, rejects an active turn on exit, and emits lifecycle once', async () => {
    const harness = createHarness()
    await start(harness)
    const turn = harness.transport.prompt({ requestId: 'turn-exit', text: 'work' })
    await harness.frames.next()
    harness.child.stderr.write('fatal fixture error')
    harness.child.exit(17, null)

    await expect(turn).rejects.toMatchObject({ code: 'claude_process_exited', outcomeUnknown: true })
    await tick()
    expect(harness.events.filter((event) => event.type === 'process_exited')).toEqual([
      expect.objectContaining({ type: 'process_exited', code: 17, signal: null, stderrTail: 'fatal fixture error' }),
    ])
    await expect(harness.transport.prompt({ requestId: 'later', text: 'no' })).rejects.toMatchObject({
      code: 'claude_process_exited',
    })
  })

  test('close is asynchronous and idempotent and rejects future operations', async () => {
    const harness = createHarness()
    await start(harness)
    const first = harness.transport.close()
    const second = harness.transport.close()
    expect(second).toBe(first)
    await first
    await expect(harness.transport.cancel({ requestId: 'after-close' })).rejects.toMatchObject({
      code: 'transport_closed',
    })
  })
})
