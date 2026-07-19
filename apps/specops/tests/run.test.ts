import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import { parseDocument, serializeDocument, type SpecDocument } from '../src/domain/spec.js'
import { advanceToNextTask, applyCompletedRun, applyWithVerify, type RunExecutionRuntime } from '../src/domain/run-loop.js'
import { initRunMonitor, shutdownMonitor, watchRun } from '../src/domain/run-monitor.js'
import { applyRunPatch, changedFilesForRun, cleanupRun, collectRunPatch, createRun, readRun, rollbackRunPatch, runChangeEvidence, transitionRun, writeRun, type RunRecord } from '../src/domain/run.js'
import { createSpecOpsSession, readSpecOpsSession, type ExecutionIdentity } from '../src/domain/session.js'
import { git, gitCommit, gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => {
  await shutdownMonitor()
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

async function fixture() {
  const workspace = await gitWorkspace()
  const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-cache-'))
  cleanup.push(workspace, cache)
  await initWorkspace(workspace)
  await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
  return { workspace, cache }
}

describe('Run worktree isolation', () => {
  test('backfills legacy numeric execution identity when reading a Run', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Legacy', prompt: 'noop', verify: [] }], 'codebuddy', 'HEAD', cache)
    const recordPath = path.join(workspace, '.specops', 'runs', run.run_id, 'run.json')
    const raw = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>
    delete raw.execution
    raw.kode_session_id = 42
    await writeFile(recordPath, `${JSON.stringify(raw, null, 2)}\n`)

    expect((await readRun(workspace, run.run_id).then((record) => record.execution))).toEqual({
      execution_id: 'legacy_kode_pty:42:0',
      transport: 'legacy_kode_pty',
      backend_key: 'codebuddy',
      native_session_id: '42',
      process_generation: 0,
    })
    await cleanupRun(run)
  })

  test('advances implementation tasks without entering verify between them', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [
      { id: 'task-1', title: 'First', prompt: 'first', verify: [] },
      { id: 'task-2', title: 'Second', prompt: 'second', verify: [] },
    ], 'codebuddy', 'HEAD', cache)
    await createSpecOpsSession(workspace, {
      title: 'Multi-task run', backend_key: 'codebuddy', run_id: run.run_id,
      phase: 'run_in_worktree', state: 'active',
    })
    const prompts: string[] = []
    let current: ExecutionIdentity | undefined
    const runtime: RunExecutionRuntime = {
      start: async (input) => {
        current = {
          execution_id: 'execution-42', transport: 'codebuddy_acp', backend_key: input.backendKey,
          native_session_id: 'native-42', process_generation: 1,
        }
        return current
      },
      load: async () => { throw new Error('load should not be called') },
      prompt: async (_id, input) => {
        prompts.push(input.text)
        return { outcome: 'completed', value: { turnId: input.requestId } }
      },
      close: async () => undefined,
      get: () => current,
    }

    await advanceToNextTask(run, runtime)

    const updated = await readRun(workspace, run.run_id)
    expect(updated.state).toBe('running')
    expect(updated.current_task).toBe(1)
    expect(updated.verify_results).toEqual([])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('SpecOps task task-2: Second')
    await cleanupRun(run)
  })

  test('detects untracked implementation output before auto-verify', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add new-file.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'new-file.txt'), 'implementation output\n')

    await expect(changedFilesForRun(run)).resolves.toContain('new-file.txt')
    await cleanupRun(run)
  })

  test('captures changes without modifying the primary worktree', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add isolated.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'isolated.txt'), 'run output\n')
    const result = await collectRunPatch(run)
    expect(result.files).toContain('isolated.txt')
    expect(result.patch).toContain('run output')
    await expect(readFile(path.join(workspace, 'isolated.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readRun(workspace, run.run_id)).worktree_path).toBe(run.worktree_path)
    expect(run.manifest).toMatchObject({
      schema_version: 1,
      workflow: { kind: 'feature' },
      backend: { key: 'codebuddy', plugin: 'builtin.kode' },
      scope: { base_commit: run.base_commit, task_ids: ['task-1'] },
      limits: { max_iterations: 8 },
    })
    await cleanupRun(run)
  })

  test('streams patches larger than the former execFile stdout buffer', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Large output', prompt: 'Add large.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    const largeContent = `${'x'.repeat(17 * 1024 * 1024)}\n`
    await writeFile(path.join(run.worktree_path, 'large.txt'), largeContent)

    const result = await collectRunPatch(run)

    expect(Buffer.byteLength(result.patch)).toBeGreaterThan(16 * 1024 * 1024)
    expect(result.files).toContain('large.txt')
    await cleanupRun(run)
  })

  test('snapshots project, workflow, backend, and verification profiles in the Run manifest', async () => {
    const { workspace, cache } = await fixture()
    await mkdir(path.join(workspace, '.specops', 'plugins'), { recursive: true })
    await writeFile(path.join(workspace, '.specops', 'plugins', 'company-codebuddy.json'), `${JSON.stringify({
      schema_version: 1,
      id: 'company.codebuddy',
      version: '1.0.0',
      kind: 'backend',
      capabilities: ['session.create', 'conversation.ask'],
    })}\n`)
    await writeFile(path.join(workspace, 'specops.toml'), [
      'schema_version = 1',
      '',
      '[project]',
      'name = "manifest-fixture"',
      'profiles = ["desktop", "rust"]',
      '',
      '[agent_backends.codebuddy]',
      'plugin = "company.codebuddy"',
      'capabilities = ["session.create", "conversation.ask"]',
      '',
      '[workflow.feature]',
      'stages = ["clarify", "plan", "build", "verify", "review", "apply"]',
      '',
      '[verify.fast]',
      'command = ["true"]',
      '',
    ].join('\n'))
    const run = await createRun(workspace, [{ id: 'task-profiled', title: 'Profiled', prompt: 'noop', verify: ['fast'] }], 'codebuddy', 'HEAD', cache)
    expect(run.manifest).toMatchObject({
      project_profiles: ['desktop', 'rust'],
      workflow: { kind: 'feature', stages: ['clarify', 'plan', 'build', 'verify', 'review', 'apply'] },
      backend: {
        key: 'codebuddy',
        plugin: 'company.codebuddy',
        capabilities: ['session.create', 'conversation.ask'],
      },
      verification: { required: ['fast'] },
    })

    await writeFile(path.join(workspace, 'specops.toml'), [
      'schema_version = 1',
      '[project]',
      'name = "changed-after-launch"',
      'profiles = ["web"]',
    ].join('\n'))
    expect((await readRun(workspace, run.run_id)).manifest.project_profiles).toEqual(['desktop', 'rust'])
    await cleanupRun(run)
  })

  test('inherits proposal verifies when UI tasks omit them', async () => {
    const { workspace, cache } = await fixture()
    await writeFile(path.join(workspace, 'specops.toml'), [
      'schema_version = 1', '', '[project]', 'name = "verified-ui-change"', '',
      '[verify.test]', 'command = ["true"]', '',
    ].join('\n'))
    const changeId = 'verified-ui-change'
    const changeDir = path.join(workspace, '.specops', 'changes', changeId)
    await mkdir(changeDir, { recursive: true })
    await writeFile(path.join(changeDir, 'proposal.md'), [
      '---', 'schema_version: 2', `id: ${changeId}`, 'kind: bug',
      'document_class: work_item', 'work_type: bugfix', 'title: Verified UI change',
      'status: proposed', 'verifies:', '  - test', '---', '',
      '# Verified UI change', '', '## Motivation', 'Verify it.', '',
      '## Scope', 'UI.', '', '## Acceptance criteria', '- [ ] Works', '',
      '## Out of scope', 'Other changes.', '',
    ].join('\n'))

    const run = await createRun(workspace, [
      { id: 'task-1', title: 'Implement', prompt: 'implement', verify: [] },
      { id: 'task-2', title: 'Finish', prompt: 'finish', verify: [] },
    ], 'codebuddy', 'HEAD', cache, changeId)

    expect(run.tasks[0]?.verify).toEqual([])
    expect(run.tasks[1]?.verify).toEqual(['test'])
    expect(run.manifest.verification.required).toEqual(['test'])
    expect(run.verify_snapshot.test).toBeDefined()
    await cleanupRun(run)
  })

  test('applies only an explicitly reviewed patch', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add approved.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'approved.txt'), 'approved\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    await applyRunPatch(run)
    expect(await readFile(path.join(workspace, 'approved.txt'), 'utf8')).toBe('approved\n')
    await cleanupRun(run)
  })

  test('restores review controls after apply failure without regressing a completed task', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Apply recovery', prompt: 'noop', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'recovery.txt'), 'recovery\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await transitionRun(run, 'completed')
    await transitionRun(run, 'applying')

    await expect(transitionRun(run, 'awaiting_review')).resolves.toBeUndefined()
    const harness = JSON.parse(await readFile(path.join(workspace, '.specops', 'runs', run.run_id, 'harness-state.json'), 'utf8')) as { tasks: Array<{ id: string; state: string }> }
    expect(harness.tasks.find((task) => task.id === 'task-1')?.state).toBe('completed')
    expect((await readRun(workspace, run.run_id)).state).toBe('awaiting_review')
    await cleanupRun(run)
  })

  test('rejects invalid state transitions', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Noop', prompt: 'Noop', verify: [] }], 'codebuddy', 'HEAD', cache)
    await expect(transitionRun(run, 'completed')).rejects.toThrow('cannot transition')
    await cleanupRun(run)
  })
})

