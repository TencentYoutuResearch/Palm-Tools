import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'vitest'

import { CodeBuddyAcpClient, parseInterruption, type CodeBuddyAcpEvent } from '../src/adapters/codebuddy-acp.js'

function fakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    return true
  }
  return child
}

async function nextFrame(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => stream.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim()) as Record<string, unknown>)))
}

describe('CodeBuddy ACP', () => {
  test('parses all AskUserQuestion items from one interruption', () => {
    const parsed = parseInterruption('s1', {
      toolCallId: 'call1', toolName: 'AskUserQuestion',
      toolInput: { questions: [
        { id: 'framework', question: 'Framework?', options: [{ label: 'Svelte', description: 'Small' }] },
        { id: 'tests', question: 'Tests?', options: [{ label: 'Vitest' }] },
      ] },
    })
    expect(parsed?.questions.map((question) => question.id)).toEqual(['framework', 'tests'])
  })

  test('submits one resolveInterruption request containing the complete answer map', async () => {
    const child = fakeProcess()
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never })
    const framePromise = nextFrame(child.stdin)
    const resolving = client.resolveQuestions(
      { sessionId: 's1', toolCallId: 'call1' },
      { framework: 'Svelte', tests: ['Vitest', 'Playwright'] },
    )
    const frame = await framePromise
    expect(frame).toMatchObject({
      jsonrpc: '2.0', method: '_codebuddy.ai/resolveInterruption',
      params: { sessionId: 's1', toolCallId: 'call1', decision: 'allow', answers: { framework: 'Svelte', tests: ['Vitest', 'Playwright'] } },
    })
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: {} })}\n`)
    await resolving
    client.close()
  })

  test('surfaces interruption metadata from session/update', async () => {
    const child = fakeProcess()
    const events: CodeBuddyAcpEvent[] = []
    const client = new CodeBuddyAcpClient({ cwd: '/tmp', spawnProcess: () => child as never, onEvent: (event) => events.push(event) })
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 's1', update: { sessionUpdate: 'session_info_update', _meta: {
        'codebuddy.ai/interruptionRequest': { toolCallId: 'call1', toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Choose', options: [] }] } },
      } },
    } })}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    expect(events[0]).toMatchObject({ type: 'interruption', interruption: { sessionId: 's1', toolCallId: 'call1' } })
    client.close()
  })
})
