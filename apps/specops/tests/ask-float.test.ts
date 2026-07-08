import { afterEach, describe, expect, test } from 'vitest'
import { mkdir, writeFile, rm, mkdtemp, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { initWorkspace } from '../src/domain/commands.js'
import { startServer, type ServeHandle } from '../src/server/index.js'
import { createSpecOpsSession, attachSessionAgent, listSpecOpsSessions } from '../src/domain/session.js'
import type { KodeClient, KodeSession } from '../src/adapters/kode.js'

const cleanup: string[] = []
const servers: ServeHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

function buildKodePlanMock(): { kode: KodeClient; calls: { createPlanSession: number } } {
  const calls = { createPlanSession: 0 }
  const socket = { on: () => socket, close: () => undefined }
  const session: KodeSession = { id: 9001, backend_key: 'codebuddy', status: 'idle', session_uuid: 'new-uuid-9001' }
  const kode = {
    getSession: async () => session,
    createPlanSession: async () => {
      calls.createPlanSession += 1
      return session
    },
    createAnalysisSession: async () => session,
    subscribe: () => socket,
    history: async () => ({ events: [], next_from: 0 }),
    killSession: async () => undefined,
  } as unknown as KodeClient
  return { kode, calls }
}

async function fixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'specops-ask-'))
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  await run('git', ['init', '-q', workspace])
  await run('git', ['-C', workspace, 'config', 'user.email', 't@t.co'])
  await run('git', ['-C', workspace, 'config', 'user.name', 't'])
  await mkdir(path.join(workspace, '.specops', 'specs'), { recursive: true })
  await mkdir(path.join(workspace, '.specops', 'state', 'sessions'), { recursive: true })
  await writeFile(
    path.join(workspace, '.specops', 'specs', 'auth.md'),
    ['---', 'schema_version: 1', 'id: auth', 'kind: spec', 'title: Auth Spec', 'status: active', '---', '', '# Auth', ''].join('\n'),
  )
  // initial commit so resolveGitWorkspace finds a valid HEAD
  await run('git', ['-C', workspace, 'add', '-A'])
  await run('git', ['-C', workspace, 'commit', '-q', '-m', 'init'])
  cleanup.push(workspace)
  await initWorkspace(workspace)
  const { kode } = buildKodePlanMock()
  const server = await startServer({ workspace, token: 'ask-token', kodeClient: kode })
  servers.push(server)
  return { workspace, server }
}

function auth(server: ServeHandle, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${server.token}`,
      origin: server.origin,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  }
}

describe('AskFloat clarify reuse', () => {
  test('second clarify on the same document_path reuses the existing active session', async () => {
    const { server } = await fixture()
    const docPath = '.specops/specs/auth.md'

    const first = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'what is auth?', document_path: docPath, backend_key: 'codebuddy' }),
    }))
    expect(first.status).toBe(201)
    const firstBody = await first.json() as { specops_session: { id: string }; reused?: boolean }
    expect(firstBody.reused).toBeUndefined()
    const firstSessionId = firstBody.specops_session.id

    const second = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'more details?', document_path: docPath, backend_key: 'codebuddy' }),
    }))
    expect(second.status).toBe(200)
    const secondBody = await second.json() as { specops_session: { id: string }; reused?: boolean }
    expect(secondBody.reused).toBe(true)
    expect(secondBody.specops_session.id).toBe(firstSessionId)
  })

  test('clarify without document_path always creates a new session', async () => {
    const { server } = await fixture()

    const first = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'orphan question', backend_key: 'codebuddy' }),
    }))
    expect(first.status).toBe(201)

    const second = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'another orphan', backend_key: 'codebuddy' }),
    }))
    expect(second.status).toBe(201)
    const secondBody = await second.json() as { specops_session: { id: string }; reused?: boolean }
    expect(secondBody.reused).toBeUndefined()
  })
})