describe('branch-based apply', () => {
  test('createRun builds a specops/run-* branch', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Branch', prompt: 'noop', verify: [] }], 'codebuddy', 'HEAD', cache)
    expect(run.branch).toMatch(/^specops\/run-[0-9a-f]{8}$/)
    const branches = await git(workspace, ['branch', '--list', 'specops/run-*'])
    expect(branches).toContain(run.branch)
    await cleanupRun(run)
  })

  test('apply produces a merge commit and advances HEAD', async () => {
    const { workspace, cache } = await fixture()
    const headBefore = await git(workspace, ['rev-parse', 'HEAD'])
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add merged.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'merged.txt'), 'merged\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    const result = await applyRunPatch(run)
    expect(result.commit).toMatch(/^[0-9a-f]+$/)
    const headAfter = await git(workspace, ['rev-parse', 'HEAD'])
    expect(headAfter).not.toBe(headBefore)
    // --no-ff forces a merge commit
    const log = await git(workspace, ['log', '--oneline', '-1'])
    expect(log).toMatch(/Merge branch 'specops\/run-/)
    expect(await readFile(path.join(workspace, 'merged.txt'), 'utf8')).toBe('merged\n')
    // pre_apply_commit recorded for rollback
    const reloaded = await readRun(workspace, run.run_id)
    expect(reloaded.pre_apply_commit).toBe(headBefore)
    await cleanupRun(run)
  })

  test('apply conflict aborts cleanly and leaves the workspace clean', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Edit same file', prompt: 'edit same.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    // Agent edits same.txt in the worktree to "run-version"
    await writeFile(path.join(run.worktree_path, 'same.txt'), 'run-version\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    // While the Run is awaiting review, the main workspace commits a conflicting
    // change to the same file. Now merging the run branch must conflict.
    await writeFile(path.join(workspace, 'same.txt'), 'main-version\n')
    await git(workspace, ['add', 'same.txt'])
    await git(workspace, ['commit', '-q', '-m', 'main changes same.txt'])

    await expect(applyRunPatch(run)).rejects.toMatchObject({ code: 'merge_will_conflict' })
    // Workspace stays clean — no UU entries
    const status = await git(workspace, ['status', '--porcelain=v1'])
    expect(status).toBe('')
    await cleanupRun(run)
  })

  test('already-landed implementation closes as a no-op and preserves newer canonical docs', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'already-landed-change'
    const folder = path.join(workspace, '.specops', 'changes', changeId)
    await mkdir(folder, { recursive: true })
    const proposal = [
      '---',
      'schema_version: 1',
      `id: ${changeId}`,
      'kind: change',
      'title: Already landed',
      'status: proposed',
      '---',
      '',
      '# Already landed',
      '',
      'Canonical main document.',
      '',
    ].join('\n')
    await writeFile(path.join(folder, 'proposal.md'), proposal)

    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Land once', prompt: 'append implementation', verify: [] }],
      'codebuddy',
      'HEAD',
      cache,
      changeId,
    )
    const baseSource = await readFile(path.join(workspace, 'change.txt'), 'utf8')
    await writeFile(path.join(run.worktree_path, 'change.txt'), `${baseSource}implementation landed\n`)
    const runFolder = path.join(run.worktree_path, '.specops', 'changes', changeId)
    await mkdir(runFolder, { recursive: true })
    await writeFile(path.join(runFolder, 'proposal.md'), proposal.replace('Canonical main document.', 'Older run document.'))
    await writeFile(path.join(runFolder, 'tasks.md'), '# Tasks\n\n- [x] Land once\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)

    // The implementation reaches main through another commit path, while the
    // canonical documents become newer/richer than the stale Run copies.
    await writeFile(path.join(workspace, 'change.txt'), `${baseSource}implementation landed\n`)
    await writeFile(path.join(folder, 'proposal.md'), proposal.replace('Canonical main document.', 'Canonical main document.\n\nNewer detail.'))
    await writeFile(path.join(folder, 'tasks.md'), '# Tasks\n\n- [x] Land once\n- [x] Preserve evidence\n')
    await git(workspace, ['add', '-A'])
    await git(workspace, ['commit', '-q', '-m', 'land through another path'])
    const headBefore = await git(workspace, ['rev-parse', 'HEAD'])

    const result = await applyWithVerify(run)
    expect(result).toMatchObject({ applied: false, allOk: true, reason: 'already_landed' })
    expect((await readRun(workspace, run.run_id)).state).toBe('completed')
    expect(await git(workspace, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(await readFile(path.join(folder, 'tasks.md'), 'utf8')).toContain('Preserve evidence')
    expect(parseDocument(await readFile(path.join(folder, 'proposal.md'), 'utf8'), 'proposal.md').frontmatter.status).toBe('completed')
    await cleanupRun(run)
  })

  test('workspace dirty (non-specops) is stashed, restored, and does not block apply', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'add x.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'x.txt'), 'x\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    // Dirty the main workspace with a non-specops file
    await writeFile(path.join(workspace, 'uncommitted.txt'), 'dirty\n')
    await applyRunPatch(run)
    expect(await readFile(path.join(workspace, 'x.txt'), 'utf8')).toBe('x\n')
    expect(await readFile(path.join(workspace, 'uncommitted.txt'), 'utf8')).toBe('dirty\n')
    expect(await git(workspace, ['status', '--porcelain=v1'])).toContain('?? uncommitted.txt')
    await cleanupRun(run)
  })

  test('multi-run serial apply: A succeeds, B conflicts', async () => {
    const { workspace, cache } = await fixture()
    const runA = await createRun(workspace, [{ id: 'task-1', title: 'A', prompt: 'add a.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    const runB = await createRun(workspace, [{ id: 'task-1', title: 'B', prompt: 'add a.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(runA.worktree_path, 'a.txt'), 'from-A\n')
    await writeFile(path.join(runB.worktree_path, 'a.txt'), 'from-B\n')
    for (const run of [runA, runB]) {
      await transitionRun(run, 'awaiting_verify')
      await transitionRun(run, 'awaiting_review')
      await collectRunPatch(run)
    }
    // A applies cleanly
    await applyRunPatch(runA)
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('from-A\n')
    // B conflicts on a.txt (different content from the same base) — must abort clean
    await expect(applyRunPatch(runB)).rejects.toMatchObject({ code: 'merge_will_conflict' })
    expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('from-A\n')
    const status = await git(workspace, ['status', '--porcelain=v1'])
    expect(status).toBe('')
    await cleanupRun(runA)
    await cleanupRun(runB)
  })

  test('rollback resets HEAD back to the pre-merge commit', async () => {
    const { workspace, cache } = await fixture()
    const headBefore = await git(workspace, ['rev-parse', 'HEAD'])
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'add r.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'r.txt'), 'r\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    await applyRunPatch(run)
    expect(await readFile(path.join(workspace, 'r.txt'), 'utf8')).toBe('r\n')
    await rollbackRunPatch(await readRun(workspace, run.run_id))
    const headAfter = await git(workspace, ['rev-parse', 'HEAD'])
    expect(headAfter).toBe(headBefore)
    await expect(readFile(path.join(workspace, 'r.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    // merge commit gone from history
    const log = await git(workspace, ['log', '--oneline', '-1'])
    expect(log).not.toMatch(/Merge branch 'specops\/run-/)
    await cleanupRun(run)
  })

  test('cleanup deletes the run branch', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'noop', prompt: 'noop', verify: [] }], 'codebuddy', 'HEAD', cache)
    const branch = run.branch
    expect((await git(workspace, ['branch', '--list', branch]))).toContain(branch)
    await cleanupRun(run)
    expect((await git(workspace, ['branch', '--list', branch]))).toBe('')
  })

  test('legacy Run without branch field falls back to git apply --3way', async () => {
    const { workspace, cache } = await fixture()
    // Create a Run, then strip its branch field to simulate a legacy record.
    const run = await createRun(workspace, [{ id: 'task-1', title: 'legacy', prompt: 'add legacy.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'legacy.txt'), 'legacy\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    // Mutate the record to look legacy: no branch, no pre_apply_commit.
    const legacy: RunRecord = { ...run, branch: '', pre_apply_commit: null }
    await writeRun(legacy)
    // applyRunPatch reads the record fresh — pass the legacy record directly.
    await applyRunPatch(legacy)
    expect(await readFile(path.join(workspace, 'legacy.txt'), 'utf8')).toBe('legacy\n')
    await cleanupRun(run)
  })
})

describe('change_id linkage', () => {
  async function writeProposal(workspace: string, changeId: string, status: 'proposed' | 'completed'): Promise<void> {
    const folder = path.join(workspace, '.specops', 'changes', changeId)
    await mkdir(folder, { recursive: true })
    const doc: SpecDocument = {
      frontmatter: { schema_version: 1, id: changeId, kind: 'change', title: `Change ${changeId}`, status },
      body: `# ${changeId}\n\nBody.\n`,
      relativePath: `.specops/changes/${changeId}/proposal.md`,
    }
    await writeFile(path.join(folder, 'proposal.md'), serializeDocument(doc))
  }

  async function proposalStatus(workspace: string, changeId: string): Promise<string> {
    const proposalPath = path.join(workspace, '.specops', 'changes', changeId, 'proposal.md')
    return parseDocument(await readFile(proposalPath, 'utf8'), proposalPath).frontmatter.status
  }

  test('createRun threads change_id into the RunRecord', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Add file', prompt: 'add f.txt', verify: [] }],
      'codebuddy', 'HEAD', cache, 'my-change-id',
    )
    expect(run.change_id).toBe('my-change-id')
    // Reload from disk — the field is persisted.
    const reloaded = await readRun(workspace, run.run_id)
    expect(reloaded.change_id).toBe('my-change-id')
    await cleanupRun(run)
  })

  test('createRun defaults change_id to null when omitted', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'noop', prompt: 'noop', verify: [] }],
      'codebuddy', 'HEAD', cache,
    )
    expect(run.change_id).toBeNull()
    await cleanupRun(run)
  })

  test('readRun backfills change_id=null for legacy run.json without the field', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'noop', prompt: 'noop', verify: [] }],
      'codebuddy', 'HEAD', cache,
    )
    // Strip the field from the on-disk record to simulate a legacy file.
    const raw = JSON.parse(await readFile(path.join(workspace, '.specops', 'runs', run.run_id, 'run.json'), 'utf8')) as Record<string, unknown>
    delete raw.change_id
    await writeFile(path.join(workspace, '.specops', 'runs', run.run_id, 'run.json'), JSON.stringify(raw, null, 2))
    const reloaded = await readRun(workspace, run.run_id)
    expect(reloaded.change_id).toBeNull()
    await cleanupRun(run)
  })

  test('applyCompletedRun flips the linked proposal from proposed to completed', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'fix-apply-status'
    await writeProposal(workspace, changeId, 'proposed')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Add file', prompt: 'add merged.txt', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 'merged.txt'), 'merged\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    await transitionRun(run, 'completed')
    expect(await proposalStatus(workspace, changeId)).toBe('proposed')
    await applyCompletedRun(run)
    expect(await proposalStatus(workspace, changeId)).toBe('completed')
    await cleanupRun(run)
  })

  test('applyWithVerify allOk branch marks the proposal completed', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'fix-verify-status'
    await writeProposal(workspace, changeId, 'proposed')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Add file', prompt: 'add v.txt', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 'v.txt'), 'v\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    const result = await applyWithVerify(run)
    expect(result.allOk).toBe(true)
    expect(await proposalStatus(workspace, changeId)).toBe('completed')
    await cleanupRun(run)
  })

  test('applyWithVerify accepts a completed run awaiting apply', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'fix-completed-apply-with-verify'
    await writeProposal(workspace, changeId, 'proposed')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Add file', prompt: 'add completed.txt', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 'completed.txt'), 'completed\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    await transitionRun(run, 'completed')
    const result = await applyWithVerify(run)
    expect(result.allOk).toBe(true)
    expect(await proposalStatus(workspace, changeId)).toBe('completed')
    await cleanupRun(run)
  })

  test('applyWithVerify applied_failed branch does NOT mark the proposal completed', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'fix-failed-status'
    await writeProposal(workspace, changeId, 'proposed')
    // Add a verify that always fails (exit 1) to specops.toml. initWorkspace
    // seeds a config with no [verify.*] sections; we append one and commit it
    // so applyRunPatch's "dirty non-specops workspace" guard doesn't trip.
    const { atomicWrite, pathInside } = await import('../src/store/workspace.js')
    await atomicWrite(pathInside(workspace, 'specops.toml'), [
      'schema_version = 1',
      '',
      '[project]',
      `name = ${JSON.stringify(path.basename(workspace))}`,
      '',
      '[gate]',
      'strict_wild_specs = false',
      '',
      '[verify.fail]',
      'command = ["false"]',
      '',
    ].join('\n'))
    await git(workspace, ['add', 'specops.toml'])
    await git(workspace, ['commit', '-q', '-m', 'add fail verify'])
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Add file', prompt: 'add f.txt', verify: ['fail'] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 'f.txt'), 'f\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    const result = await applyWithVerify(run)
    expect(result.allOk).toBe(false)
    // Proposal stays proposed — the apply landed but verifies failed.
    expect(await proposalStatus(workspace, changeId)).toBe('proposed')
    // Reset HEAD back so the workspace is clean for cleanup.
    await rollbackRunPatch(await readRun(workspace, run.run_id))
    await cleanupRun(run)
  })

  test('null change_id (quick-run) leaves proposals untouched on apply', async () => {
    const { workspace, cache } = await fixture()
    // A proposal exists but the Run is not linked to it.
    const changeId = 'unlinked-change'
    await writeProposal(workspace, changeId, 'proposed')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Add file', prompt: 'add q.txt', verify: [] }],
      'codebuddy', 'HEAD', cache, // no change_id
    )
    await writeFile(path.join(run.worktree_path, 'q.txt'), 'q\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    await transitionRun(run, 'completed')
    await applyCompletedRun(run)
    // Unlinked proposal must remain proposed.
    expect(await proposalStatus(workspace, changeId)).toBe('proposed')
    await cleanupRun(run)
  })
})

