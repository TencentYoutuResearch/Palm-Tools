import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import { startServer, type ServeHandle, type ServeOptions, type SpecOpsExecutionRuntime } from '../src/server/index.js'
import { cleanupRun, createRun, readRun, transitionRun } from '../src/domain/run.js'
import { attachSessionAgent, createSpecOpsSession, readSpecOpsSession, updateSpecOpsSession } from '../src/domain/session.js'
import { enqueueInteraction } from '../src/domain/interactions.js'
import { parseDocument } from '../src/domain/spec.js'
import { exists } from '../src/store/workspace.js'
import type { KodeClient, KodeSession } from '../src/adapters/kode.js'
import type { ExecutionIdentity } from '../src/domain/session.js'
import type { ExecutionPromptInput, ExecutionRequestOutcome, ExecutionResponse, ExecutionTurnResult } from '../src/execution/types.js'
import { gitCommit, gitWorkspace } from './helpers.js'

const cleanup: string[] = []
const servers: ServeHandle[] = []

type RuntimeStartInput = Parameters<SpecOpsExecutionRuntime['start']>[0]
type RuntimeLoadInput = Parameters<SpecOpsExecutionRuntime['load']>[0]
type RuntimePromptHook = (call: { executionId: string; input: ExecutionPromptInput; binding: RuntimeStartInput }) => void | Promise<void>

class FakeExecutionRuntime implements SpecOpsExecutionRuntime {
  readonly starts: RuntimeStartInput[] = []
  readonly loads: RuntimeLoadInput[] = []
  readonly prompts: Array<{ executionId: string; input: ExecutionPromptInput }> = []
  readonly responses: Array<{ executionId: string; input: ExecutionResponse }> = []
  readonly cancellations: string[] = []
  readonly closed: string[] = []
  shutdownCount = 0

  private readonly executions = new Map<string, { identity: ExecutionIdentity; binding: RuntimeStartInput }>()
  private readonly pending = new Set<(outcome: ExecutionRequestOutcome<ExecutionTurnResult>) => void>()
  private nextId = 1
  private shutdownPromise: Promise<void> | undefined

  constructor(private readonly onPrompt?: RuntimePromptHook) {}

  async start(input: RuntimeStartInput): Promise<ExecutionIdentity> {
    this.starts.push(input)
    const id = `execution-${this.nextId++}`
    const identity: ExecutionIdentity = {
      execution_id: id,
      transport: 'codebuddy_acp',
      backend_key: input.backendKey,
      native_session_id: `native-${id}`,
      process_generation: 1,
    }
    await this.bind(input, identity)
    return identity
  }

  async load(input: RuntimeLoadInput): Promise<ExecutionIdentity> {
    this.loads.push(input)
    const identity: ExecutionIdentity = {
      execution_id: input.executionId,
      transport: 'codebuddy_acp',
      backend_key: input.backendKey,
      native_session_id: input.nativeSessionId,
      process_generation: (this.executions.get(input.executionId)?.identity.process_generation ?? 0) + 1,
    }
    await this.bind(input, identity)
    return identity
  }

  async prompt(executionId: string, input: ExecutionPromptInput): Promise<ExecutionRequestOutcome<ExecutionTurnResult>> {
    const execution = this.executions.get(executionId)
    if (execution === undefined) throw new Error(`Unknown fake execution: ${executionId}`)
    this.prompts.push({ executionId, input })
    await this.onPrompt?.({ executionId, input, binding: execution.binding })
    if (input.metadata?.purpose !== 'implement' && input.metadata?.purpose !== 'repair') {
      return { outcome: 'completed', value: { turnId: input.requestId, stopReason: 'end_turn' } }
    }
    return new Promise((resolve) => this.pending.add(resolve))
  }

  async respond(executionId: string, input: ExecutionResponse) {
    this.responses.push({ executionId, input })
    return { outcome: 'completed' as const, value: undefined }
  }

  async cancel(executionId: string) {
    this.cancellations.push(executionId)
    return { outcome: 'completed' as const, value: undefined }
  }

  async close(executionId: string): Promise<void> {
    const execution = this.executions.get(executionId)
    if (execution === undefined) return
    this.executions.delete(executionId)
    this.closed.push(executionId)
    await updateSpecOpsSession(execution.binding.workspace, execution.binding.sessionId, (record) => {
      if (record.current_execution?.execution_id === executionId) record.current_execution = null
      const agent = record.agents.find((item) => item.execution_id === executionId)
      if (agent !== undefined) {
        agent.status = 'closed'
        agent.ended_at ??= new Date().toISOString()
      }
    }).catch(() => undefined)
  }

  get(executionOrSessionId: string): ExecutionIdentity | undefined {
    const direct = this.executions.get(executionOrSessionId)?.identity
    if (direct !== undefined) return direct
    return [...this.executions.values()].find((item) => item.binding.sessionId === executionOrSessionId)?.identity
  }

  drop(executionId: string): void {
    this.executions.delete(executionId)
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise
    this.shutdownCount += 1
    this.shutdownPromise = (async () => {
      const outcome = { outcome: 'completed' as const, value: { stopReason: 'shutdown' } }
      for (const resolve of this.pending) resolve(outcome)
      this.pending.clear()
      await Promise.all([...this.executions.keys()].map((id) => this.close(id)))
    })()
    return this.shutdownPromise
  }

  private async bind(input: RuntimeStartInput, identity: ExecutionIdentity): Promise<void> {
    this.executions.set(identity.execution_id, { identity, binding: input })
    await updateSpecOpsSession(input.workspace, input.sessionId, (record) => {
      const now = new Date().toISOString()
      for (const agent of record.agents) {
        if (agent.execution_id === identity.execution_id || agent.ended_at !== null) continue
        agent.status = 'replaced'
        agent.ended_at = now
      }
      record.current_execution = identity
      record.backend_key = identity.backend_key
      record.kode_session_id = null
      record.state = 'active'
      const existing = record.agents.find((item) => item.execution_id === identity.execution_id)
      if (existing !== undefined) {
        existing.native_session_id = identity.native_session_id
        existing.process_generation = identity.process_generation
        existing.purpose = input.purpose
        existing.status = 'ready'
        existing.ended_at = null
      } else {
        record.agents.push({
          execution_id: identity.execution_id,
          transport: identity.transport,
          native_session_id: identity.native_session_id,
          process_generation: identity.process_generation,
          kode_session_id: null,
          session_uuid: identity.native_session_id,
          backend_key: identity.backend_key,
          model: input.model ?? null,
          purpose: input.purpose,
          status: 'ready',
          started_at: now,
          ended_at: null,
          transcript_cursor: 0,
        })
      }
    })
  }
}

