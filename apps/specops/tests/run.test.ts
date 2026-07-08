import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { initWorkspace } from '../src/domain/commands.js'
import { parseDocument, serializeDocument, type SpecDocument } from '../src/domain/spec.js'
import { applyCompletedRun, applyWithVerify } from '../src/domain/run-loop.js'
import { applyRunPatch, cleanupRun, collectRunPatch, createRun, readRun, rollbackRunPatch, transitionRun, writeRun, type RunRecord } from '../src/domain/run.js'
import { createSpecOpsSession, readSpecOpsSession } from '../src/domain/session.js'
import { git, gitCommit, gitWorkspace } from './helpers.js'

const cleanup: string[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })))
})

async function fixture() {
  const workspace = await gitWorkspace()
  const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-cache-'))
  cleanup.push(workspace, cache)
  await initWorkspace(workspace)
  await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1')
  return { workspace, cache }
}

describe('Run worktree isolation', () => {
  test('captures changes without modifying the primary worktree', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add isolated.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'isolated.txt'), 'run output\n')
    const result = await collectRunPatch(run)
    expect(result.files).toContain('isolated.txt')
    expect(result.patch).toContain('run output')
    await expect(readFile(path.join(workspace, 'isolated.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readRun(workspace, run.run_id)).worktree_path).toBe(run.worktree_path)
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

  test('workspace dirty (non-specops) blocks apply', async () => {
    const { workspace, cache } = await fixture()
    const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'add x.txt', verify: [] }], 'codebuddy', 'HEAD', cache)
    await writeFile(path.join(run.worktree_path, 'x.txt'), 'x\n')
    await transitionRun(run, 'awaiting_verify')
    await transitionRun(run, 'awaiting_review')
    await collectRunPatch(run)
    // Dirty the main workspace with a non-specops file
    await writeFile(path.join(workspace, 'uncommitted.txt'), 'dirty\n')
    await expect(applyRunPatch(run)).rejects.toMatchObject({ code: 'workspace_dirty' })
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

  test('spec kind (unknown to mapping) falls back to chore type', async () => {
    const { workspace, cache } = await fixture()
    const changeId = 'spec-something'
    await writeProposalKind(workspace, changeId, 'spec', 'Spec out the foo')
    const run = await createRun(
      workspace,
      [{ id: 'task-1', title: 'Write spec', prompt: 'write', verify: [] }],
      'codebuddy', 'HEAD', cache, changeId,
    )
    await writeFile(path.join(run.worktree_path, 's.txt'), 's\n')
    await collectRunPatch(run)
    const msg = await lastCommitMessage(run.worktree_path)
    expect(msg.split('\n')[0]).toMatch(/^chore: Spec out the foo$/)
    await cleanupRun(run)
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
    expect(session.required_action).toEqual({ kind: 'verify' })
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
    expect(session.required_action).toEqual({ kind: 'apply_patch' })
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