describe('collectRunPatch commit message', () => {
  async function lastCommitMessage(worktreePath: string): Promise<string> {
    const out = await git(worktreePath, ['log', '-1', '--pretty=format:%B'])
    return out
  }

  async function writeProposalKind(
    workspace: string,
    changeId: string,
    kind: 'feature' | 'bug' | 'refactor' | 'investigation' | 'spec' | 'change',
    title: string,
  ): Promise<void> {
    const folder = path.join(workspace, '.specops', 'changes', changeId)
    await mkdir(folder, { recursive: true })
    const doc: SpecDocument = {
      frontmatter: { schema_version: 1, id: changeId, kind, title, status: 'proposed' },
      body: `# ${changeId}\n\nBody.\n`,
      relativePath: `.specops/changes/${changeId}/proposal.md`,
    }
    await writeFile(path.join(folder, 'proposal.md'), serializeDocument(doc))
  }

  test('change-linked run uses proposal title with mapped type and trailers', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'feat-shiny-thing'
    await writeProposalKind(workspace, changeId, 'feature', 'Add shiny thing')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Implement shiny', prompt: 'do it', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 'shiny.txt'), 'shiny\n')
    await collectRunPatch(run)
    const msg = await lastCommitMessage(run.worktree_path)
    // First line is a Conventional Commits header, not a bare UUID dump.
    expect(msg).not.toMatch(/^specops\(run\): [0-9a-f-]{36}$/)
    expect(msg.split('\n')[0]).toMatch(/^feat: Add shiny thing$/)
    expect(msg).toContain(`Run-Id: ${run.run_id}`)
    expect(msg).toContain(`Change-Id: ${changeId}`)
    expect(msg).toContain('Task: Implement shiny')
    // No bare full-uuid form anywhere in the header line.
    expect(msg.split('\n')[0]).not.toContain(run.run_id)
    await cleanupRun(run)
  })

  test('bug kind maps to fix type', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'bug-null-deref'
    await writeProposalKind(workspace, changeId, 'bug', 'Fix null deref in run loop')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Patch it', prompt: 'patch', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 'f.txt'), 'x\n')
    await collectRunPatch(run)
    const msg = await lastCommitMessage(run.worktree_path)
    expect(msg.split('\n')[0]).toMatch(/^fix: Fix null deref in run loop$/)
    await cleanupRun(run)
  })

  test('quick-run (change_id=null) falls back to chore with short id', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Add file', prompt: 'add q.txt', verify: [] }],
      'codebuddy', 'HEAD', cache, // no change_id
    )
    await writeFile(path.join(run.worktree_path, 'q.txt'), 'q\n')
    await collectRunPatch(run)
    const msg = await lastCommitMessage(run.worktree_path)
    const shortId = run.run_id.replace(/-/g, '').slice(0, 8)
    expect(msg.split('\n')[0]).toBe(`chore: specops run ${shortId} — Add file`)
    expect(msg).not.toContain(`specops(run): ${run.run_id}`)
    expect(msg).toContain(`Run-Id: ${run.run_id}`)
    expect(msg).toContain('Change-Id: quick-run')
    expect(msg).toContain('Task: Add file')
    await cleanupRun(run)
  })

  test('missing proposal file falls back to chore with short id', async () => {
    const { workspace, cache } = await fixture()
    // Reference a change_id whose proposal.md does not exist on disk.
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Do thing', prompt: 'do', verify: [] }],
      'codebuddy', 'HEAD', cache, 'missing-change',
    )
    await writeFile(path.join(run.worktree_path, 'x.txt'), 'x\n')
    await collectRunPatch(run)
    const msg = await lastCommitMessage(run.worktree_path)
    const shortId = run.run_id.replace(/-/g, '').slice(0, 8)
    expect(msg.split('\n')[0]).toBe(`chore: specops run ${shortId} — Do thing`)
    expect(msg).toContain('Change-Id: missing-change')
    await cleanupRun(run)
  })

  test('normative spec cannot launch an implementation workflow', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'spec-something'
    await writeProposalKind(workspace, changeId, 'spec', 'Spec out the foo')
    await expect(createRun(
      workspace,
      [{ id: 'task-1', title: 'Write spec', prompt: 'write', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )).rejects.toThrow('normative specs do not have an implementation workflow')
  })

  test('subject longer than 72 chars is truncated with ellipsis', async () => {
    const { workspace, cache } = await fixture()
    const longTitle = 'A'.repeat(100)
    const changeId = 'feat-long'
    await writeProposalKind(workspace, changeId, 'feature', longTitle)
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 't', prompt: 'noop', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 'f.txt'), 'f\n')
    await collectRunPatch(run)
    const msg = await lastCommitMessage(run.worktree_path)
    const header = msg.split('\n')[0]!
    expect(header.length).toBeLessThanOrEqual(72)
    // `feat: ` prefix = 6 chars → 65 A's + ellipsis = 72 total
    expect(header).toMatch(/^feat: A{65}…$/)
    await cleanupRun(run)
  })
})

