import { afterEach, describe, expect, test } from 'vitest'
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { initWorkspace } from '../src/domain/commands.js'
import { updateSpecOpsSession } from '../src/domain/session.js'
import { startServer, type ServeHandle, type SpecOpsExecutionRuntime } from '../src/server/index.js'
import type { KodeClient, KodeSession } from '../src/adapters/kode.js'
import type { ExecutionRequestOutcome, ExecutionTurnResult } from '../src/execution/types.js'

const cleanup: string[] = []
const servers: ServeHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

function buildKodePlanMock(): { kode: KodeClient; calls: { createPlanSession: number; sendPrompt: number } } {
  const calls = { createPlanSession: 0, sendPrompt: 0 }
  const socket = { on: () => socket, close: () => undefined }
  const session: KodeSession = { id: 9001, backend_key: 'codebuddy', status: 'idle', session_uuid: 'new-uuid-9001' }
  const kode = {
    getSession: async () => session,
    createPlanSession: async () => {
      calls.createPlanSession += 1
      return session
    },
    createAnalysisSession: async () => session,
    sendPrompt: async () => { calls.sendPrompt += 1 },
    subscribe: () => socket,
    history: async () => ({ events: [], next_from: 0 }),
    killSession: async () => undefined,
  } as unknown as KodeClient
  return { kode, calls }
}

function buildExecutionRuntimeMock(): {
  runtime: SpecOpsExecutionRuntime
  calls: { start: number; prompt: number }
} {
  const calls = { start: 0, prompt: 0 }
  const pending: Array<(outcome: ExecutionRequestOutcome<ExecutionTurnResult>) => void> = []
  const identity = {
    execution_id: 'clarify-execution',
    transport: 'codebuddy_acp' as const,
    backend_key: 'codebuddy',
    native_session_id: 'clarify-native-session',
    process_generation: 1,
  }
  const attach = async (input: { workspace: string; sessionId: string }) => {
    await updateSpecOpsSession(input.workspace, input.sessionId, (record) => {
      record.current_execution = identity
      record.state = 'active'
    })
    return identity
  }
  const runtime = {
    start: async (input: { workspace: string; sessionId: string }) => { calls.start += 1; return attach(input) },
    load: async (input: { workspace: string; sessionId: string }) => attach(input),
    prompt: () => {
      calls.prompt += 1
      return new Promise<ExecutionRequestOutcome<ExecutionTurnResult>>((resolve) => pending.push(resolve))
    },
    respond: async () => ({ outcome: 'completed' as const, value: undefined }),
    cancel: async () => ({ outcome: 'completed' as const, value: undefined }),
    close: async () => undefined,
    get: () => identity,
    shutdown: async () => {
      for (const resolve of pending.splice(0)) {
        resolve({ outcome: 'completed', value: { turnId: 'shutdown' } })
      }
    },
  } satisfies SpecOpsExecutionRuntime
  return { runtime, calls }
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
  const { kode, calls: legacyCalls } = buildKodePlanMock()
  const { runtime, calls: runtimeCalls } = buildExecutionRuntimeMock()
  const server = await startServer({ workspace, token: 'ask-token', kodeClient: kode, executionRuntime: runtime })
  servers.push(server)
  return { workspace, server, legacyCalls, runtimeCalls }
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
    const { server, legacyCalls, runtimeCalls } = await fixture()
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
    expect(runtimeCalls).toEqual({ start: 1, prompt: 2 })
    expect(legacyCalls).toEqual({ createPlanSession: 0, sendPrompt: 0 })
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

  test('gates clarify and pre-plan by effective structured capabilities', async () => {
    const { server, runtimeCalls } = await fixture()
    const clarify = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'clarify with codex', backend_key: 'codex' }),
    }))
    expect(clarify.status).toBe(201)

    const prePlan = await fetch(`${server.origin}/api/intakes`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'pre-plan with codex', backend_key: 'codex', pre_plan: true }),
    }))
    expect(prePlan.status).toBe(201)
    expect(runtimeCalls).toEqual({ start: 2, prompt: 2 })

    const claude = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'clarify with claude', backend_key: 'claude' }),
    }))
    expect(claude.status).toBe(201)
    expect(runtimeCalls).toEqual({ start: 3, prompt: 3 })
  })
})
