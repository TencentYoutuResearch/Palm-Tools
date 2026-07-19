import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'vitest'

import { CodexAppServerTransport } from '../src/adapters/codex-app-server.js'
import type { JsonRpcStdioChild } from '../src/execution/jsonrpc-stdio.js'
import type { TransportExecutionEvent } from '../src/execution/types.js'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killCount = 0

  kill(): boolean {
    this.killCount += 1
    queueMicrotask(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', null, 'SIGTERM')
    })
    return true
  }

  asTransportChild(): JsonRpcStdioChild {
    return this as unknown as JsonRpcStdioChild
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

function send(child: FakeChild, message: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function respond(child: FakeChild, request: Record<string, unknown>, result: unknown): void {
  send(child, { id: request.id, result })
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function fixture(): {
  child: FakeChild
  frames: FrameReader
  transport: CodexAppServerTransport
  events: TransportExecutionEvent[]
} {
  const child = new FakeChild()
  const frames = new FrameReader(child.stdin)
  const events: TransportExecutionEvent[] = []
  const transport = new CodexAppServerTransport({
    cwd: '/work',
    spawnProcess: () => child.asTransportChild(),
  })
  transport.events((event) => events.push(event))
  return { child, frames, transport, events }
}

async function initialize(
  transport: CodexAppServerTransport,
  child: FakeChild,
  frames: FrameReader,
): Promise<void> {
  const probing = transport.probe()
  const request = await frames.next()
  expect(request).toMatchObject({
    method: 'initialize',
    params: {
      clientInfo: { name: 'kode-specops' },
      capabilities: { experimentalApi: true },
    },
  })
  respond(child, request, { protocolVersion: '2' })
  await expect(frames.next()).resolves.toEqual({ jsonrpc: '2.0', method: 'initialized' })
  await expect(probing).resolves.toMatchObject({
    transport: 'codex-app-server',
    version: '2',
    capabilities: expect.arrayContaining([
      'session.create',
      'session.resume',
      'session.prompt',
      'session.interrupt',
      'conversation.permission',
      'conversation.ask',
    ]),
  })
}

async function startThread(
  transport: CodexAppServerTransport,
  child: FakeChild,
  frames: FrameReader,
): Promise<void> {
  const starting = transport.start({
    executionId: 'execution-1',
    processGeneration: 1,
    backendKey: 'codex',
    cwd: '/work',
    model: 'gpt-5.4',
  })
  const request = await frames.next()
  expect(request).toMatchObject({ method: 'thread/start', params: { cwd: '/work', model: 'gpt-5.4' } })
  respond(child, request, { thread: { id: 'thread-1' }, model: 'gpt-5.4', cwd: '/work' })
  await expect(starting).resolves.toMatchObject({ nativeSessionId: 'thread-1', model: 'gpt-5.4' })
}

describe('Codex app-server transport sessions', () => {
  test('starts a thread, applies supported modes, and resumes in a separate process', async () => {
    const started = fixture()
    await initialize(started.transport, started.child, started.frames)

    const starting = started.transport.start({
      executionId: 'execution-1',
      processGeneration: 1,
      backendKey: 'codex',
      cwd: '/work',
      mode: 'plan',
    })
    const startRequest = await started.frames.next()
    expect(startRequest).toMatchObject({ method: 'thread/start', params: { cwd: '/work' } })
    expect(startRequest.params).not.toHaveProperty('model')
    respond(started.child, startRequest, { thread: { id: 'thread-new' }, model: 'gpt-5.4', cwd: '/work' })

    const initialMode = await started.frames.next()
    expect(initialMode).toMatchObject({
      method: 'thread/settings/update',
      params: {
        threadId: 'thread-new',
        collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.4' } },
      },
    })
    respond(started.child, initialMode, {})
    await expect(starting).resolves.toMatchObject({ nativeSessionId: 'thread-new', mode: 'plan' })

    const setting = started.transport.setMode({ requestId: 'mode-1', mode: 'default' })
    const setModeRequest = await started.frames.next()
    expect(setModeRequest).toMatchObject({
      method: 'thread/settings/update',
      params: { threadId: 'thread-new', collaborationMode: { mode: 'default' } },
    })
    respond(started.child, setModeRequest, {})
    await setting
    await started.transport.close()

    const resumed = fixture()
    await initialize(resumed.transport, resumed.child, resumed.frames)
    const loading = resumed.transport.load({
      executionId: 'execution-1',
      processGeneration: 2,
      backendKey: 'codex',
      cwd: '/work',
      nativeSessionId: 'thread-existing',
      model: 'gpt-5.4',
    })
    const resumeRequest = await resumed.frames.next()
    expect(resumeRequest).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-existing', cwd: '/work', model: 'gpt-5.4' },
    })
    respond(resumed.child, resumeRequest, { thread: { id: 'thread-existing' }, model: 'gpt-5.4', cwd: '/work' })
    await expect(loading).resolves.toMatchObject({ nativeSessionId: 'thread-existing' })
    await resumed.transport.close()
  })
})

describe('Codex app-server event normalization', () => {
  test('maps message/reasoning/plan streams and command, file, and MCP tools', async () => {
    const { child, frames, transport, events } = fixture()
    await initialize(transport, child, frames)
    await startThread(transport, child, frames)

    const prompting = transport.prompt({ requestId: 'prompt-1', text: 'implement it' })
    const turnRequest = await frames.next()
    expect(turnRequest).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'prompt-1',
        input: [{ type: 'text', text: 'implement it', text_elements: [] }],
      },
    })
    respond(child, turnRequest, { turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    await tick()

    send(child, { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 'hel' } })
    send(child, { method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'reasoning-1', summaryIndex: 0, delta: 'think' } })
    send(child, { method: 'item/plan/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'plan-1', delta: '- step' } })
    send(child, { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1, item: {
      id: 'command-1', type: 'commandExecution', command: 'pwd', cwd: '/work', commandActions: [], status: 'inProgress',
    } } })
    send(child, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 2, item: {
      id: 'command-1', type: 'commandExecution', command: 'pwd', cwd: '/work', commandActions: [], status: 'completed', aggregatedOutput: '/work', exitCode: 0,
    } } })
    send(child, { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 3, item: {
      id: 'file-1', type: 'fileChange', changes: [{ path: 'a.ts', kind: { type: 'update' } }], status: 'inProgress',
    } } })
    send(child, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 4, item: {
      id: 'file-1', type: 'fileChange', changes: [{ path: 'a.ts', kind: { type: 'update' } }], status: 'completed',
    } } })
    send(child, { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 5, item: {
      id: 'mcp-1', type: 'mcpToolCall', server: 'memory', tool: 'search', arguments: { query: 'transport' }, status: 'inProgress',
    } } })
    send(child, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 6, item: {
      id: 'mcp-1', type: 'mcpToolCall', server: 'memory', tool: 'search', arguments: { query: 'transport' }, status: 'completed', result: { content: [] },
    } } })
    send(child, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 7, item: {
      id: 'reasoning-1', type: 'reasoning', summary: ['Thought through it'], content: [],
    } } })
    send(child, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 8, item: {
      id: 'message-1', type: 'agentMessage', text: 'hello',
    } } })
    send(child, { method: 'turn/plan/updated', params: {
      threadId: 'thread-1', turnId: 'turn-1', explanation: 'Plan', plan: [{ step: 'Ship it', status: 'completed' }],
    } })
    send(child, { method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    } })

    await expect(prompting).resolves.toEqual({ turnId: 'turn-1', stopReason: 'completed' })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'message_delta', messageId: 'message-1', delta: 'hel' }),
      expect.objectContaining({ type: 'message_delta', messageId: 'reasoning:reasoning-1', delta: 'think' }),
      expect.objectContaining({ type: 'message_upsert', messageId: 'message-1', text: 'hello' }),
      expect.objectContaining({ type: 'message_delta', messageId: 'plan:plan-1', delta: '- step' }),
      expect.objectContaining({ type: 'message_upsert', messageId: 'plan:turn-1', text: 'Plan\n- [x] Ship it' }),
      expect.objectContaining({ type: 'tool_call', toolCallId: 'command-1', name: 'Bash' }),
      expect.objectContaining({ type: 'tool_result', toolCallId: 'command-1', isError: false }),
      expect.objectContaining({ type: 'tool_call', toolCallId: 'file-1', name: 'Patch' }),
      expect.objectContaining({ type: 'tool_call', toolCallId: 'mcp-1', name: 'memory:search' }),
      expect.objectContaining({ type: 'turn_completed', turnId: 'turn-1' }),
    ]))
    await transport.close()
  })

  test('preserves incoming request ids for permissions and questions', async () => {
    const { child, frames, transport, events } = fixture()
    await initialize(transport, child, frames)
    await startThread(transport, child, frames)

    send(child, {
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
        command: 'pnpm test', cwd: '/work', availableDecisions: ['accept', 'acceptForSession', 'decline'],
      },
    })
    await tick()
    expect(events).toContainEqual(expect.objectContaining({
      type: 'permission', requestId: 'approval-1', title: 'Run command',
    }))
    await transport.respond({ kind: 'permission', requestId: 'approval-1', decision: 'allow', remember: true })
    await expect(frames.next()).resolves.toEqual({
      jsonrpc: '2.0', id: 'approval-1', result: { decision: 'acceptForSession' },
    })

    send(child, {
      id: 17,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', itemId: 'question-1',
        questions: [
          { id: 'framework', header: 'Framework', question: 'Which framework?', options: [{ label: 'Svelte', description: 'Small' }] },
          { id: 'tests', header: 'Tests', question: 'Which tests?', options: null },
        ],
      },
    })
    await tick()
    expect(events).toContainEqual(expect.objectContaining({
      type: 'questions',
      requestId: '17',
      questions: [
        expect.objectContaining({ id: 'framework', prompt: 'Which framework?' }),
        expect.objectContaining({ id: 'tests', prompt: 'Which tests?' }),
      ],
    }))
    await transport.respond({
      kind: 'questions',
      requestId: '17',
      answers: { framework: 'Svelte', tests: ['Vitest', 'integration'] },
    })
    await expect(frames.next()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 17,
      result: {
        answers: {
          framework: { answers: ['Svelte'] },
          tests: { answers: ['Vitest', 'integration'] },
        },
      },
    })
    await transport.close()
  })

  test('interrupts the active turn and maps failed completion', async () => {
    const { child, frames, transport, events } = fixture()
    await initialize(transport, child, frames)
    await startThread(transport, child, frames)

    const firstPrompt = transport.prompt({ requestId: 'prompt-1', text: 'wait' })
    const firstTurn = await frames.next()
    respond(child, firstTurn, { turn: { id: 'turn-1', status: 'inProgress', items: [] } })
    await tick()

    const cancelling = transport.cancel({ requestId: 'cancel-1', reason: 'user' })
    const interrupt = await frames.next()
    expect(interrupt).toMatchObject({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } })
    respond(child, interrupt, {})
    await cancelling
    send(child, { method: 'turn/completed', params: {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted', items: [] },
    } })
    await expect(firstPrompt).resolves.toEqual({ turnId: 'turn-1', stopReason: 'interrupted' })

    const secondPrompt = transport.prompt({ requestId: 'prompt-2', text: 'fail' })
    const secondTurn = await frames.next()
    respond(child, secondTurn, { turn: { id: 'turn-2', status: 'inProgress', items: [] } })
    await tick()
    send(child, { method: 'turn/completed', params: {
      threadId: 'thread-1',
      turn: { id: 'turn-2', status: 'failed', items: [], error: { message: 'model unavailable' } },
    } })
    await expect(secondPrompt).rejects.toMatchObject({ code: 'codex_turn_failed', message: 'model unavailable' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'turn_failed', turnId: 'turn-2', error: 'model unavailable',
    }))
    await transport.close()
  })
})