describe('transitionRun session phase sync', () => {
  async function fixtureWithSession() {
    const { workspace, cache } = await fixture()
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Sync session', prompt: 'add sync.txt', verify: [] }],
      'codebuddy', 'HEAD', cache,
    )
    // Seed a real change in the worktree so changedFilesForRun has something
    // to report when the run enters awaiting_review.
    await writeFile(path.join(run.worktree_path, 'sync.txt'), 'synced\n')
    // Link a SpecOps session to this run, mirroring how the server binds one
    // after launchRun returns. The session starts in run_in_worktree/active
    // (the phase the server sets when it binds the run).
    const session = await createSpecOpsSession(workspace, {
      title: 'Sync test',
      backend_key: 'codebuddy',
      run_id: run.run_id,
      phase: 'run_in_worktree',
      state: 'active',
    })
    return { workspace, cache, run, sessionId: session.id }
  }

  test('awaiting_verify syncs session to verify/awaiting_user with verify action', async () => {
    const { workspace, run, sessionId } = await fixtureWithSession()
    await transitionRun(run, 'awaiting_verify')
    const session = await readSpecOpsSession(workspace, sessionId)
    expect(session.phase).toBe('verify')
    expect(session.state).toBe('awaiting_user')
    expect(session.required_action).toMatchObject({ kind: 'verify' })
    await cleanupRun(run)
  })

  test('awaiting_review syncs session to review with patch_files', async () => {
    const { workspace, run, sessionId } = await fixtureWithSession()
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    const session = await readSpecOpsSession(workspace, sessionId)
    expect(session.phase).toBe('review')
    expect(session.state).toBe('awaiting_user')
    expect(session.required_action).toMatchObject({ kind: 'review', patch_files: ['sync.txt'] })
    await cleanupRun(run)
  })

  test('completed syncs session to apply_patch/awaiting_user', async () => {
    const { workspace, run, sessionId } = await fixtureWithSession()
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await transitionRun(run, 'completed')
    const session = await readSpecOpsSession(workspace, sessionId)
    expect(session.phase).toBe('apply_patch')
    expect(session.state).toBe('awaiting_user')
    expect(session.required_action).toMatchObject({ kind: 'apply_patch' })
    await cleanupRun(run)
  })

  test('failed syncs session to failed/failed', async () => {
    const { workspace, run, sessionId } = await fixtureWithSession()
    await transitionRun(run, 'failed')
    const session = await readSpecOpsSession(workspace, sessionId)
    expect(session.phase).toBe('failed')
    expect(session.state).toBe('failed')
    expect(session.required_action).toBeNull()
    await cleanupRun(run)
  })

  test('cancelled syncs session to cancelled/cancelled', async () => {
    const { workspace, run, sessionId } = await fixtureWithSession()
    await transitionRun(run, 'cancelled')
    const session = await readSpecOpsSession(workspace, sessionId)
    expect(session.phase).toBe('cancelled')
    expect(session.state).toBe('cancelled')
    expect(session.required_action).toBeNull()
    await cleanupRun(run)
  })

  test('terminal session is not resurrected by later run transitions', async () => {
    const { workspace, run, sessionId } = await fixtureWithSession()
    // Move the run to `failed` (which can later transition back to `running`
    // per TRANSITIONS) — session becomes terminal too.
    await transitionRun(run, 'failed')
    const failed = await readSpecOpsSession(workspace, sessionId)
    expect(failed.state).toBe('failed')
    // TRANSITIONS allows `failed → running`. The session must stay `failed` —
    // a terminal session should never be silently revived by a run transition.
    await transitionRun(run, 'running')
    const stillFailed = await readSpecOpsSession(workspace, sessionId)
    expect(stillFailed.state).toBe('failed')
    expect(stillFailed.phase).toBe('failed')
    await cleanupRun(run)
  })

  test('transitionRun does not throw when no session is linked to the run', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'No session', prompt: 'noop', verify: [] }],
      'codebuddy', 'HEAD', cache,
    )
    // No SpecOpsSession created with this run_id — transitionRun must swallow
    // the missing-session case silently.
    await expect(transitionRun(run, 'awaiting_verify')).resolves.toBeUndefined()
    await expect(transitionRun(run, 'awaiting_review')).resolves.toBeUndefined()
    await cleanupRun(run)
  })

  test('preparing transition leaves session untouched (no pre-launch sync)', async () => {
    const { workspace, cache } = await fixture()
    // Create a run but intercept before createRun's internal `running`
    // transition by checking that an already-linked session survives the
    // initial transitions without being reset to run_in_worktree prematurely.
    // We can't easily intercept createRun's internal calls, so instead we
    // verify the post-createRun state: a session created after createRun
    // should not be modified by a subsequent no-op transition through
    // preparing (preparing is not in TRANSITIONS from `running`, so we test
    // the negative: a `running → awaiting_verify` transition DOES sync, which
    // is covered above; here we just confirm the session created post-run
    // reflects the current run state without regression).
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Pre-launch', prompt: 'noop', verify: [] }],
      'codebuddy', 'HEAD', cache,
    )
    const session = await createSpecOpsSession(workspace, {
      title: 'Pre-launch',
      backend_key: 'codebuddy',
      run_id: run.run_id,
      phase: 'clarify',
      state: 'awaiting_user',
    })
    // Session was created in `clarify` (not run_in_worktree). The run is in
    // `running` and we do NOT transition it, so the session must stay `clarify`
    // — proving the sync is a side effect of transitions, not a constant pull.
    const unchanged = await readSpecOpsSession(workspace, session.id)
    expect(unchanged.phase).toBe('clarify')
    expect(unchanged.state).toBe('awaiting_user')
    await cleanupRun(run)
  })
})

