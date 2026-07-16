import { createServer } from 'node:http'

import { afterEach, describe, expect, test } from 'vitest'

import { buildSubmitBytes, KodeClient, normalizeSubmitText } from '../src/adapters/kode.js'

const closers: Array<() => Promise<void>> = []
afterEach(async () => Promise.all(closers.splice(0).map((close) => close())))

describe('KodeClient', () => {
  test('normalizeSubmitText converts CR to LF and strips trailing newlines', () => {
    expect(normalizeSubmitText('hi')).toBe('hi')
    expect(normalizeSubmitText('a\r\nb')).toBe('a\nb')
    expect(normalizeSubmitText('a\rb')).toBe('a\nb')
    expect(normalizeSubmitText('done\n')).toBe('done')
    expect(normalizeSubmitText('done\n\n')).toBe('done')
    // No bare carriage returns leak through.
    expect(normalizeSubmitText('x\r\ny')).not.toContain('\r')
  })

  test('buildSubmitBytes wraps body in bracketed paste and submits with a bare CR', () => {
    const { body, submit } = buildSubmitBytes('line1\r\nline2\n')
    expect(body).toBe('\x1b[200~line1\nline2\x1b[201~')
    // No trailing newline inside the paste — it would insert a blank line.
    expect(body).not.toMatch(/\n\x1b\[201~$/)
    expect(submit).toBe('\r')
  })

  test('creates a session and submits prompt via paste body then a separate CR', async () => {
    const requests: Array<{ url: string; body: unknown; authorization: string | undefined }> = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: request.url ?? '', body: raw ? JSON.parse(raw) : null, authorization: request.headers.authorization })
      if (request.url === '/api/v1/sessions') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 7, backend_key: 'codebuddy', status: 'starting' }))
      } else {
        response.writeHead(204).end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(async () => new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server failed to bind')
    const client = new KodeClient(`http://127.0.0.1:${address.port}`, 'secret')
    // createSession without initial prompt — no prompt field sent
    const session = await client.createSession('codebuddy', '/tmp/worktree')
    await client.sendPrompt(session.id, 'Implement the task')
    expect(requests[0]).toMatchObject({ authorization: 'Bearer secret', body: { backend_key: 'codebuddy', cwd: '/tmp/worktree', permission_mode: 'bypass' } })
    expect(requests[0]?.body).not.toHaveProperty('prompt')
    // sendPrompt is two raw byte writes: the bracketed-paste body, then a CR.
    const bodyReq = requests[1]?.body as { bytes_b64: string }
    expect(requests[1]?.url).toBe('/api/v1/sessions/7/input')
    expect(Buffer.from(bodyReq.bytes_b64, 'base64').toString('utf8')).toBe('\x1b[200~Implement the task\x1b[201~')
    const submitReq = requests[2]?.body as { bytes_b64: string }
    expect(requests[2]?.url).toBe('/api/v1/sessions/7/input')
    expect(Buffer.from(submitReq.bytes_b64, 'base64').toString('utf8')).toBe('\r')

    // createSession with initial prompt — prompt field is set
    await client.createSession('codebuddy', '/tmp/worktree2', 'Do the work')
    expect(requests[3]).toMatchObject({
      body: { backend_key: 'codebuddy', cwd: '/tmp/worktree2', permission_mode: 'bypass', prompt: 'Do the work' },
    })

    await client.createAnalysisSession('codebuddy', '/tmp/workspace', 'Analyze this')
    expect(requests[4]).toMatchObject({
      body: {
        backend_key: 'codebuddy',
        cwd: '/tmp/workspace',
        permission_mode: 'bypass',
        prompt: 'Analyze this',
      },
    })
    expect(requests[4]?.body).not.toHaveProperty('extra_args')

    await client.createPlanSession('codebuddy', '/tmp/workspace', 'Plan this')
    expect(requests[5]).toMatchObject({
      body: {
        backend_key: 'codebuddy',
        cwd: '/tmp/workspace',
        permission_mode: 'bypass',
        prompt: 'Plan this',
      },
    })

    await client.focusSession(7)
    expect(requests[6]).toMatchObject({ url: '/api/v1/sessions/7/focus', body: null })

    await client.answer(7, 'question-1', 2, 'Use the existing desktop behavior', true)
    expect(requests[7]).toMatchObject({
      url: '/api/v1/sessions/7/answer',
      body: { question_id: 'question-1', choice_index: 2, submit: true },
    })

    await client.history(7)
    expect(requests[8]).toMatchObject({ url: '/api/v1/sessions/7/history?from=0&limit=1000' })
  })
})
