import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { initWorkspace } from '../src/domain/commands.js';
import { applyRunPatch, cleanupRun, collectRunPatch, createRun, readRun, rollbackRunPatch, transitionRun, writeRun } from '../src/domain/run.js';
import { git, gitCommit, gitWorkspace } from './helpers.js';
const cleanup = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});
async function fixture() {
    const workspace = await gitWorkspace();
    const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-cache-'));
    cleanup.push(workspace, cache);
    await initWorkspace(workspace);
    await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
    return { workspace, cache };
}
describe('Run worktree isolation', () => {
    test('captures changes without modifying the primary worktree', async () => {
        const { workspace, cache } = await fixture();
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add isolated.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        await writeFile(path.join(run.worktree_path, 'isolated.txt'), 'run output\n');
        const result = await collectRunPatch(run);
        expect(result.files).toContain('isolated.txt');
        expect(result.patch).toContain('run output');
        await expect(readFile(path.join(workspace, 'isolated.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await readRun(workspace, run.run_id)).worktree_path).toBe(run.worktree_path);
        await cleanupRun(run);
    });
    test('applies only an explicitly reviewed patch', async () => {
        const { workspace, cache } = await fixture();
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add approved.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        await writeFile(path.join(run.worktree_path, 'approved.txt'), 'approved\n');
        await transitionRun(run, 'awaiting_verify');
        await transitionRun(run, 'awaiting_review');
        await collectRunPatch(run);
        await applyRunPatch(run);
        expect(await readFile(path.join(workspace, 'approved.txt'), 'utf8')).toBe('approved\n');
        await cleanupRun(run);
    });
    test('rejects invalid state transitions', async () => {
        const { workspace, cache } = await fixture();
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Noop', prompt: 'Noop', verify: [] }], 'codebuddy', 'HEAD', cache);
        await expect(transitionRun(run, 'completed')).rejects.toThrow('cannot transition');
        await cleanupRun(run);
    });
});
describe('branch-based apply', () => {
    test('createRun builds a specops/run-* branch', async () => {
        const { workspace, cache } = await fixture();
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Branch', prompt: 'noop', verify: [] }], 'codebuddy', 'HEAD', cache);
        expect(run.branch).toMatch(/^specops\/run-[0-9a-f]{8}$/);
        const branches = await git(workspace, ['branch', '--list', 'specops/run-*']);
        expect(branches).toContain(run.branch);
        await cleanupRun(run);
    });
    test('apply produces a merge commit and advances HEAD', async () => {
        const { workspace, cache } = await fixture();
        const headBefore = await git(workspace, ['rev-parse', 'HEAD']);
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'Add merged.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        await writeFile(path.join(run.worktree_path, 'merged.txt'), 'merged\n');
        await transitionRun(run, 'awaiting_verify');
        await transitionRun(run, 'awaiting_review');
        await collectRunPatch(run);
        const result = await applyRunPatch(run);
        expect(result.commit).toMatch(/^[0-9a-f]+$/);
        const headAfter = await git(workspace, ['rev-parse', 'HEAD']);
        expect(headAfter).not.toBe(headBefore);
        // --no-ff forces a merge commit
        const log = await git(workspace, ['log', '--oneline', '-1']);
        expect(log).toMatch(/Merge branch 'specops\/run-/);
        expect(await readFile(path.join(workspace, 'merged.txt'), 'utf8')).toBe('merged\n');
        // pre_apply_commit recorded for rollback
        const reloaded = await readRun(workspace, run.run_id);
        expect(reloaded.pre_apply_commit).toBe(headBefore);
        await cleanupRun(run);
    });
    test('apply conflict aborts cleanly and leaves the workspace clean', async () => {
        const { workspace, cache } = await fixture();
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Edit same file', prompt: 'edit same.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        // Agent edits same.txt in the worktree to "run-version"
        await writeFile(path.join(run.worktree_path, 'same.txt'), 'run-version\n');
        await transitionRun(run, 'awaiting_verify');
        await transitionRun(run, 'awaiting_review');
        await collectRunPatch(run);
        // While the Run is awaiting review, the main workspace commits a conflicting
        // change to the same file. Now merging the run branch must conflict.
        await writeFile(path.join(workspace, 'same.txt'), 'main-version\n');
        await git(workspace, ['add', 'same.txt']);
        await git(workspace, ['commit', '-q', '-m', 'main changes same.txt']);
        await expect(applyRunPatch(run)).rejects.toMatchObject({ code: 'merge_will_conflict' });
        // Workspace stays clean — no UU entries
        const status = await git(workspace, ['status', '--porcelain=v1']);
        expect(status).toBe('');
        await cleanupRun(run);
    });
    test('workspace dirty (non-specops) blocks apply', async () => {
        const { workspace, cache } = await fixture();
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'add x.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        await writeFile(path.join(run.worktree_path, 'x.txt'), 'x\n');
        await transitionRun(run, 'awaiting_verify');
        await transitionRun(run, 'awaiting_review');
        await collectRunPatch(run);
        // Dirty the main workspace with a non-specops file
        await writeFile(path.join(workspace, 'uncommitted.txt'), 'dirty\n');
        await expect(applyRunPatch(run)).rejects.toMatchObject({ code: 'workspace_dirty' });
        await cleanupRun(run);
    });
    test('multi-run serial apply: A succeeds, B conflicts', async () => {
        const { workspace, cache } = await fixture();
        const runA = await createRun(workspace, [{ id: 'task-1', title: 'A', prompt: 'add a.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        const runB = await createRun(workspace, [{ id: 'task-1', title: 'B', prompt: 'add a.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        await writeFile(path.join(runA.worktree_path, 'a.txt'), 'from-A\n');
        await writeFile(path.join(runB.worktree_path, 'a.txt'), 'from-B\n');
        for (const run of [runA, runB]) {
            await transitionRun(run, 'awaiting_verify');
            await transitionRun(run, 'awaiting_review');
            await collectRunPatch(run);
        }
        // A applies cleanly
        await applyRunPatch(runA);
        expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('from-A\n');
        // B conflicts on a.txt (different content from the same base) — must abort clean
        await expect(applyRunPatch(runB)).rejects.toMatchObject({ code: 'merge_will_conflict' });
        expect(await readFile(path.join(workspace, 'a.txt'), 'utf8')).toBe('from-A\n');
        const status = await git(workspace, ['status', '--porcelain=v1']);
        expect(status).toBe('');
        await cleanupRun(runA);
        await cleanupRun(runB);
    });
    test('rollback resets HEAD back to the pre-merge commit', async () => {
        const { workspace, cache } = await fixture();
        const headBefore = await git(workspace, ['rev-parse', 'HEAD']);
        const run = await createRun(workspace, [{ id: 'task-1', title: 'Add file', prompt: 'add r.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        await writeFile(path.join(run.worktree_path, 'r.txt'), 'r\n');
        await transitionRun(run, 'awaiting_verify');
        await transitionRun(run, 'awaiting_review');
        await collectRunPatch(run);
        await applyRunPatch(run);
        expect(await readFile(path.join(workspace, 'r.txt'), 'utf8')).toBe('r\n');
        await rollbackRunPatch(await readRun(workspace, run.run_id));
        const headAfter = await git(workspace, ['rev-parse', 'HEAD']);
        expect(headAfter).toBe(headBefore);
        await expect(readFile(path.join(workspace, 'r.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        // merge commit gone from history
        const log = await git(workspace, ['log', '--oneline', '-1']);
        expect(log).not.toMatch(/Merge branch 'specops\/run-/);
        await cleanupRun(run);
    });
    test('cleanup deletes the run branch', async () => {
        const { workspace, cache } = await fixture();
        const run = await createRun(workspace, [{ id: 'task-1', title: 'noop', prompt: 'noop', verify: [] }], 'codebuddy', 'HEAD', cache);
        const branch = run.branch;
        expect((await git(workspace, ['branch', '--list', branch]))).toContain(branch);
        await cleanupRun(run);
        expect((await git(workspace, ['branch', '--list', branch]))).toBe('');
    });
    test('legacy Run without branch field falls back to git apply --3way', async () => {
        const { workspace, cache } = await fixture();
        // Create a Run, then strip its branch field to simulate a legacy record.
        const run = await createRun(workspace, [{ id: 'task-1', title: 'legacy', prompt: 'add legacy.txt', verify: [] }], 'codebuddy', 'HEAD', cache);
        await writeFile(path.join(run.worktree_path, 'legacy.txt'), 'legacy\n');
        await transitionRun(run, 'awaiting_verify');
        await transitionRun(run, 'awaiting_review');
        await collectRunPatch(run);
        // Mutate the record to look legacy: no branch, no pre_apply_commit.
        const legacy = { ...run, branch: '', pre_apply_commit: null };
        await writeRun(legacy);
        // applyRunPatch reads the record fresh — pass the legacy record directly.
        await applyRunPatch(legacy);
        expect(await readFile(path.join(workspace, 'legacy.txt'), 'utf8')).toBe('legacy\n');
        await cleanupRun(run);
    });
});
