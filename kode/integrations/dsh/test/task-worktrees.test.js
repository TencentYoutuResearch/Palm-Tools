import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TaskWorktrees } from '../src/task-worktrees.js'
import { taskStartingSnapshot } from '../src/task-workspace-snapshot.js'
import { captureArtifactSnapshot } from '../src/artifact-snapshot.js'
import { artifactSnapshotHash } from '../src/artifact-archive.js'
const execute = promisify(execFile)
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-task-worktrees-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repository = join(root, 'repository'); await mkdir(repository)
  const git = async (...args) => (await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-C', repository, ...args])).stdout.trim()
  await git('init'); await writeFile(join(repository, 'tracked.txt'), 'base\n'); await git('add', '.'); await git('commit', '-m', 'baseline')
  const base = await git('rev-parse', 'HEAD')
  await writeFile(join(repository, 'tracked.txt'), 'original dirty\n')
  await writeFile(join(repository, 'untracked.txt'), 'original untracked\n')
  return { root, repository, git, base, input: run_id => ({ home: 'home', host: 'host', run_id, repository_binding: 'source', repository }) }
}
test('two tasks concurrently create distinct registered branches from one fixed Git base and preserve dirty source', async t => {
  const f = await fixture(t), manager = new TaskWorktrees(join(f.root, 'tasks'))
  t.after(() => manager.close())
  const [a, b] = await Promise.all([manager.prepare(f.input('run-a')), manager.prepare(f.input('run-b'))])
  assert.notEqual(a.root, b.root); assert.notEqual(a.branch, b.branch)
  assert.equal(a.base_commit, f.base); assert.equal(b.base_commit, f.base)
  await Promise.all([writeFile(join(a.root, 'tracked.txt'), 'task a\n'), writeFile(join(b.root, 'tracked.txt'), 'task b\n')])
  assert.equal(await readFile(join(a.root, 'tracked.txt'), 'utf8'), 'task a\n')
  assert.equal(await readFile(join(b.root, 'tracked.txt'), 'utf8'), 'task b\n')
  assert.equal(await readFile(join(f.repository, 'tracked.txt'), 'utf8'), 'original dirty\n')
  assert.equal(await readFile(join(f.repository, 'untracked.txt'), 'utf8'), 'original untracked\n')
  assert.equal(await f.git('rev-parse', 'HEAD'), f.base)
  assert.equal(await manager.validate(a), a.root)
  const restarted = new TaskWorktrees(join(f.root, 'tasks')); t.after(() => restarted.close())
  assert.deepEqual(await restarted.prepare(f.input('run-a')), a)
  assert.equal(await readFile(join(a.root, 'tracked.txt'), 'utf8'), 'task a\n')
})
test('a pinned task survives original HEAD advancement and rejects identity or branch replacement', async t => {
  const f = await fixture(t), manager = new TaskWorktrees(join(f.root, 'tasks')); t.after(() => manager.close())
  const a = await manager.prepare(f.input('run-a'))
  await f.git('add', 'tracked.txt'); await f.git('commit', '-m', 'later original commit')
  assert.deepEqual(await manager.prepare(f.input('run-a')), a)
  const other = join(f.root, 'other'); await mkdir(other)
  await assert.rejects(manager.prepare({ ...f.input('run-a'), repository: other }), /identity conflict/)
  await execute('git', ['-C', a.root, 'switch', '-c', 'unexpected'])
  await assert.rejects(manager.prepare(f.input('run-a')), /Git identity changed/)
})
test('non Git roots and symlink storage fail closed without touching source bytes', async t => {
  const f = await fixture(t), plain = join(f.root, 'plain'); await mkdir(plain)
  const manager = new TaskWorktrees(join(f.root, 'tasks')); t.after(() => manager.close())
  await assert.rejects(manager.prepare({ ...f.input('plain-run'), repository: plain }), /non-Git workspaces are unsupported/)
  await symlink(f.repository, join(f.root, 'linked-tasks'))
  const linked = new TaskWorktrees(join(f.root, 'linked-tasks')); t.after(() => linked.close())
  await assert.rejects(linked.prepare(f.input('run-a')), /canonical/)
  assert.equal(await readFile(join(f.repository, 'tracked.txt'), 'utf8'), 'original dirty\n')
})
test('Home rejection precedes any branch or checkout effect; an authorized lost-ready reply recovers one checkout', async t => {
  const f = await fixture(t), manager = new TaskWorktrees(join(f.root, 'tasks')); t.after(() => manager.close())
  await assert.rejects(manager.prepare(f.input('run-a'), { authorize: async () => { throw Error('grant revoked') } }), /grant revoked/)
  assert.equal((await f.git('worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1)
  assert.equal(await f.git('branch', '--list', 'kode/task-*'), '')
  const a = await manager.prepare(f.input('run-a'), { authorize: async planned => {
    assert.equal(planned.base_commit, f.base)
    assert.equal((await f.git('worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 1)
  } })
  const journal = join(f.root, 'tasks', a.key, 'receipt.json')
  const saved = JSON.parse(await readFile(journal, 'utf8')); saved.status = 'planned'; await writeFile(journal, JSON.stringify(saved))
  const restarted = new TaskWorktrees(join(f.root, 'tasks')); t.after(() => restarted.close())
  assert.deepEqual(await restarted.prepare(f.input('run-a'), { authorize: async () => {} }), a)
  assert.equal((await f.git('worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')).length, 2)
})
test('raw base checkout runs neither configured filters nor post-checkout hooks', async t => {
  const f = await fixture(t), marker = join(f.root, 'unexpected-filter-effect')
  await writeFile(join(f.repository, '.gitattributes'), 'tracked.txt filter=sentinel\n')
  await f.git('add', '.gitattributes'); await f.git('commit', '-m', 'attributes')
  await f.git('config', 'filter.sentinel.smudge', `touch '${marker}'; cat`)
  await f.git('config', 'filter.sentinel.required', 'true')
  await writeFile(join(f.repository, '.git/hooks/post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  const manager = new TaskWorktrees(join(f.root, 'tasks')); t.after(() => manager.close())
  const a = await manager.prepare(f.input('run-a'))
  assert.equal(await readFile(join(a.root, 'tracked.txt'), 'utf8'), 'base\n')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.repository, 'tracked.txt'), 'utf8'), 'original dirty\n')
})
test('starting content proves fixed base or exact frozen artifact; identity does not excuse changed bytes', async t => {
  const f = await fixture(t), manager = new TaskWorktrees(join(f.root, 'tasks')); t.after(() => manager.close())
  const a = await manager.prepare(f.input('run-a')), repository = { repository_id: 'repo' }, signal = new AbortController().signal
  const runtime = { taskWorktrees: manager }
  const base = await taskStartingSnapshot(runtime, { task_workspace_input: { basis: 'git_base' } }, repository, a, signal)
  assert.match(base.snapshot_hash, /^[a-f0-9]{64}$/)
  await writeFile(join(a.root, 'tracked.txt'), 'previous task artifact\n')
  await assert.rejects(taskStartingSnapshot(runtime, { task_workspace_input: { basis: 'git_base' } }, repository, a, signal), /differs from its fixed Git base/)
  const snapshot_hash = artifactSnapshotHash({ kind: 'artifact', snapshot: await captureArtifactSnapshot({ workspaceRoot: a.root, repositoryId: 'repo', signal }) })
  for (const basis of ['frozen_artifact', 'rework_artifact']) {
    const expected = { basis, source_sequence: 7, snapshot_hash }
    assert.deepEqual(await taskStartingSnapshot(runtime, { task_workspace_input: expected }, repository, a, signal), expected)
    await assert.rejects(taskStartingSnapshot(runtime, { task_workspace_input: { ...expected, snapshot_hash: '0'.repeat(64) } }, repository, a, signal), /differs from its frozen input artifact/)
  }
  const resumed = { basis: 'owner_resumed_task', resume_request_id: 'resume', stage_attempt: 2, context_hash: 'context', task_workspace_key: a.key }
  assert.deepEqual(await taskStartingSnapshot(runtime, { task_workspace_input: resumed }, repository, a, signal), { ...resumed, snapshot_hash })
  await assert.rejects(taskStartingSnapshot(runtime, { task_workspace_input: { basis: 'unknown' } }, repository, a, signal), /Frozen task starting content basis unavailable/)
})