async function startTestServer(options: ServeOptions, runtime = new FakeExecutionRuntime()): Promise<ServeHandle> {
  const server = await startServer({ ...options, executionRuntime: runtime })
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

async function fixture() {
  const workspace = await gitWorkspace()
  cleanup.push(workspace)
  await initWorkspace(workspace)
  const server = await startTestServer({ workspace, token: 'test-token' })
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

describe('SpecOps server', () => {
  test('health is public and state requires a token', async () => {
    const { server } = await fixture()
    expect((await fetch(`${server.origin}/healthz`)).status).toBe(200)
    expect((await fetch(`${server.origin}/api/state`)).status).toBe(401)
    expect((await fetch(`${server.origin}/api/state`, auth(server))).status).toBe(200)
  })

  test('exposes declarative Harness profiles and plugin capabilities', async () => {
    const { server } = await fixture()
    const response = await fetch(`${server.origin}/api/harness`, auth(server))
    expect(response.status).toBe(200)
    const body = await response.json() as {
      project: { name: string; profiles: string[] }
      workflows: { feature: { stages: string[] } }
      known_capabilities: string[]
      plugins: unknown[]
    }
    expect(body.project.profiles).toEqual([])
    expect(body.workflows.feature.stages).toContain('verify')
    expect(body.known_capabilities).toContain('conversation.ask')
    expect(body.plugins).toEqual([])
  })

  test('reads and writes visual agent profiles using available Kode backends', async () => {
    const workspace = await gitWorkspace(); cleanup.push(workspace)
    await initWorkspace(workspace)
    const socket = { on: () => socket, close: () => undefined }
    const kode = {
      listBackends: async () => [
        { key: 'codebuddy', display_name: 'CodeBuddy', model_flag: '--model', enabled: true },
        { key: 'codex', display_name: 'Codex', model_flag: '--model', enabled: true },
      ],
      subscribe: () => socket,
      history: async () => ({ events: [], next_from: 0 }),
    } as unknown as KodeClient
    const server = await startTestServer({ workspace, token: 'test-token', kodeClient: kode })
    const loaded = await fetch(`${server.origin}/api/settings/agents`, auth(server))
    expect(loaded.status).toBe(200)
    expect((await loaded.json() as { backends: Array<{ key: string }> }).backends.map((item) => item.key)).toEqual(['codebuddy', 'codex'])
    const avatars = await fetch(`${server.origin}/api/settings/avatars`, auth(server))
    expect(avatars.status).toBe(200)
    expect((await avatars.json() as { gallery: unknown[] }).gallery).toBeInstanceOf(Array)

    const saved = await fetch(`${server.origin}/api/settings/agents`, auth(server, {
      method: 'PUT',
      body: JSON.stringify({ profiles: {
        default: { backend: 'codebuddy' }, analysis: {},
        implementation: { backend: 'codex', model: 'gpt-5-codex', avatar: 'gallery/robot' }, review: {},
      } }),
    }))
    expect(saved.status).toBe(200)
    const config = await readFile(path.join(workspace, 'specops.toml'), 'utf8')
    expect(config).toContain('[agents.implementation]\nbackend = "codex"\nmodel = "gpt-5-codex"\navatar = "gallery/robot"')

    const invalid = await fetch(`${server.origin}/api/settings/agents`, auth(server, {
      method: 'PUT',
      body: JSON.stringify({ profiles: {
        default: { backend: 'missing' }, analysis: {}, implementation: {}, review: {},
      } }),
    }))
    expect(invalid.status).toBe(400)
  })

  test('serves cached backend model discovery and supports explicit refresh', async () => {
    const workspace = await gitWorkspace(); cleanup.push(workspace)
    await initWorkspace(workspace)
    let calls = 0
    const modelDiscovery = {
      discover: async (backend: string, refresh = false) => {
        calls += 1
        return {
          backend, source: 'codex-app-server' as const, version: refresh ? '2-refresh' : '2', custom_allowed: true,
          models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', is_default: true }],
        }
      },
    }
    const server = await startTestServer({ workspace, token: 'test-token', modelDiscovery })
    const loaded = await fetch(`${server.origin}/api/settings/models/codex`, auth(server))
    expect(loaded.status).toBe(200)
    expect(await loaded.json()).toMatchObject({ backend: 'codex', models: [{ id: 'gpt-5.6-sol' }] })
    const refreshed = await fetch(`${server.origin}/api/settings/models/codex?refresh=1`, auth(server))
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toMatchObject({ version: '2-refresh' })
    expect(calls).toBe(2)
  })

  test('returns a structured model discovery failure without breaking settings', async () => {
    const workspace = await gitWorkspace(); cleanup.push(workspace)
    await initWorkspace(workspace)
    const server = await startTestServer({
      workspace, token: 'test-token',
      modelDiscovery: { discover: async () => { throw new Error('backend probe unavailable') } },
    })
    const response = await fetch(`${server.origin}/api/settings/models/claude`, auth(server))
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'model_discovery_failed', backend: 'claude', detail: 'backend probe unavailable',
    })
    expect((await fetch(`${server.origin}/api/settings/agents`, auth(server))).status).toBe(200)
  })

  test('rejects a wrong origin', async () => {
    const { server } = await fixture()
    const response = await fetch(`${server.origin}/api/state`, auth(server, { headers: { origin: 'https://attacker.invalid' } }))
    expect(response.status).toBe(403)
  })

  test('rejects opaque and cross-site browser origins', async () => {
    const { server } = await fixture()
    const opaque = await fetch(`${server.origin}/api/state`, auth(server, {
      headers: { origin: 'null' },
    }))
    expect(opaque.status).toBe(403)

    const crossSite = await fetch(`${server.origin}/api/state`, auth(server, {
      headers: { origin: server.origin, 'sec-fetch-site': 'cross-site' },
    }))
    expect(crossSite.status).toBe(403)
  })

  test('edits documents with optimistic concurrency', async () => {
    const { server } = await fixture()
    const relativePath = '.specops/specs/project-overview.md'
    const loaded = await (await fetch(`${server.origin}/api/document?path=${encodeURIComponent(relativePath)}`, auth(server))).json() as { content: string; version: string }
    const changed = loaded.content.replace('status: draft', 'status: active')
    const first = await fetch(`${server.origin}/api/document`, auth(server, {
      method: 'PUT',
      body: JSON.stringify({ path: relativePath, content: changed, version: loaded.version }),
    }))
    expect(first.status).toBe(200)
    const conflict = await fetch(`${server.origin}/api/document`, auth(server, {
      method: 'PUT',
      body: JSON.stringify({ path: relativePath, content: loaded.content, version: loaded.version }),
    }))
    expect(conflict.status).toBe(409)
  })

  test('deprecates a spec and closes its active agent sessions', async () => {
    const workspace = await gitWorkspace(); cleanup.push(workspace)
    await initWorkspace(workspace)
    const killed: number[] = []
    const socket = { on: () => socket, close: () => undefined }
    const kode = {
      killSession: async (id: number) => { killed.push(id) },
      subscribe: () => socket,
      history: async () => ({ events: [], next_from: 0 }),
    } as unknown as KodeClient
    const session = await createSpecOpsSession(workspace, {
      title: 'Overview review', backend_key: 'codebuddy', kode_session_id: 91,
      document_path: '.specops/specs/project-overview.md', phase: 'clarify', state: 'active',
      agents: [{ kode_session_id: 91, session_uuid: null, backend_key: 'codebuddy', model: null, purpose: 'clarify', status: 'running', started_at: new Date().toISOString(), ended_at: null, transcript_cursor: 0 }],
    })
    const server = await startTestServer({ workspace, token: 'test-token', kodeClient: kode })
    const response = await fetch(`${server.origin}/api/document/deprecate`, auth(server, {
      method: 'POST', body: JSON.stringify({ path: '.specops/specs/project-overview.md' }),
    }))
    expect(response.status).toBe(200)
    expect((await response.json() as { closed_sessions: string[] }).closed_sessions).toContain(session.id)
    expect(killed).toEqual([91])
    expect((await readSpecOpsSession(workspace, session.id)).state).toBe('closed')
    const document = parseDocument(await readFile(path.join(workspace, '.specops/specs/project-overview.md'), 'utf8'), 'project-overview.md')
    expect(document.frontmatter.status).toBe('deprecated')
    expect(document.frontmatter.schema_version).toBe(2)
  })

  test('rejects document traversal', async () => {
    const { server } = await fixture()
    const response = await fetch(`${server.origin}/api/document?path=${encodeURIComponent('../outside.md')}`, auth(server))
    expect(response.status).toBe(400)
  })

  test('persists structured answers and plan reviews in the session decision ledger', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const session = await createSpecOpsSession(workspace, {
      title: 'Decision ledger',
      backend_key: 'codebuddy',
      phase: 'clarify',
      state: 'awaiting_user',
      required_action: {
        kind: 'answer',
        question_id: 'question-1',
        prompt: 'Which compatibility target should win?',
        options: [{ label: 'macOS and Linux' }, { label: 'All platforms' }],
        questions: [
          { question_id: 'question-1', prompt: 'Which compatibility target should win?', options: [{ label: 'macOS and Linux' }, { label: 'All platforms' }], multi_select: true },
          { question_id: 'question-2', prompt: 'Which release mode?', options: [{ label: 'Gradual' }, { label: 'Immediate' }] },
        ],
      },
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)
    const identity = await runtime.start({
      workspace, sessionId: session.id, purpose: 'clarify', backendKey: 'codebuddy', cwd: workspace,
    })

    const invalidAnswer = await fetch(`${server.origin}/api/sessions/${session.id}/answer`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ answers: [
        { question_id: 'question-1', choice_indices: [0, 99] },
        { question_id: 'question-2', choice_index: 1 },
      ] }),
    }))
    expect(invalidAnswer.status).toBe(400)
    expect(runtime.responses).toHaveLength(0)

    const answered = await fetch(`${server.origin}/api/sessions/${session.id}/answer`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ answers: [
        { question_id: 'question-1', choice_indices: [0, 1], label: 'forged client label' },
        { question_id: 'question-2', choice_index: 1, label: 'forged client label' },
      ] }),
    }))
    expect(answered.status).toBe(200)
    expect(runtime.responses.at(-1)).toMatchObject({
      executionId: identity.execution_id,
      input: {
        kind: 'questions',
        answers: {
          'question-1': ['macOS and Linux', 'All platforms'],
          'question-2': 'Immediate',
        },
      },
    })

    await updateSpecOpsSession(workspace, session.id, (record) => {
      enqueueInteraction(record, {
        kind: 'permission',
        source: 'agent',
        idempotency_key: 'decision-ledger:permission-1',
        payload: {
          request_id: 'permission-1',
          title: 'Run tests',
          message: 'pnpm test',
          options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
        },
      })
      record.state = 'awaiting_user'
    })
    const permission = await fetch(`${server.origin}/api/sessions/${session.id}/action`, auth(server, {
      method: 'POST', body: JSON.stringify({ kind: 'permission_allow' }),
    }))
    expect(permission.status).toBe(200)
    expect((await permission.json() as { session: { required_action: unknown; state: string } }).session).toMatchObject({
      required_action: null,
      state: 'active',
    })
    expect(runtime.responses.at(-1)).toMatchObject({
      executionId: identity.execution_id,
      input: { kind: 'permission', requestId: 'permission-1', decision: 'allow', remember: false },
    })

    await updateSpecOpsSession(workspace, session.id, (record) => {
      enqueueInteraction(record, {
        kind: 'plan_review',
        source: 'agent',
        idempotency_key: 'decision-ledger:plan-1',
        payload: {
          request_id: 'plan-request-1',
          plan_id: 'plan-1',
          markdown: '# Approved plan',
          generation: 1,
        },
      })
      record.state = 'awaiting_user'
    })
    const approved = await fetch(`${server.origin}/api/sessions/${session.id}/plan_response`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ plan_id: 'plan-1', accept: true, note: 'Keep the scope narrow.' }),
    }))
    expect(approved.status).toBe(200)

    const detail = await (await fetch(`${server.origin}/api/sessions/${session.id}`, auth(server))).json() as {
      session: {
        decisions: Array<{ id: string; outcome: string; prompt: string; selections: string[]; note: string | null }>
        clarification: { approved_plan: { plan_id: string; markdown: string } | null }
        interactions: Array<{ kind: string; status: string }>
      }
    }
    expect(runtime.responses.map((call) => call.input.kind)).toEqual(['questions', 'permission', 'plan'])
    expect(detail.session.clarification.approved_plan).toMatchObject({ plan_id: 'plan-1', markdown: '# Approved plan' })
    expect(detail.session.interactions.at(-1)).toMatchObject({ kind: 'start_intake', status: 'pending' })
    expect(detail.session.decisions).toEqual([
      {
        id: 'question-1',
        outcome: 'answered',
        prompt: 'Which compatibility target should win?',
        selections: ['macOS and Linux', 'All platforms'],
        note: null,
        kind: 'answer',
        source: 'user',
        execution_id: identity.execution_id,
        kode_session_id: null,
        at: expect.any(String),
      },
      {
        id: 'question-2',
        outcome: 'answered',
        prompt: 'Which release mode?',
        selections: ['Immediate'],
        note: null,
        kind: 'answer',
        source: 'user',
        execution_id: identity.execution_id,
        kode_session_id: null,
        at: expect.any(String),
      },
      {
        id: 'plan-1',
        outcome: 'approved',
        prompt: '# Approved plan',
        selections: ['Approve plan'],
        note: 'Keep the scope narrow.',
        kind: 'plan_review',
        source: 'user',
        execution_id: identity.execution_id,
        kode_session_id: null,
        at: expect.any(String),
      },
    ])
  })

  test('delivers fallback questions through a follow-up prompt and orphans guessed plans', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const session = await createSpecOpsSession(workspace, {
      title: 'Prompt fallback', backend_key: 'codebuddy', phase: 'clarify', state: 'active',
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)
    await runtime.start({
      workspace, sessionId: session.id, purpose: 'clarify', backendKey: 'codebuddy', cwd: workspace,
    })
    await updateSpecOpsSession(workspace, session.id, (record) => {
      enqueueInteraction(record, {
        kind: 'questions', source: 'agent', idempotency_key: 'fallback:questions',
        payload: {
          request_id: 'failed-tool-call', prompt: 'Framework?', response_mode: 'prompt',
          questions: [{
            id: 'framework', prompt: 'Framework?', multi_select: false,
            options: [{ id: 'svelte', label: 'Svelte' }, { id: 'react', label: 'React' }],
          }],
        },
      })
      enqueueInteraction(record, {
        kind: 'plan_review', source: 'agent', idempotency_key: 'fallback:guessed-plan',
        payload: {
          request_id: 'guessed-plan', plan_id: 'guessed-plan', markdown: '# Guessed plan', generation: 1,
          response_mode: 'prompt',
        },
      })
      record.state = 'awaiting_user'
    })

    const answered = await fetch(`${server.origin}/api/sessions/${session.id}/answer`, auth(server, {
      method: 'POST', body: JSON.stringify({ answers: [{ question_id: 'framework', choice_index: 0 }] }),
    }))
    expect(answered.status).toBe(200)
    expect(runtime.responses).toHaveLength(0)
    expect(runtime.prompts.at(-1)?.input).toMatchObject({ metadata: { purpose: 'question_answers' } })
    expect(runtime.prompts.at(-1)?.input.text).toContain('Answer: Svelte')
    const updated = await readSpecOpsSession(workspace, session.id)
    expect(updated.interactions?.map((interaction) => ({ kind: interaction.kind, status: interaction.status }))).toEqual([
      { kind: 'questions', status: 'resolved' },
      { kind: 'plan_review', status: 'orphaned' },
    ])
    expect(updated.required_action).toBeNull()
  })

  test('promotes only the durable start_intake interaction created by plan approval', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const session = await createSpecOpsSession(workspace, {
      title: 'Durable promotion', backend_key: 'codebuddy', phase: 'clarify', state: 'active',
      transcript: [{ role: 'user', text: 'Build durable promotion', at: new Date().toISOString() }],
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)
    const original = await runtime.start({
      workspace, sessionId: session.id, purpose: 'clarify', backendKey: 'codebuddy', cwd: workspace,
    })
    await updateSpecOpsSession(workspace, session.id, (record) => {
      enqueueInteraction(record, {
        kind: 'plan_review',
        source: 'agent',
        idempotency_key: 'durable-promotion:plan',
        payload: {
          request_id: 'durable-plan-request',
          plan_id: 'durable-plan',
          markdown: '# Durable plan\n\nCreate the intake from persisted state.',
          generation: original.process_generation,
        },
      })
      record.state = 'awaiting_user'
    })

    const approved = await fetch(`${server.origin}/api/sessions/${session.id}/plan_response`, auth(server, {
      method: 'POST', body: JSON.stringify({ plan_id: 'durable-plan', accept: true }),
    }))
    expect(approved.status).toBe(200)
    const ready = await readSpecOpsSession(workspace, session.id)
    const startIntake = ready.interactions?.find((interaction) => interaction.kind === 'start_intake')
    expect(startIntake).toMatchObject({
      kind: 'start_intake',
      status: 'pending',
      payload: { plan_id: 'durable-plan' },
    })
    expect(ready.required_action).toMatchObject({
      kind: 'promote_intake', interaction_id: startIntake?.id,
    })

    const promoted = await fetch(`${server.origin}/api/sessions/${session.id}/action`, auth(server, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'promote_intake',
        interaction_id: startIntake?.id,
        expected_updated_at: startIntake?.updated_at,
      }),
    }))
    expect(promoted.status).toBe(201)
    const durable = await readSpecOpsSession(workspace, session.id)
    expect(durable).toMatchObject({
      phase: 'analyze_request',
      state: 'active',
      intake_receipt_id: startIntake?.payload.receipt_id,
      required_action: null,
    })
    expect(durable.interactions?.find((interaction) => interaction.id === startIntake?.id)).toMatchObject({
      status: 'resolved',
      response: { promoted: true, receipt_id: startIntake?.payload.receipt_id },
    })
    expect(runtime.starts).toHaveLength(2)
    expect(runtime.prompts.at(-1)?.input.text).toContain('# Durable plan')
  })

  test('starts Codex Clarify with SpecOps-owned plan review', async () => {
    const { server } = await fixture()
    const response = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'Clarify this request', backend_key: 'codex' }),
    }))
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      specops_session: { backend_key: 'codex' },
      session: { backend_key: 'codex' },
    })
  })

  test('blocks freeform input while a durable interaction is pending', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const session = await createSpecOpsSession(workspace, {
      title: 'Blocked input', backend_key: 'codebuddy', phase: 'clarify', state: 'active',
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)
    await runtime.start({
      workspace, sessionId: session.id, purpose: 'clarify', backendKey: 'codebuddy', cwd: workspace,
    })
    await updateSpecOpsSession(workspace, session.id, (record) => {
      enqueueInteraction(record, {
        kind: 'permission',
        source: 'agent',
        idempotency_key: 'blocked-input:permission',
        payload: {
          request_id: 'blocked-permission',
          title: 'Permission required',
          message: 'Allow the command?',
          options: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
        },
      })
      record.state = 'awaiting_user'
    })

    const response = await fetch(`${server.origin}/api/sessions/${session.id}/input`, auth(server, {
      method: 'POST', body: JSON.stringify({ text: 'Ignore the pending action.' }),
    }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: 'action_required', required_action: { kind: 'permission', request_id: 'blocked-permission' },
    })
    expect(runtime.prompts).toEqual([])
  })

  test('does not reuse a stale runtime session alias when durable execution is detached', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const documentPath = '.specops/changes/stale-runtime'
    const session = await createSpecOpsSession(workspace, {
      title: 'Stale runtime', backend_key: 'codebuddy', document_path: documentPath,
      phase: 'clarify', state: 'active',
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)
    const stale = await runtime.start({
      workspace, sessionId: session.id, purpose: 'clarify', backendKey: 'codebuddy', cwd: workspace,
    })
    await updateSpecOpsSession(workspace, session.id, (record) => {
      record.current_execution = null
      record.state = 'active'
    })
    expect(runtime.get(stale.execution_id)).toEqual(stale)
    expect(runtime.get(session.id)).toEqual(stale)

    const response = await fetch(`${server.origin}/api/clarifies`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'Continue from durable state', document_path: documentPath }),
    }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'resume_required' })
    expect(runtime.prompts).toEqual([])
  })

  test('creates every document kind in its canonical directory without overwriting', async () => {
    const { workspace, server } = await fixture()
    const cases = [
      { kind: 'spec', directory: 'specs', id: 'feature/create-spec' },
      { kind: 'change', directory: 'changes', id: 'feature/create-change' },
    ] as const

    for (const item of cases) {
      const relativePath = `.specops/${item.directory}/${item.id}.md`
      const content = `---\nschema_version: 1\nid: ${item.id}\nkind: ${item.kind}\ntitle: Created ${item.kind}\nstatus: draft\nverifies: []\npaths: []\n---\n`
      const created = await fetch(`${server.origin}/api/document`, auth(server, {
        method: 'POST',
        body: JSON.stringify({ path: relativePath, content }),
      }))
      expect(created.status).toBe(201)
      expect(await readFile(path.join(workspace, relativePath), 'utf8')).toBe(content)

      const duplicate = await fetch(`${server.origin}/api/document`, auth(server, {
        method: 'POST',
        body: JSON.stringify({ path: relativePath, content: content.replace('Created', 'Overwritten') }),
      }))
      expect(duplicate.status).toBe(409)
      expect(await readFile(path.join(workspace, relativePath), 'utf8')).toBe(content)
    }
  })

  test('runs the verify, decision, and explicit apply workflow', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const server = await startTestServer({ workspace, token: 'test-token', runCacheRoot: cache })

    const createdResponse = await fetch(`${server.origin}/api/runs`, auth(server, {
      method: 'POST',
      body: JSON.stringify({
        backend_key: 'codebuddy',
        tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
      }),
    }))
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { run: { run_id: string; worktree_path: string } }
    await writeFile(path.join(created.run.worktree_path, 'result.txt'), 'verified\n')
    const prematureVerify = await fetch(`${server.origin}/api/runs/${created.run.run_id}/verify`, auth(server, { method: 'POST' }))
    expect(prematureVerify.status).toBe(409)
    await transitionRun(await readRun(workspace, created.run.run_id), 'awaiting_verify')

    const verified = await fetch(`${server.origin}/api/runs/${created.run.run_id}/verify`, auth(server, { method: 'POST' }))
    expect(verified.status).toBe(200)
    const accepted = await fetch(`${server.origin}/api/runs/${created.run.run_id}/decision`, auth(server, {
      method: 'POST', body: JSON.stringify({ verdict: 'accept', note: 'Reviewed' }),
    }))
    expect((await accepted.json() as { run: { state: string } }).run.state).toBe('completed')
    expect(await readFile(path.join(workspace, 'result.txt'), 'utf8').catch(() => '')).toBe('')
    const applied = await fetch(`${server.origin}/api/runs/${created.run.run_id}/apply`, auth(server, { method: 'POST' }))
    expect(applied.status).toBe(200)
    expect(await readFile(path.join(workspace, 'result.txt'), 'utf8')).toBe('verified\n')
    await cleanupRun(await readRun(workspace, created.run.run_id))
  })

  test('document launch resolves change_id from proposal when the client omits it', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    const changeId = 'feature/linked-document-run'
    const changeDir = path.join(workspace, '.specops', 'changes', changeId)
    await mkdir(changeDir, { recursive: true })
    await writeFile(path.join(changeDir, 'proposal.md'), [
      '---', 'schema_version: 2', `id: ${changeId}`, 'kind: feature', 'document_class: work_item',
      'work_type: feature', 'title: Linked document run', 'status: proposed', 'targets: []', '---',
      '# Linked document run', '## Motivation', 'Keep the run linked.', '## Scope', 'Test linkage.',
      '## Acceptance criteria', '- [ ] Run is linked', '## Out of scope', 'Other behavior.', '',
    ].join('\n'))
    await gitCommit(workspace, 'Add linked proposal\n\nFeature: LINK-1')
    const server = await startTestServer({ workspace, token: 'test-token', runCacheRoot: cache })

    const response = await fetch(`${server.origin}/api/runs`, auth(server, {
      method: 'POST',
      body: JSON.stringify({
        backend_key: 'codebuddy',
        document_path: `.specops/changes/${changeId}`,
        tasks: [{ id: 'task-1', title: 'Finish linkage', prompt: 'Finish linkage', verify: [] }],
      }),
    }))
    expect(response.status).toBe(201)
    const created = await response.json() as { run: { run_id: string; change_id: string | null } }
    expect(created.run.change_id).toBe(changeId)
    expect((await readRun(workspace, created.run.run_id)).change_id).toBe(changeId)
    await cleanupRun(await readRun(workspace, created.run.run_id))
  })

  test('quick-run creates a document and launches a run in one call', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const server = await startTestServer({ workspace, token: 'test-token', runCacheRoot: cache })

    const response = await fetch(`${server.origin}/api/quick-run`, auth(server, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'change',
        id: 'test-quick-run',
        title: 'Test quick run',
        body: 'Testing the quick run endpoint',
        backend_key: 'codebuddy',
        tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
      }),
    }))
    expect(response.status).toBe(201)
    const result = await response.json() as { document: { path: string }; run: { run_id: string; state: string; worktree_path: string } }
    expect(result.document.path).toBe('.specops/changes/test-quick-run.md')
    expect(result.run.state).toBe('running')
    expect(await exists(path.join(workspace, '.specops', 'changes', 'test-quick-run.md'))).toBe(true)

    await writeFile(path.join(result.run.worktree_path, 'result.txt'), 'verified\n')
    await transitionRun(await readRun(workspace, result.run.run_id), 'awaiting_verify')
    const verified = await fetch(`${server.origin}/api/runs/${result.run.run_id}/verify`, auth(server, { method: 'POST' }))
    expect(verified.status).toBe(200)
    const accepted = await fetch(`${server.origin}/api/runs/${result.run.run_id}/decision`, auth(server, {
      method: 'POST', body: JSON.stringify({ verdict: 'accept', note: 'Reviewed' }),
    }))
    expect((await accepted.json() as { run: { state: string } }).run.state).toBe('completed')
    await cleanupRun(await readRun(workspace, result.run.run_id))
  })

  test('session list reconciles a run that reached review while the server was down', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const server = await startTestServer({ workspace, token: 'test-token', runCacheRoot: cache })

    const createdResponse = await fetch(`${server.origin}/api/runs`, auth(server, {
      method: 'POST',
      body: JSON.stringify({
        backend_key: 'codebuddy',
        tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
      }),
    }))
    const created = await createdResponse.json() as {
      run: { run_id: string; worktree_path: string }
      specops_session: { id: string }
    }
    await writeFile(path.join(created.run.worktree_path, 'result.txt'), 'verified\n')
    await transitionRun(await readRun(workspace, created.run.run_id), 'awaiting_verify')
    const verified = await fetch(`${server.origin}/api/runs/${created.run.run_id}/verify`, auth(server, { method: 'POST' }))
    expect(verified.status).toBe(200)

    await updateSpecOpsSession(workspace, created.specops_session.id, (record) => {
      record.phase = 'run_in_worktree'
      record.state = 'active'
      record.required_action = null
    })

    const listed = await fetch(`${server.origin}/api/sessions`, auth(server))
    expect(listed.status).toBe(200)
    const body = await listed.json() as {
      sessions: Array<{ id: string; phase: string; state: string; required_action?: { kind: string; patch_files?: string[] } | null }>
    }
    const session = body.sessions.find((item) => item.id === created.specops_session.id)
    expect(session?.phase).toBe('review')
    expect(session?.state).toBe('awaiting_user')
    expect(session?.required_action?.kind).toBe('review')
    expect(session?.required_action?.patch_files).toContain('result.txt')
    await cleanupRun(await readRun(workspace, created.run.run_id))
  })

  test('session reconciliation clears a stale monitor-missing resume when execution is live', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Implement feature', prompt: 'Implement it', verify: [] }],
      'codebuddy', 'HEAD', cache,
    )
    const session = await createSpecOpsSession(workspace, {
      title: 'Live run', backend_key: 'codebuddy', run_id: run.run_id, phase: 'run_in_worktree', state: 'awaiting_user',
    })
    await updateSpecOpsSession(workspace, session.id, (record) => {
      record.execution.last_error = 'Running Run has no live stage monitor/execution; explicit resume is required.'
      enqueueInteraction(record, {
        kind: 'resume', source: 'reconciliation', idempotency_key: `resume:${run.run_id}:task-1:0:monitor_missing`,
        payload: { reason: 'run_monitor_missing', prompt: 'Resume task-1.' },
      })
    })
    const runtime = new FakeExecutionRuntime()
    const identity = await runtime.start({
      workspace, sessionId: session.id, runId: run.run_id, purpose: 'implement', backendKey: 'codebuddy', cwd: run.worktree_path,
    })
    await updateSpecOpsSession(workspace, session.id, (record) => {
      const agent = record.agents.find((item) => item.execution_id === identity.execution_id)
      if (agent !== undefined) agent.status = 'running'
    })
    const server = await startTestServer({ workspace, token: 'test-token', runCacheRoot: cache }, runtime)

    expect((await fetch(`${server.origin}/api/sessions`, auth(server))).status).toBe(200)
    const reconciled = await readSpecOpsSession(workspace, session.id)
    expect(reconciled.state).toBe('active')
    expect(reconciled.required_action).toBeNull()
    expect(reconciled.execution.last_error).toBeNull()
    expect(reconciled.interactions?.find((item) => item.kind === 'resume')).toMatchObject({
      status: 'cancelled', response: { reason: 'monitor_restored' },
    })
    await cleanupRun(run)
  })

  test('session list recovers a failed intake when its completed receipt exists', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const changeId = 'recover-completed-intake'
    const changeDir = path.join(workspace, '.specops', 'changes', changeId)
    await mkdir(changeDir, { recursive: true })
    await writeFile(path.join(changeDir, 'proposal.md'), [
      '---', 'schema_version: 2', `id: ${changeId}`, 'kind: bug', 'document_class: work_item',
      'work_type: bugfix', 'title: Recover completed intake', 'status: proposed', 'targets: [specops/intake]', '---',
      '# Recover completed intake', '## Motivation', 'Recover it.', '## Scope', 'Session recovery.',
      '## Acceptance criteria', '- [ ] Recovered', '## Out of scope', 'Other flows.', '',
    ].join('\n'))
    await writeFile(path.join(changeDir, 'tasks.md'), '# Tasks\n')
    const receiptId = '11111111-2222-4333-8444-555555555555'
    const receiptPath = path.join(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
    await mkdir(path.dirname(receiptPath), { recursive: true })
    await writeFile(receiptPath, `${JSON.stringify({
      schema_version: 1, intake_id: receiptId, status: 'completed',
      primary: `.specops/changes/${changeId}`,
      documents: [`.specops/changes/${changeId}`, `.specops/changes/${changeId}/proposal.md`, `.specops/changes/${changeId}/tasks.md`],
    })}\n`)
    const failed = await createSpecOpsSession(workspace, {
      title: 'Intake that was misclassified', backend_key: 'codebuddy', phase: 'failed', state: 'failed',
    })
    await updateSpecOpsSession(workspace, failed.id, (record) => {
      record.transcript.push({ role: 'agent', text: `Intake complete: .specops/state/intakes/${receiptId}.json`, at: new Date().toISOString() })
      record.execution.last_error = 'transient finalize failure'
    })
    const server = await startTestServer({ workspace, token: 'test-token' })

    const listed = await fetch(`${server.origin}/api/sessions`, auth(server))
    expect(listed.status).toBe(200)
    const recovered = await readSpecOpsSession(workspace, failed.id)
    expect(recovered.execution.last_error).toBeNull()
    expect(recovered.phase).toBe('run_in_worktree')
    expect(recovered.state).toBe('awaiting_user')
    expect(recovered.required_action).toMatchObject({ kind: 'run_in_worktree' })
    expect(recovered.document_path).toBe(`.specops/changes/${changeId}`)
  })

  test('invalid ready intake creates one repair action, resumes with the validation error, and recovers', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const specPath = '.specops/specs/intake-recovery.md'
    const absoluteSpecPath = path.join(workspace, specPath)
    await mkdir(path.dirname(absoluteSpecPath), { recursive: true })
    const spec = (status: string) => [
      '---', 'schema_version: 2', 'id: intake-recovery', 'kind: spec', 'document_class: normative',
      'spec_type: policy', 'title: Intake recovery process', `status: ${status}`, '---',
      '# Intake recovery process', '', 'Invalid intake documents must remain recoverable.', '',
    ].join('\n')
    await writeFile(absoluteSpecPath, spec('proposed'))
    const receiptId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const receiptPath = path.join(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
    await mkdir(path.dirname(receiptPath), { recursive: true })
    await writeFile(receiptPath, `${JSON.stringify({
      schema_version: 1,
      intake_id: receiptId,
      status: 'ready',
      primary: specPath,
      documents: [specPath],
    })}\n`)
    const session = await createSpecOpsSession(workspace, {
      title: 'Recover invalid intake', backend_key: 'codebuddy', phase: 'analyze_request', state: 'created',
      intake_receipt_id: receiptId,
      transcript: [{ role: 'agent', text: `Intake ready: .specops/state/intakes/${receiptId}.json`, at: new Date().toISOString() }],
    })
    const runtime = new FakeExecutionRuntime()
    await runtime.start({ workspace, sessionId: session.id, purpose: 'intake', backendKey: 'codebuddy', cwd: workspace })
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)

    expect((await fetch(`${server.origin}/api/sessions`, auth(server))).status).toBe(200)
    let failed = await readSpecOpsSession(workspace, session.id)
    expect(failed.state).toBe('awaiting_user')
    expect(failed.required_action).toMatchObject({ kind: 'resume', reason: 'intake_finalization_failed' })
    expect(failed.execution.last_error).toContain('status is invalid for normative')
    expect(failed.document_path).toBe(specPath)

    // Reconciliation polling must not enqueue duplicate repair cards.
    expect((await fetch(`${server.origin}/api/sessions`, auth(server))).status).toBe(200)
    failed = await readSpecOpsSession(workspace, session.id)
    expect(failed.interactions?.filter((item) => item.kind === 'resume' && item.status === 'pending')).toHaveLength(1)

    const resumed = await fetch(`${server.origin}/api/sessions/${session.id}/action`, auth(server, {
      method: 'POST', body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(resumed.status).toBe(200)
    expect(runtime.prompts.at(-1)?.input.text).toContain('Validation error:')
    expect(runtime.prompts.at(-1)?.input.text).toContain('Normative schema-v2 documents')
    const active = await readSpecOpsSession(workspace, session.id)
    expect(active.state).toBe('active')
    expect(active.required_action).toBeNull()

    await writeFile(absoluteSpecPath, spec('draft'))
    await updateSpecOpsSession(workspace, session.id, (record) => {
      const current = record.agents.find((item) => item.execution_id === record.current_execution?.execution_id)
      if (current !== undefined) current.status = 'ready'
      // A successful repair turn clears this transient diagnostic before the
      // receipt reconciler runs; document_path + null error must not be
      // mistaken for a finalized intake.
      record.execution.last_error = null
    })
    expect((await fetch(`${server.origin}/api/sessions`, auth(server))).status).toBe(200)
    const recovered = await readSpecOpsSession(workspace, session.id)
    expect(recovered.state).toBe('completed')
    expect(recovered.phase).toBe('completed')
    expect(recovered.execution.last_error).toBeNull()
    expect(recovered.document_path).toBe(specPath)
    expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ status: 'completed' })
  })

  test('intake analyzes in the primary workspace and writes the classified document without a run', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const prompts: string[] = []
    const runtime = new FakeExecutionRuntime(async ({ input, binding }) => {
      prompts.push(input.text)
      expect(await realpath(binding.cwd)).toBe(await realpath(workspace))
      const primaryPath = '.specops/changes/bug/session-filter'
      const secondaryPath = '.specops/specs/session-filter-process.md'
      const primaryFile = path.join(workspace, primaryPath, 'proposal.md')
      await mkdir(path.dirname(primaryFile), { recursive: true })
      await writeFile(primaryFile, [
        '---',
        'schema_version: 1',
        'id: bug/session-filter',
        'kind: change',
        'title: Fix session filter',
        'status: proposed',
        'verifies: []',
        'paths: [apps/gui/src]',
        '---',
        '',
        '# Problem',
        'The filter is stale.',
        '',
      ].join('\n'))
      const secondary = path.join(workspace, secondaryPath)
      await writeFile(secondary, [
        '---',
        'schema_version: 1',
        'id: session-filter-process',
        'kind: spec',
        'title: Session filter process',
        'status: active',
        'verifies: []',
        'paths: [apps/gui/src]',
        '---',
        '',
        '# Process',
        'Keep the filter synchronized.',
        '',
      ].join('\n'))
      const receiptMatch = /\.specops\/state\/intakes\/([0-9a-f-]+)\.json/.exec(input.text)
      expect(receiptMatch).not.toBeNull()
      const receiptId = receiptMatch?.[1] ?? ''
      const receipt = path.join(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
      await mkdir(path.dirname(receipt), { recursive: true })
      await writeFile(receipt, `${JSON.stringify({
        schema_version: 1,
        intake_id: receiptId,
        status: 'completed',
        primary: primaryPath,
        documents: [primaryPath, secondaryPath],
      })}\n`)
    })
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)

    const started = await fetch(`${server.origin}/api/intakes`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'The session filter is stale', backend_key: 'codebuddy' }),
    }))
    const startedBody = await started.json() as Record<string, unknown>
    expect({ status: started.status, error: startedBody.error }).toEqual({ status: 201, error: undefined })
    const specopsSession = startedBody.specops_session as { id: string; phase: string; state: string }
    expect(specopsSession).toMatchObject({ phase: 'analyze_request', state: 'active' })
    expect(prompts[0]).toContain('Do not edit source files')

    const listed = await (await fetch(`${server.origin}/api/sessions`, auth(server))).json() as { sessions: Array<{ id: string; title: string }> }
    expect(listed.sessions[0]?.id).toBe(specopsSession.id)

    const result = await (await fetch(`${server.origin}/api/intakes/${specopsSession.id}`, auth(server))).json() as {
      document: { path: string }
      documents: string[]
    }
    expect(result.document.path).toBe('.specops/changes/bug/session-filter')
    expect(result.documents).toEqual([
      '.specops/changes/bug/session-filter',
      '.specops/specs/session-filter-process.md',
    ])
    expect(await readFile(path.join(workspace, result.document.path, 'proposal.md'), 'utf8')).toContain('kind: change')
    expect(await exists(path.join(workspace, '.specops', 'runs', specopsSession.id))).toBe(false)

    const detail = await (await fetch(`${server.origin}/api/sessions/${specopsSession.id}`, auth(server))).json() as { session: { document_path: string; phase: string; state: string; required_action: { kind: string } } }
    expect(detail.session).toMatchObject({
      document_path: '.specops/changes/bug/session-filter',
      phase: 'run_in_worktree',
      state: 'awaiting_user',
      required_action: { kind: 'run_in_worktree' },
    })
  })

  test('intake commits plan docs with specops(plan): prefix', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const headBeforeDocs = await (await import('./helpers.js')).git(workspace, ['rev-parse', 'HEAD'])
    const runtime = new FakeExecutionRuntime(async ({ input }) => {
      const primaryPath = '.specops/changes/bug/plan-docs'
      const primaryFile = path.join(workspace, primaryPath, 'proposal.md')
      await mkdir(path.dirname(primaryFile), { recursive: true })
      await writeFile(primaryFile, [
        '---',
        'schema_version: 1',
        'id: bug/plan-docs',
        'kind: change',
        'title: Plan docs commit',
        'status: proposed',
        'verifies: []',
        'paths: [apps/gui/src]',
        '---',
        '',
        '# Problem',
        'Need to commit plan docs.',
        '',
      ].join('\n'))
      const receiptMatch = /\.specops\/state\/intakes\/([0-9a-f-]+)\.json/.exec(input.text)
      const receiptId = receiptMatch?.[1] ?? ''
      const receipt = path.join(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`)
      await mkdir(path.dirname(receipt), { recursive: true })
      await writeFile(receipt, `${JSON.stringify({
        schema_version: 1,
        intake_id: receiptId,
        status: 'completed',
        primary: primaryPath,
        documents: [primaryPath],
      })}\n`)
    })
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)

    const started = await fetch(`${server.origin}/api/intakes`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'Plan docs commit test', backend_key: 'codebuddy' }),
    }))
    const startedBody = await started.json() as { intake_id: string }
    await (await fetch(`${server.origin}/api/intakes/${startedBody.intake_id}`, auth(server))).json()

    // The plan docs commit must have landed on the main workspace.
    const { git } = await import('./helpers.js')
    const log = await git(workspace, ['log', '--oneline', `${headBeforeDocs}..HEAD`])
    expect(log).toMatch(/specops\(plan\): Plan docs commit/)
    // proposal.md is now in HEAD, so a worktree built from HEAD would see it.
    const blob = await git(workspace, ['show', `HEAD:.specops/changes/bug/plan-docs/proposal.md`])
    expect(blob).toContain('kind: change')
  })

  // ── resume flow ──
  // The resume handler must (a) cover every active phase that owns a kode
  // session (not just run_in_worktree / analyze_request), (b) resume from the
  // codebuddy UUID stored on the matching agent rather than the numeric
  // kode_session_id, and (c) degrade gracefully when no UUID is available.

  function buildKodeMock(overrides: {
    getSession?: (id: number) => KodeSession | Promise<KodeSession>
    createSession?: (backendKey: string, cwd: string, initialPrompt?: string, resumeSessionUuid?: string, model?: string) => KodeSession | Promise<KodeSession>
  } = {}): { kode: KodeClient; calls: { createSession: Array<{ backendKey: string; cwd: string; initialPrompt: string | undefined; resumeSessionUuid: string | undefined }>; sendPrompt: Array<{ id: number; prompt: string }> } } {
    const calls = {
      createSession: [] as Array<{ backendKey: string; cwd: string; initialPrompt: string | undefined; resumeSessionUuid: string | undefined }>,
      sendPrompt: [] as Array<{ id: number; prompt: string }>,
    }
    const socket = { on: () => socket, close: () => undefined }
    const defaultGetSession = async (id: number) => ({ id, backend_key: 'codebuddy', status: 'idle' })
    const defaultCreateSession = async (backendKey: string, cwd: string, initialPrompt?: string, resumeSessionUuid?: string) => {
      calls.createSession.push({ backendKey, cwd, initialPrompt, resumeSessionUuid })
      return { id: 9001, backend_key: backendKey, status: 'idle', session_uuid: 'new-uuid-9001' }
    }
    const kode = {
      getSession: overrides.getSession ?? defaultGetSession,
      createSession: overrides.createSession ?? defaultCreateSession,
      sendPrompt: async (id: number, prompt: string) => { calls.sendPrompt.push({ id, prompt }) },
      subscribe: () => socket,
      history: async () => ({ events: [], next_from: 0 }),
      killSession: async () => undefined,
    } as unknown as KodeClient
    return { kode, calls }
  }

  test('resume on a clarify phase reuses a live structured execution', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Clarify resume', backend_key: 'codebuddy', phase: 'clarify', state: 'awaiting_user',
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)
    const identity = await runtime.start({
      workspace, sessionId: specopsSession.id, purpose: 'clarify', backendKey: 'codebuddy', cwd: workspace,
    })

    const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
      method: 'POST', body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { session: { state: string; current_execution: ExecutionIdentity | null } }
    expect(body.session.current_execution).toEqual(identity)
    expect(body.session.state).toBe('active')
    expect(runtime.starts).toHaveLength(1)
    expect(runtime.loads).toHaveLength(0)
  })

  test('reopens a completed work-item session without creating another intake document', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const server = await startTestServer({ workspace, token: 'test-token' })
    const documentPath = '.specops/changes/reopen-existing-change'
    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Reopen existing change',
      backend_key: 'codebuddy',
      kode_session_id: 55,
      run_id: '11111111-2222-4333-8444-555555555555',
      document_path: documentPath,
      phase: 'completed',
      state: 'completed',
    })
    await updateSpecOpsSession(workspace, specopsSession.id, (record) => {
      record.transcript.push({ role: 'user', text: 'Keep this history', at: new Date().toISOString() })
    })

    const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ kind: 'reopen' }),
    }))

    expect(res.status).toBe(200)
    const reopened = await readSpecOpsSession(workspace, specopsSession.id)
    expect(reopened.document_path).toBe(documentPath)
    expect(reopened.run_id).toBeNull()
    expect(reopened.kode_session_id).toBeNull()
    expect(reopened.phase).toBe('run_in_worktree')
    expect(reopened.state).toBe('awaiting_user')
    expect(reopened.required_action).toMatchObject({ kind: 'run_in_worktree' })
    expect(reopened.transcript.some((entry) => entry.text === 'Keep this history')).toBe(true)
  })

  test('resume on plan_discussion restarts CodeBuddy with durable context', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const previous: ExecutionIdentity = {
      execution_id: 'plan-execution', transport: 'codebuddy_acp', backend_key: 'codebuddy',
      native_session_id: 'plan-native-session', process_generation: 1,
    }
    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Plan resume', backend_key: 'codebuddy', phase: 'plan_discussion', state: 'awaiting_user',
      current_execution: previous,
      agents: [{
        ...previous, kode_session_id: null, session_uuid: previous.native_session_id, model: null,
        purpose: 'plan', status: 'exited', started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      }],
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)

    const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
      method: 'POST', body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    expect(runtime.loads).toHaveLength(0)
    expect(runtime.starts).toHaveLength(1)
    expect(runtime.starts[0]).toMatchObject({
      cwd: await realpath(workspace),
      purpose: 'plan',
      metadata: { resumed_with_fresh_context: true },
    })
    const body = await res.json() as { session: { current_execution: ExecutionIdentity | null } }
    expect(body.session.current_execution).toMatchObject({ execution_id: 'execution-1', process_generation: 1 })
    expect(runtime.prompts[0]?.input.text).toContain('Continue this existing SpecOps workflow')
    expect(runtime.prompts[0]?.input.text).toContain('Phase: plan_discussion')
  })

  test('resume starts fresh structured execution when no native session id is available', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'No native resume', backend_key: 'codebuddy', phase: 'analyze_request', state: 'awaiting_user',
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)

    const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
      method: 'POST', body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    expect(runtime.starts).toHaveLength(1)
    expect(runtime.loads).toHaveLength(0)
    expect(runtime.prompts[0]?.input.text).toContain('Continue this existing SpecOps workflow')
    expect(runtime.prompts[0]?.input.text).toContain('Phase: analyze_request')
  })

  test('session listing detaches an exited kode session and exposes exact recovery', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Destroyed kode session',
      backend_key: 'codebuddy',
      kode_session_id: 66,
      phase: 'clarify',
      state: 'awaiting_user',
    })
    await attachSessionAgent(workspace, specopsSession.id, {
      kode_session_id: 66,
      session_uuid: 'recoverable-uuid-66',
      backend_key: 'codebuddy',
      model: null,
      purpose: 'clarify',
      status: 'idle',
    })
    const { kode } = buildKodeMock({
      getSession: async (id) => ({ id, backend_key: 'codebuddy', status: 'exited' }),
    })
    const server = await startTestServer({ workspace, token: 'test-token', kodeClient: kode })

    const listed = await (await fetch(`${server.origin}/api/sessions`, auth(server))).json() as {
      sessions: Array<{
        id: string
        kode_session_id: number | null
        execution: { state: string; resume_mode: string }
        agents: Array<{ kode_session_id: number; status: string; ended_at: string | null }>
      }>
    }
    const recovered = listed.sessions.find((session) => session.id === specopsSession.id)
    expect(recovered?.kode_session_id).toBeNull()
    expect(recovered?.execution).toMatchObject({ state: 'resumable', resume_mode: 'exact' })
    expect(recovered?.agents[0]).toMatchObject({ kode_session_id: 66, status: 'exited' })
    expect(recovered?.agents[0]?.ended_at).not.toBeNull()
  })

  test('sending in review resumes structured execution before delivering input', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const previous: ExecutionIdentity = {
      execution_id: 'review-execution', transport: 'codebuddy_acp', backend_key: 'codebuddy',
      native_session_id: 'review-native-session', process_generation: 1,
    }
    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Review discussion', backend_key: 'codebuddy', phase: 'review', state: 'awaiting_user',
      current_execution: previous,
      agents: [{
        ...previous, kode_session_id: null, session_uuid: previous.native_session_id, model: null,
        purpose: 'review', status: 'exited', started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      }],
    })
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token' }, runtime)

    const response = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/input`, auth(server, {
      method: 'POST', body: JSON.stringify({ text: 'Please revise this review finding.' }),
    }))
    expect(response.status).toBe(200)
    expect(runtime.loads).toHaveLength(0)
    expect(runtime.starts[0]).toMatchObject({
      purpose: 'repair', metadata: { resumed_with_fresh_context: true },
    })
    expect(runtime.prompts.at(-1)?.input.text).toContain('New user message:\nPlease revise this review finding.')
    const body = await response.json() as { session: { current_execution: ExecutionIdentity | null; transcript: Array<{ text: string; execution_id: string | null; kode_session_id: number | null }> } }
    expect(body.session.current_execution?.execution_id).toBe('execution-1')
    expect(body.session.transcript.at(-1)).toMatchObject({
      text: 'Please revise this review finding.', execution_id: null, kode_session_id: null,
    })
  })

  test('resume on run_in_worktree restarts CodeBuddy inside the run worktree', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-resume-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const runtime = new FakeExecutionRuntime()
    const server = await startTestServer({ workspace, token: 'test-token', runCacheRoot: cache }, runtime)

    const created = await fetch(`${server.origin}/api/runs`, auth(server, {
      method: 'POST',
      body: JSON.stringify({
        backend_key: 'codebuddy',
        tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
      }),
    }))
    const createdBody = await created.json() as {
      run: { run_id: string; worktree_path: string }
      specops_session: { id: string; current_execution: ExecutionIdentity | null }
    }
    const previous = createdBody.specops_session.current_execution
    expect(previous?.native_session_id).toBeTruthy()
    runtime.drop(previous!.execution_id)

    const res = await fetch(`${server.origin}/api/sessions/${createdBody.specops_session.id}/action`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    expect(runtime.loads).toHaveLength(0)
    expect(runtime.starts.at(-1)).toMatchObject({
      purpose: 'implement',
      metadata: { resumed_with_fresh_context: true },
    })
    expect(await realpath(runtime.starts.at(-1)!.cwd)).toBe(await realpath(createdBody.run.worktree_path))
    await cleanupRun(await readRun(workspace, createdBody.run.run_id))
  })
})
