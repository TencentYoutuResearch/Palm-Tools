import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import { startServer, type ServeHandle } from '../src/server/index.js'
import { cleanupRun, readRun } from '../src/domain/run.js'
import { attachSessionAgent, createSpecOpsSession, readSpecOpsSession, updateSpecOpsSession } from '../src/domain/session.js'
import { parseDocument } from '../src/domain/spec.js'
import { exists } from '../src/store/workspace.js'
import type { KodeClient, KodeSession } from '../src/adapters/kode.js'
import { gitCommit, gitWorkspace } from './helpers.js'

const cleanup: string[] = []
const servers: ServeHandle[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

async function fixture() {
  const workspace = await gitWorkspace()
  cleanup.push(workspace)
  await initWorkspace(workspace)
  const server = await startServer({ workspace, token: 'test-token' })
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
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode }); servers.push(server)
    const loaded = await fetch(`${server.origin}/api/settings/agents`, auth(server))
    expect(loaded.status).toBe(200)
    expect((await loaded.json() as { backends: Array<{ key: string }> }).backends.map((item) => item.key)).toEqual(['codebuddy', 'codex'])

    const saved = await fetch(`${server.origin}/api/settings/agents`, auth(server, {
      method: 'PUT',
      body: JSON.stringify({ profiles: {
        default: { backend: 'codebuddy' }, analysis: {},
        implementation: { backend: 'codex', model: 'gpt-5-codex' }, review: {},
      } }),
    }))
    expect(saved.status).toBe(200)
    const config = await readFile(path.join(workspace, 'specops.toml'), 'utf8')
    expect(config).toContain('[agents.implementation]\nbackend = "codex"\nmodel = "gpt-5-codex"')

    const invalid = await fetch(`${server.origin}/api/settings/agents`, auth(server, {
      method: 'PUT',
      body: JSON.stringify({ profiles: {
        default: { backend: 'missing' }, analysis: {}, implementation: {}, review: {},
      } }),
    }))
    expect(invalid.status).toBe(400)
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
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode }); servers.push(server)
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
    const calls = { answers: 0, plans: 0 }
    const socket = { on: () => socket, close: () => undefined }
    const kode = {
      answer: async () => { calls.answers += 1 },
      planResponse: async () => { calls.plans += 1 },
      waitForReady: async () => ({ id: 73, backend_key: 'codebuddy', status: 'idle' }),
      subscribe: () => socket,
      history: async () => ({ events: [], next_from: 0 }),
    } as unknown as KodeClient
    const session = await createSpecOpsSession(workspace, {
      title: 'Decision ledger',
      backend_key: 'codebuddy',
      kode_session_id: 73,
      phase: 'clarify',
      state: 'awaiting_user',
      required_action: {
        kind: 'answer',
        question_id: 'question-1',
        prompt: 'Which compatibility target should win?',
        options: [{ label: 'macOS and Linux' }, { label: 'All platforms' }],
        questions: [
          { question_id: 'question-1', prompt: 'Which compatibility target should win?', options: [{ label: 'macOS and Linux' }, { label: 'All platforms' }] },
          { question_id: 'question-2', prompt: 'Which release mode?', options: [{ label: 'Gradual' }, { label: 'Immediate' }] },
        ],
      },
    })
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

    const answered = await fetch(`${server.origin}/api/sessions/${session.id}/answer`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ answers: [
        { question_id: 'question-1', choice_index: 0, label: 'macOS and Linux' },
        { question_id: 'question-2', choice_index: 1, label: 'Immediate' },
      ] }),
    }))
    expect(answered.status).toBe(200)

    await updateSpecOpsSession(workspace, session.id, (record) => {
      record.state = 'awaiting_user'
      record.required_action = { kind: 'plan_review', plan_id: 'plan-1', markdown: '# Approved plan' }
    })
    const approved = await fetch(`${server.origin}/api/sessions/${session.id}/plan_response`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ plan_id: 'plan-1', accept: true, note: 'Keep the scope narrow.' }),
    }))
    expect(approved.status).toBe(200)

    const detail = await (await fetch(`${server.origin}/api/sessions/${session.id}`, auth(server))).json() as {
      session: { decisions: Array<{ id: string; outcome: string; prompt: string; selections: string[]; note: string | null }> }
    }
    expect(calls).toEqual({ answers: 2, plans: 1 })
    expect(detail.session.decisions).toEqual([
      {
        id: 'question-1',
        outcome: 'answered',
        prompt: 'Which compatibility target should win?',
        selections: ['macOS and Linux'],
        note: null,
        kind: 'answer',
        source: 'user',
        kode_session_id: 73,
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
        kode_session_id: 73,
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
        kode_session_id: 73,
        at: expect.any(String),
      },
    ])
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
    const server = await startServer({ workspace, token: 'test-token', runCacheRoot: cache })
    servers.push(server)

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

  test('quick-run creates a document and launches a run in one call', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const server = await startServer({ workspace, token: 'test-token', runCacheRoot: cache })
    servers.push(server)

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
    const server = await startServer({ workspace, token: 'test-token', runCacheRoot: cache })
    servers.push(server)

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
    const server = await startServer({ workspace, token: 'test-token' })
    servers.push(server)

    const listed = await fetch(`${server.origin}/api/sessions`, auth(server))
    expect(listed.status).toBe(200)
    const recovered = await readSpecOpsSession(workspace, failed.id)
    expect(recovered.execution.last_error).toBeNull()
    expect(recovered.phase).toBe('run_in_worktree')
    expect(recovered.state).toBe('awaiting_user')
    expect(recovered.required_action).toEqual({ kind: 'run_in_worktree' })
    expect(recovered.document_path).toBe(`.specops/changes/${changeId}`)
  })

  test('intake analyzes in the primary workspace and writes the classified document without a run', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const prompts: string[] = []
    const session: KodeSession = { id: 42, backend_key: 'codebuddy', status: 'idle' }
    const socket = { on: () => socket, close: () => undefined }
    const kode = {
      createAnalysisSession: async (_backend: string, cwd: string, prompt: string) => {
        expect(await realpath(cwd)).toBe(await realpath(workspace))
        prompts.push(prompt)
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
        const receiptMatch = /\.specops\/state\/intakes\/([0-9a-f-]+)\.json/.exec(prompt)
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
        return session
      },
      getSession: async () => session,
      subscribe: () => socket,
    } as unknown as KodeClient
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

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

    const result = await (await fetch(`${server.origin}/api/intakes/42`, auth(server))).json() as {
      document: { path: string }
      documents: string[]
    }
    expect(result.document.path).toBe('.specops/changes/bug/session-filter')
    expect(result.documents).toEqual([
      '.specops/changes/bug/session-filter',
      '.specops/specs/session-filter-process.md',
    ])
    expect(await readFile(path.join(workspace, result.document.path, 'proposal.md'), 'utf8')).toContain('kind: change')
    expect(await exists(path.join(workspace, '.specops', 'runs', '42'))).toBe(false)

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
    const session: KodeSession = { id: 51, backend_key: 'codebuddy', status: 'idle' }
    const socket = { on: () => socket, close: () => undefined }
    const kode = {
      createAnalysisSession: async (_backend: string, _cwd: string, prompt: string) => {
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
        const receiptMatch = /\.specops\/state\/intakes\/([0-9a-f-]+)\.json/.exec(prompt)
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
        return session
      },
      getSession: async () => session,
      subscribe: () => socket,
    } as unknown as KodeClient
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

    await fetch(`${server.origin}/api/intakes`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ request: 'Plan docs commit test', backend_key: 'codebuddy' }),
    }))
    await (await fetch(`${server.origin}/api/intakes/51`, auth(server))).json()

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

  test('resume on a clarify phase re-attaches when the kode session is still alive', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const { kode } = buildKodeMock()
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Clarify resume',
      backend_key: 'codebuddy',
      kode_session_id: 55,
      phase: 'clarify',
      state: 'awaiting_user',
    })
    await attachSessionAgent(workspace, specopsSession.id, {
      kode_session_id: 55,
      session_uuid: 'clarify-uuid-55',
      backend_key: 'codebuddy',
      model: null,
      purpose: 'clarify',
      status: 'idle',
    })

    const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { session: { phase: string; state: string; kode_session_id: number } }
    // Alive session is reused — kode_session_id stays 55, no new session created.
    expect(body.session.kode_session_id).toBe(55)
    expect(body.session.state).toBe('active')
  })

  test('reopens a completed work-item session without creating another intake document', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const server = await startServer({ workspace, token: 'test-token' })
    servers.push(server)
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
    expect(reopened.required_action).toEqual({ kind: 'run_in_worktree' })
    expect(reopened.transcript.some((entry) => entry.text === 'Keep this history')).toBe(true)
  })

  test('resume on plan_discussion rebuilds using the agent UUID, not the numeric kode_session_id', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const planUuid = 'plan-uuid-aaaaaaaa'
    const { kode, calls } = buildKodeMock({
      // kode session already exited → handler must rebuild
      getSession: async (id) => ({ id, backend_key: 'codebuddy', status: 'exited' }),
    })
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Plan resume',
      backend_key: 'codebuddy',
      kode_session_id: 77,
      phase: 'plan_discussion',
      state: 'awaiting_user',
    })
    await attachSessionAgent(workspace, specopsSession.id, {
      kode_session_id: 77,
      session_uuid: planUuid,
      backend_key: 'codebuddy',
      model: null,
      purpose: 'plan',
      status: 'exited',
    })

    const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    expect(calls.createSession).toHaveLength(1)
    // The UUID, not the numeric id (77), must be passed as resume_session_uuid.
    expect(calls.createSession[0]?.resumeSessionUuid).toBe(planUuid)
    // cwd for a plan-phase session is the workspace itself (no worktree).
    expect(await realpath(calls.createSession[0]!.cwd)).toBe(await realpath(workspace))
    const body = await res.json() as { session: { kode_session_id: number; agents: Array<{ kode_session_id: number; purpose: string; session_uuid: string | null; status: string; ended_at: string | null }> } }
    expect(body.session.kode_session_id).toBe(9001)
    expect(body.session.agents.some((a) => a.purpose === 'repair' && a.session_uuid === 'new-uuid-9001')).toBe(true)
    const previous = body.session.agents.find((a) => a.kode_session_id === 77)
    expect(previous?.status).toBe('exited')
    expect(previous?.ended_at).not.toBeNull()
  })

  test('resume degrades to a fresh session when no agent UUID is available', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const { kode, calls } = buildKodeMock({
      getSession: async (id) => ({ id, backend_key: 'codebuddy', status: 'exited' }),
    })
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'No uuid resume',
      backend_key: 'codebuddy',
      kode_session_id: 88,
      phase: 'analyze_request',
      state: 'awaiting_user',
    })
    // Agent predates the session_uuid field — null UUID, must not be passed as --resume.
    await attachSessionAgent(workspace, specopsSession.id, {
      kode_session_id: 88,
      session_uuid: null,
      backend_key: 'codebuddy',
      model: null,
      purpose: 'intake',
      status: 'exited',
    })

    const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    expect(calls.createSession).toHaveLength(1)
    expect(calls.createSession[0]?.resumeSessionUuid).toBeUndefined()
    expect(calls.createSession[0]?.initialPrompt).toContain('Continue this existing SpecOps workflow')
    expect(calls.createSession[0]?.initialPrompt).toContain('Phase: analyze_request')
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
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

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

  test('sending in review auto-resumes a destroyed kode session before delivering input', async () => {
    const workspace = await gitWorkspace()
    cleanup.push(workspace)
    await initWorkspace(workspace)
    const specopsSession = await createSpecOpsSession(workspace, {
      title: 'Review discussion',
      backend_key: 'codebuddy',
      kode_session_id: null,
      phase: 'review',
      state: 'awaiting_user',
    })
    await attachSessionAgent(workspace, specopsSession.id, {
      kode_session_id: 77,
      session_uuid: 'review-resume-uuid-77',
      backend_key: 'codebuddy',
      model: null,
      purpose: 'review',
      status: 'exited',
    })
    const { kode, calls } = buildKodeMock()
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode })
    servers.push(server)

    const response = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/input`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ text: 'Please revise this review finding.' }),
    }))
    expect(response.status).toBe(200)
    expect(calls.createSession[0]?.resumeSessionUuid).toBe('review-resume-uuid-77')
    expect(calls.sendPrompt).toEqual([{ id: 9001, prompt: 'Please revise this review finding.' }])
    const body = await response.json() as { session: { kode_session_id: number; transcript: Array<{ text: string; kode_session_id: number }> } }
    expect(body.session.kode_session_id).toBe(9001)
    expect(body.session.transcript.at(-1)).toMatchObject({ text: 'Please revise this review finding.', kode_session_id: 9001 })
  })

  test('resume on run_in_worktree rebuilds inside the run worktree with the implement agent UUID', async () => {
    const workspace = await gitWorkspace()
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-resume-cache-'))
    cleanup.push(workspace, cache)
    await initWorkspace(workspace)
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
    const implUuid = 'impl-uuid-bbbbbbbb'
    const { kode, calls } = buildKodeMock({
      getSession: async (id) => ({ id, backend_key: 'codebuddy', status: 'exited' }),
    })
    const server = await startServer({ workspace, token: 'test-token', kodeClient: kode, runCacheRoot: cache })
    servers.push(server)

    const created = await fetch(`${server.origin}/api/runs`, auth(server, {
      method: 'POST',
      body: JSON.stringify({
        backend_key: 'codebuddy',
        tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
      }),
    }))
    const createdBody = await created.json() as { run: { run_id: string; worktree_path: string }; specops_session: { id: string; kode_session_id: number } }
    // Patch the implement agent with a real UUID so resume has something to use.
    await updateSpecOpsSession(workspace, createdBody.specops_session.id, (record) => {
      for (const agent of record.agents) {
        if (agent.purpose === 'implement') agent.session_uuid = implUuid
      }
    })

    const res = await fetch(`${server.origin}/api/sessions/${createdBody.specops_session.id}/action`, auth(server, {
      method: 'POST',
      body: JSON.stringify({ kind: 'resume' }),
    }))
    expect(res.status).toBe(200)
    // First createSession came from launchRun (no resume); the second is the resume rebuild.
    expect(calls.createSession).toHaveLength(2)
    expect(calls.createSession[0]?.resumeSessionUuid).toBeUndefined()
    expect(calls.createSession[1]?.resumeSessionUuid).toBe(implUuid)
    expect(await realpath(calls.createSession[1]!.cwd)).toBe(await realpath(createdBody.run.worktree_path))
    await cleanupRun(await readRun(workspace, createdBody.run.run_id))
  })
})
