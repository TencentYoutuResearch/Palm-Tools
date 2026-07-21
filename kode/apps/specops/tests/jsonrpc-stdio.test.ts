import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, test, vi } from 'vitest'

import {
  JsonRpcStdioTransport,
  type JsonRpcStdioChild,
} from '../src/execution/jsonrpc-stdio.js'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killCount = 0

  kill(): boolean {
    this.killCount += 1
    this.emit('exit', null, 'SIGTERM')
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
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim() === '') continue
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

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('JsonRpcStdioTransport', () => {
  test('matches out-of-order responses with number and string ids', async () => {
    const child = new FakeChild()
    const frames = new FrameReader(child.stdin)
    const rpc = new JsonRpcStdioTransport({ child: child.asTransportChild() })

    const first = rpc.request<{ order: number }>('first', {}, { id: 7 })
    const second = rpc.request<{ order: number }>('second', {}, { id: '7' })
    expect((await frames.next()).id).toBe(7)
    expect((await frames.next()).id).toBe('7')

    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: '7', result: { order: 2 } })}\n`)
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, result: { order: 1 } })}\n`)

    await expect(second).resolves.toEqual({ order: 2 })
    await expect(first).resolves.toEqual({ order: 1 })
    await rpc.close()
  })

  test('optionally accepts Codex-compatible outbound frames without jsonrpc', async () => {
    const child = new FakeChild()
    const frames = new FrameReader(child.stdin)
    const notifications: string[] = []
    const rpc = new JsonRpcStdioTransport({
      child: child.asTransportChild(),
      allowMissingJsonrpc: true,
      onNotification: (method) => { notifications.push(method) },
    })
    const pending = rpc.request('initialize')
    const request = await frames.next()
    child.stdout.write(`${JSON.stringify({ id: request.id, result: { ready: true } })}\n`)
    child.stdout.write(`${JSON.stringify({ method: 'server/status', params: { ready: true } })}\n`)
    await expect(pending).resolves.toEqual({ ready: true })
    await tick()
    expect(notifications).toEqual(['server/status'])
    await rpc.close()
  })

  test('dispatches notifications and answers server requests', async () => {
    const child = new FakeChild()
    const frames = new FrameReader(child.stdin)
    const notifications: Array<[string, unknown]> = []
    const rpc = new JsonRpcStdioTransport({
      child: child.asTransportChild(),
      onNotification: (method, params) => { notifications.push([method, params]) },
      onRequest: async (method, params, id) => ({ method, params, id }),
    })

    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'status', params: { ready: true } })}\n`)
    child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'server-1', method: 'workspace/read', params: { path: 'a.ts' } })}\n`)

    const response = await frames.next()
    expect(notifications).toEqual([['status', { ready: true }]])
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'server-1',
      result: { method: 'workspace/read', params: { path: 'a.ts' }, id: 'server-1' },
    })
    await rpc.close()
  })

  test('diagnoses malformed frames and rejects pending calls on EOF with bounded stderr', async () => {
    const child = new FakeChild()
    const frames = new FrameReader(child.stdin)
    const diagnostic = vi.fn()
    const rpc = new JsonRpcStdioTransport({
      child: child.asTransportChild(),
      stderrTailBytes: 8,
      onDiagnostic: diagnostic,
    })

    child.stdout.write('not-json\n')
    child.stderr.write('0123456789abcdef')
    const pending = rpc.request('long-running')
    await frames.next()
    child.stdout.end()

    await expect(pending).rejects.toMatchObject({
      code: 'jsonrpc_eof',
      outcomeUnknown: true,
    })
    expect(rpc.stderrTail).toBe('89abcdef')
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: 'malformed_frame' }))
  })

  test('close is idempotent and rejects calls after closing', async () => {
    const child = new FakeChild()
    const rpc = new JsonRpcStdioTransport({ child: child.asTransportChild() })
    const first = rpc.close()
    const second = rpc.close()
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(child.killCount).toBe(1)
    expect(() => rpc.request('after-close')).toThrowError(/closed/)
    await tick()
  })
})