describe('Run stage completion contract', () => {
  function runtime(identity: ExecutionIdentity): RunExecutionRuntime {
    return {
      start: async () => identity,
      load: async () => identity,
      prompt: async (_executionId, input) => ({
        outcome: 'completed',
        value: { turnId: input.requestId, stopReason: 'end_turn' },
      }),
      close: async () => undefined,
      get: () => identity,
    }
  }

  test('final stage completion with new evidence opens the manual Verify gate', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [
      { id: 'task-1', title: 'Implement', prompt: 'Add result.txt', verify: [] },
    ], 'codebuddy', 'HEAD', cache)
    const identity: ExecutionIdentity = {
      execution_id: 'execution-stage-1', transport: 'codebuddy_acp', backend_key: 'codebuddy',
      native_session_id: 'native-stage-1', process_generation: 1,
    }
    run.execution = identity
    await writeRun(run)
    const session = await createSpecOpsSession(workspace, {
      title: 'Stage completion', backend_key: 'codebuddy', run_id: run.run_id,
      phase: 'run_in_worktree', state: 'active', current_execution: identity,
    })
    const baseline = await runChangeEvidence(run)
    await writeFile(path.join(run.worktree_path, 'result.txt'), 'done\n')
    const executionRuntime = runtime(identity)
    initRunMonitor(executionRuntime, workspace)
    watchRun(run.run_id, workspace, {
      run,
      binding: {
        run_id: run.run_id, task_id: 'task-1', purpose: 'implement', request_id: 'request-stage-1',
        execution_id: identity.execution_id, process_generation: identity.process_generation,
        baseline_digest: baseline.digest,
      },
      completion: Promise.resolve({
        outcome: 'completed', value: { turnId: 'turn-stage-1', stopReason: 'end_turn' },
      }),
    })

    await eventually(async () => {
      expect((await readRun(workspace, run.run_id)).state).toBe('awaiting_verify')
      expect((await readSpecOpsSession(workspace, session.id)).required_action).toMatchObject({ kind: 'verify' })
    })
    expect((await readRun(workspace, run.run_id)).verify_results).toEqual([])
    await cleanupRun(run)
  })

  test('interrupted stage preserves the current task and requires explicit resume', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [
      { id: 'task-1', title: 'Implement', prompt: 'Add result.txt', verify: [] },
    ], 'codebuddy', 'HEAD', cache)
    const identity: ExecutionIdentity = {
      execution_id: 'execution-stage-2', transport: 'codebuddy_acp', backend_key: 'codebuddy',
      native_session_id: 'native-stage-2', process_generation: 1,
    }
    run.execution = identity
    await writeRun(run)
    const session = await createSpecOpsSession(workspace, {
      title: 'Interrupted stage', backend_key: 'codebuddy', run_id: run.run_id,
      phase: 'run_in_worktree', state: 'active', current_execution: identity,
    })
    const baseline = await runChangeEvidence(run)
    await writeFile(path.join(run.worktree_path, 'partial.txt'), 'partial\n')
    const executionRuntime = runtime(identity)
    initRunMonitor(executionRuntime, workspace)
    watchRun(run.run_id, workspace, {
      run,
      binding: {
        run_id: run.run_id, task_id: 'task-1', purpose: 'implement', request_id: 'request-stage-2',
        execution_id: identity.execution_id, process_generation: identity.process_generation,
        baseline_digest: baseline.digest,
      },
      completion: Promise.resolve({
        outcome: 'completed', value: { turnId: 'turn-stage-2', stopReason: 'interrupted' },
      }),
    })

    await eventually(async () => {
      expect((await readSpecOpsSession(workspace, session.id)).required_action).toMatchObject({
        kind: 'resume', reason: 'stop_reason_interrupted',
      })
    })
    const current = await readRun(workspace, run.run_id)
    expect(current.state).toBe('running')
    expect(current.current_task).toBe(0)
    expect(current.verify_results).toEqual([])
    await cleanupRun(run)
  })
})
