import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, test, vi } from 'vitest'

import {
  CodeBuddyAcpClient,
  parseFallbackQuestions,
  parseInterruption,
  type CodeBuddyAcpEvent,
  type CodeBuddyInterruption,
} from '../src/adapters/codebuddy-acp.js'

type FakeProcess = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: () => boolean
}

function fakeProcess(): FakeProcess {
  const child = new EventEmitter() as FakeProcess
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let killed = false
  child.kill = () => {
    if (killed) return false
    killed = true
    queueMicrotask(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', null, 'SIGTERM')
    })
    return true
  }
  return child
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
        if (newline < 0) break
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

  get available(): number {
    return this.frames.length
  }
}

function send(child: FakeProcess, message: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(message)}\n`)
}

async function initialize(
  client: CodeBuddyAcpClient,
  child: FakeProcess,
  frames: FrameReader,
  capabilities: Record<string, unknown> = { loadSession: true },
): Promise<void> {
  const initializing = client.initialize()
  const request = await frames.next()
  expect(request.method).toBe('initialize')
  send(child, {
    jsonrpc: '2.0',
    id: request.id,
    result: { protocolVersion: 1, agentCapabilities: capabilities },
  })
  await initializing
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('CodeBuddy ACP JSON-RPC transport', () => {
  test('handles split and coalesced NDJSON frames and reports malformed non-empty frames', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const events: CodeBuddyAcpEvent[] = []
    const client = new CodeBuddyAcpClient({
      cwd: '/tmp',
      spawnProcess: () => child as never,
      onEvent: (event) => events.push(event),
    })

    const initializing = client.initialize()
    const request = await frames.next()
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    })
    child.stdout.write(response.slice(0, 17))
    child.stdout.write(`${response.slice(17)}\n\n`)
    await initializing

    child.stdout.write([
      JSON.stringify({ jsonrpc: '2.0', method: 'vendor/event', params: { value: 1 } }),
      '{not-json}',
      JSON.stringify({ jsonrpc: '2.0', method: 'vendor/event', params: { value: 2 } }),
      '',
    ].join('\n'))
    await tick()

    expect(events.filter((event) => event.type === 'notification')).toHaveLength(2)
    expect(events.find((event) => event.type === 'diagnostic')).toMatchObject({
      type: 'diagnostic',
      frame: '{not-json}',
    })
    await client.close()
  })

  test('matches out-of-order responses without coupling request order', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })
    const completed: string[] = []

    const first = client.resolveQuestions(
      { sessionId: 's1', toolCallId: 'call1' },
      { framework: 'Svelte' },
    ).then(() => completed.push('first'))
    const second = client.resolveQuestions(
      { sessionId: 's2', toolCallId: 'call2' },
      { tests: 'Vitest' },
    ).then(() => completed.push('second'))
    const firstFrame = await frames.next()
    const secondFrame = await frames.next()

    send(child, { jsonrpc: '2.0', id: secondFrame.id, result: {} })
    await tick()
    expect(completed).toEqual(['second'])
    send(child, { jsonrpc: '2.0', id: firstFrame.id, result: {} })
    await Promise.all([first, second])
    expect(completed).toEqual(['second', 'first'])
    await client.close()
  })

  test('coalesces concurrent initialize calls and stores validated capabilities', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })

    const first = client.initialize()
    const second = client.initialize()
    expect(second).toBe(first)
    const request = await frames.next()
    await tick()
    expect(frames.available).toBe(0)
    send(child, {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      },
    })
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toBe(secondResult)
    expect(client.capabilities).toMatchObject({ loadSession: true })
    await client.close()
  })

  test('rejects session/load locally when the agent did not advertise the capability', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })
    await initialize(client, child, frames, { loadSession: false })

    await expect(client.loadSession('old-session', '/tmp')).rejects.toMatchObject({
      code: 'agent_capability_error',
    })
    await tick()
    expect(frames.available).toBe(0)
    await client.close()
  })

  test('validates typed new/load/prompt results and tracks session modes', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })
    await initialize(client, child, frames)

    const creating = client.newSession('/work')
    const newFrame = await frames.next()
    send(child, {
      jsonrpc: '2.0',
      id: newFrame.id,
      result: { sessionId: 'new-session', modes: { currentModeId: 'plan', availableModes: [] } },
    })
    await expect(creating).resolves.toBe('new-session')
    expect(client.currentMode('new-session')).toBe('plan')

    const loading = client.loadSession('old-session', '/work')
    const loadFrame = await frames.next()
    expect(loadFrame).toMatchObject({ method: 'session/load', params: { sessionId: 'old-session' } })
    send(child, { jsonrpc: '2.0', id: loadFrame.id, result: { sessionId: 'old-session' } })
    await expect(loading).resolves.toBe('old-session')

    const prompting = client.prompt('old-session', 'hello')
    const promptFrame = await frames.next()
    send(child, { jsonrpc: '2.0', id: promptFrame.id, result: { stopReason: 'end_turn' } })
    await expect(prompting).resolves.toEqual({ stopReason: 'end_turn' })
    await client.close()
  })

  test('uses a separate prompt timeout and serializes only prompts in the same session', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({
      cwd: '/tmp',
      spawnProcess: () => child as never,
      controlTimeoutMs: 10,
    })

    const firstS1 = client.prompt('s1', 'first')
    const secondS1 = client.prompt('s1', 'second')
    const firstS2 = client.prompt('s2', 'parallel')
    const activeFrames = [await frames.next(), await frames.next()]
    expect(activeFrames.map((frame) => (frame.params as { sessionId: string }).sessionId).sort()).toEqual(['s1', 's2'])

    await new Promise((resolve) => setTimeout(resolve, 30))
    const s2Frame = activeFrames.find((frame) => (frame.params as { sessionId: string }).sessionId === 's2')
    const s1Frame = activeFrames.find((frame) => (frame.params as { sessionId: string }).sessionId === 's1')
    expect(s1Frame).toBeDefined()
    expect(s2Frame).toBeDefined()
    send(child, { jsonrpc: '2.0', id: s2Frame?.id, result: { stopReason: 'end_turn' } })
    send(child, { jsonrpc: '2.0', id: s1Frame?.id, result: { stopReason: 'cancelled' } })
    await Promise.all([firstS1, firstS2])

    const queuedFrame = await frames.next()
    expect(queuedFrame).toMatchObject({ method: 'session/prompt', params: { sessionId: 's1' } })
    send(child, { jsonrpc: '2.0', id: queuedFrame.id, result: { stopReason: 'end_turn' } })
    await expect(secondS1).resolves.toMatchObject({ stopReason: 'end_turn' })
    await client.close()
  })

  test('marks timed out dispatched control requests as outcome unknown', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({
      cwd: '/tmp',
      spawnProcess: () => child as never,
      controlTimeoutMs: 5,
    })

    const initializing = client.initialize()
    await frames.next()
    await expect(initializing).rejects.toMatchObject({ code: 'agent_timeout', outcomeUnknown: true })
    await client.close()
  })

  test('sends cancel as a notification and can wait for the active prompt result', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })

    const prompt = client.prompt('s1', 'long task')
    const promptFrame = await frames.next()
    const cancelling = client.cancel('s1')
    const cancelFrame = await frames.next()
    expect(cancelFrame).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's1' } })

    let cancelSettled = false
    void cancelling.then(() => { cancelSettled = true })
    await tick()
    expect(cancelSettled).toBe(false)
    send(child, { jsonrpc: '2.0', id: promptFrame.id, result: { stopReason: 'cancelled' } })
    await expect(cancelling).resolves.toMatchObject({ stopReason: 'cancelled' })
    await prompt
    await client.close()
  })

  test('responds -32601 to unknown incoming requests and preserves string ids', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })

    send(child, { jsonrpc: '2.0', id: 'server-1', method: 'vendor/unknown', params: {} })
    await expect(frames.next()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 'server-1',
      error: { code: -32601, message: 'Method not found: vendor/unknown' },
    })
    await client.close()
  })
})

describe('CodeBuddy ACP interruptions and session state', () => {
  test('parses every AskUserQuestion item and preserves raw metadata', () => {
    const raw = {
      toolCallId: 'call1',
      toolName: 'AskUserQuestion',
      vendorField: { keep: true },
      toolInput: { questions: [
        { id: 'framework', question: 'Framework?', options: [{ label: 'Svelte', description: 'Small' }] },
        { id: 'tests', question: 'Tests?', options: [{ label: 'Vitest' }], multiSelect: true },
      ] },
    }
    const metadata = { traceId: 'trace-1' }
    const parsed = parseInterruption('s1', raw, metadata)
    expect(parsed?.kind).toBe('questions')
    if (parsed?.kind !== 'questions') throw new Error('expected questions interruption')
    expect(parsed.questions.map((question) => question.id)).toEqual(['framework', 'tests'])
    expect(parsed.questions[1]?.multi_select).toBe(true)
    expect(parsed.raw).toBe(raw)
    expect(parsed.metadata).toBe(metadata)
  })

  test('recovers questions from the generic failed-tool shape', () => {
    expect(parseFallbackQuestions({
      questions: JSON.stringify([{
        question: 'Framework?',
        header: 'Stack',
        multiSelect: false,
        options: [
          { label: 'Svelte', description: 'Recommended' },
          { label: 'React' },
        ],
      }]),
    })).toEqual([{
      id: 'q_0',
      prompt: 'Framework?',
      header: 'Stack',
      options: [
        { label: 'Svelte', description: 'Recommended' },
        { label: 'React' },
      ],
    }])
  })

  test('parses ExitPlanMode plan and resolves questions and plans through the generic API', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })
    const question = parseInterruption('s1', {
      toolCallId: 'q1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [{ question: 'Choose', options: [] }] },
    })
    const plan = parseInterruption('s1', {
      toolCallId: 'p1',
      toolName: 'ExitPlanMode',
      toolInput: { plan: '# Plan\n- implement' },
    })
    expect(plan).toMatchObject({ kind: 'plan', plan: '# Plan\n- implement' })
    expect(parseInterruption('s1', {
      toolCallId: 'p2', toolName: 'ExitPlanMode', toolInput: {},
    }, { 'codebuddy.ai/planContent': '# Metadata plan' })).toMatchObject({
      kind: 'plan', plan: '# Metadata plan',
    })
    if (question === null || plan === null) throw new Error('expected interruptions')

    const resolvingQuestion = client.resolveInterruption(question, {
      decision: 'allow',
      answers: { q_0: 'yes' },
    })
    const questionFrame = await frames.next()
    expect(questionFrame).toMatchObject({
      method: '_codebuddy.ai/resolveInterruption',
      params: { decision: 'allow', answers: { q_0: 'yes' } },
    })
    send(child, { jsonrpc: '2.0', id: questionFrame.id, result: {} })
    await resolvingQuestion

    const resolvingPlan = client.resolveInterruption(plan, { decision: 'deny', feedback: 'Revise step 1' })
    const planFrame = await frames.next()
    expect(planFrame).toMatchObject({ params: { decision: 'deny', feedback: 'Revise step 1' } })
    send(child, { jsonrpc: '2.0', id: planFrame.id, result: {} })
    await resolvingPlan
    await client.close()
  })

  test('surfaces standard permission requests and never silently allows them', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const interruptions: CodeBuddyInterruption[] = []
    const client = new CodeBuddyAcpClient({
      cwd: '/tmp',
      spawnProcess: () => child as never,
      onEvent: (event) => {
        if (event.type === 'interruption') interruptions.push(event.interruption)
      },
    })

    const rawParams = {
      sessionId: 's1',
      toolCall: { toolCallId: 'tool1', title: 'Run command', kind: 'execute', rawInput: { command: 'pwd' } },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
      _meta: { traceId: 'permission-trace' },
    }
    send(child, { jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: rawParams })
    await tick()
    expect(frames.available).toBe(0)
    const interruption = interruptions[0]
    expect(interruption).toMatchObject({
      kind: 'permission',
      requestId: 'permission-1',
      sessionId: 's1',
      metadata: { traceId: 'permission-trace' },
    })
    if (interruption?.kind !== 'permission') throw new Error('expected permission interruption')
    expect(interruption.raw).toEqual(rawParams)

    const resolving = client.resolveInterruption(interruption, { decision: 'deny' })
    await expect(frames.next()).resolves.toEqual({
      jsonrpc: '2.0',
      id: 'permission-1',
      result: { outcome: { outcome: 'selected', optionId: 'reject' } },
    })
    await resolving
    await client.close()
  })

  test('updates current mode from set_mode and server updates and emits sessionReset', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const events: CodeBuddyAcpEvent[] = []
    const client = new CodeBuddyAcpClient({
      cwd: '/tmp',
      spawnProcess: () => child as never,
      onEvent: (event) => events.push(event),
    })
    await initialize(client, child, frames)

    const setting = client.setMode('s1', 'acceptEdits')
    const setFrame = await frames.next()
    expect(setFrame).toMatchObject({ method: 'session/set_mode', params: { sessionId: 's1', modeId: 'acceptEdits' } })
    send(child, { jsonrpc: '2.0', id: setFrame.id, result: {} })
    await setting
    expect(client.currentMode('s1')).toBe('acceptEdits')

    send(child, { jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's1',
      update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
    } })
    send(child, { jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's1',
      update: { sessionUpdate: 'session_info_update', _meta: {
        'codebuddy.ai/sessionReset': true,
        'codebuddy.ai/newSessionId': 's2',
      } },
    } })
    await tick()
    expect(client.currentMode('s1')).toBeUndefined()
    expect(events.find((event) => event.type === 'session_reset')).toMatchObject({
      type: 'session_reset', sessionId: 's1', newSessionId: 's2', raw: {
        _meta: { 'codebuddy.ai/sessionReset': true, 'codebuddy.ai/newSessionId': 's2' },
      },
    })
    await client.close()
  })
})

describe('CodeBuddy ACP lifecycle', () => {
  test('bounds continuously drained stderr and rejects pending calls on exit', async () => {
    const child = fakeProcess()
    const events: CodeBuddyAcpEvent[] = []
    const client = new CodeBuddyAcpClient({
      cwd: '/tmp',
      spawnProcess: () => child as never,
      stderrBufferLimitBytes: 8,
      onEvent: (event) => events.push(event),
    })
    child.stderr.write('0123456789abcdef')
    await tick()
    expect(Buffer.byteLength(client.stderr)).toBeLessThanOrEqual(8)
    expect(client.stderr).toBe('89abcdef')

    const pending = client.resolveQuestions({ sessionId: 's1', toolCallId: 'q1' }, { q: 'a' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_exited' })
    child.emit('exit', 17, null)
    await rejected
    await expect(client.resolveQuestions({ sessionId: 's1', toolCallId: 'q2' }, {})).rejects.toMatchObject({
      code: 'agent_exited',
    })
    expect(events.find((event) => event.type === 'exit')).toMatchObject({
      type: 'exit', code: 17, stderr: '89abcdef',
    })
  })

  test('rejects pending calls on stdout EOF and child/stdin errors', async () => {
    for (const fail of [
      (child: FakeProcess) => child.stdout.end(),
      (child: FakeProcess) => child.emit('error', new Error('spawn failed')),
      (child: FakeProcess) => child.stdin.emit('error', new Error('broken pipe')),
    ]) {
      const child = fakeProcess()
      const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })
      const pending = client.resolveQuestions({ sessionId: 's1', toolCallId: 'q1' }, {})
      const rejected = expect(pending).rejects.toBeInstanceOf(Error)
      fail(child)
      await rejected
    }
  })

  test('close is asynchronous, idempotent, rejects pending requests, and rejects future requests', async () => {
    const child = fakeProcess()
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })
    const pending = client.resolveQuestions({ sessionId: 's1', toolCallId: 'q1' }, {})
    const rejected = expect(pending).rejects.toMatchObject({ code: 'agent_closed' })

    const firstClose = client.close()
    const secondClose = client.close()
    expect(secondClose).toBe(firstClose)
    await Promise.all([firstClose, rejected])
    await expect(client.resolveQuestions({ sessionId: 's1', toolCallId: 'q2' }, {})).rejects.toMatchObject({
      code: 'agent_closed',
    })
  })

  test('honors writable backpressure before sending the next frame', async () => {
    const child = fakeProcess()
    const frames = new FrameReader(child.stdin)
    const originalWrite = child.stdin.write.bind(child.stdin)
    let first = true
    const writeSpy = vi.spyOn(child.stdin, 'write').mockImplementation(((...args: Parameters<typeof child.stdin.write>) => {
      const result = originalWrite(...args)
      if (first) {
        first = false
        queueMicrotask(() => child.stdin.emit('drain'))
        return false
      }
      return result
    }) as typeof child.stdin.write)
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })

    const firstRequest = client.resolveQuestions({ sessionId: 's1', toolCallId: 'q1' }, {})
    const secondRequest = client.resolveQuestions({ sessionId: 's2', toolCallId: 'q2' }, {})
    const firstFrame = await frames.next()
    const secondFrame = await frames.next()
    expect(writeSpy).toHaveBeenCalledTimes(2)
    send(child, { jsonrpc: '2.0', id: firstFrame.id, result: {} })
    send(child, { jsonrpc: '2.0', id: secondFrame.id, result: {} })
    await Promise.all([firstRequest, secondRequest])
    await client.close()
  })
})
