import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WorktreeCreator, registerWorktreeApi } from '../src/worktree-api.js'
const execute = promisify(execFile)

test('new worktree starts at HEAD, preserves original dirty files, and retries without another checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-worktree-')), repository = join(root, 'project')
  await mkdir(repository)
  const git = async args => (await execute('git', ['-C', repository, ...args])).stdout.trim()
  try {
    await git(['init', '-q']); await git(['config', 'core.hooksPath', join(root, 'no-hooks')])
    await writeFile(join(repository, 'tracked.txt'), 'committed\n'); await git(['add', 'tracked.txt'])
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initial'])
    const commit = await git(['rev-parse', 'HEAD'])
    await writeFile(join(repository, 'tracked.txt'), 'unfinished\n'); await writeFile(join(repository, 'untracked.txt'), 'keep\n')
    const creator = new WorktreeCreator(join(root, 'managed')), request = { requestId: 'fixture-request-0001', branch: 'kode/test-worktree' }
    const first = creator.create(repository, request), concurrent = creator.create(repository, request)
    assert.equal(first, concurrent)
    const result = await first
    assert.equal(result.baseCommit, commit)
    assert.equal(await readFile(join(result.path, 'tracked.txt'), 'utf8'), 'committed\n')
    assert.equal(await readFile(join(repository, 'tracked.txt'), 'utf8'), 'unfinished\n')
    assert.equal(await readFile(join(repository, 'untracked.txt'), 'utf8'), 'keep\n')
    assert.deepEqual(await new WorktreeCreator(join(root, 'managed')).create(repository, request), result)
    assert.equal((await git(['worktree', 'list', '--porcelain'])).split('\n').filter(line => line.startsWith('worktree ')).length, 2)
    await assert.rejects(creator.create(repository, { ...request, branch: 'another' }), /已用于/)
    await assert.rejects(creator.create(repository, { requestId: '../escape', branch: 'ok' }), /无效/)
    await assert.rejects(creator.create(repository, { requestId: 'fixture-request-0002', branch: '--detach' }), /有效的 Git/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('worktree creation is owner-only and accepts registered workspace identity, never an arbitrary path', async () => {
  let handler, owner = false
  registerWorktreeApi({ webServer: { register: route => { handler = route.handler; return () => {} } }, connection: { admit: () => ({ peer: { principal: { kind: owner ? 'owner' : 'session' } } }) }, get: () => ({ list: () => [] }) })
  async function invoke() {
    let status, body
    await handler({ method: 'GET', url: '/api/kode/worktrees?workspaceId=unknown&path=/private', headers: {} }, { writeHead(value) { status = value }, end(value) { body = JSON.parse(value) } })
    return { status, body }
  }
  assert.equal((await invoke()).status, 403)
  owner = true
  const result = await invoke(); assert.equal(result.status, 400); assert.match(result.body.error, /已注册/)
})

test('branch choices resolve the selected base commit and reject refs outside the advertised catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-worktree-branches-')), repository = join(root, 'project')
  await mkdir(repository)
  const git = async args => (await execute('git', ['-C', repository, ...args])).stdout.trim()
  const commit = async message => { await git(['add', '.']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', message]); return git(['rev-parse', 'HEAD']) }
  try {
    await git(['init', '-q']); await git(['config', 'core.hooksPath', join(root, 'no-hooks')])
    await writeFile(join(repository, 'tracked.txt'), 'base\n'); const base = await commit('base')
    await git(['branch', 'base-branch'])
    await git(['update-ref', 'refs/remotes/origin/base-branch', base])
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/base-branch'])
    await writeFile(join(repository, 'tracked.txt'), 'head\n'); const head = await commit('head')
    const creator = new WorktreeCreator(join(root, 'managed')), info = await creator.inspect(repository)
    assert.notEqual(base, head)
    assert.equal(info.branches.find(row => row.ref === 'refs/heads/base-branch').commit, base)
    assert.ok(info.branches.some(row => row.ref === 'refs/remotes/origin/base-branch'))
    assert.ok(!info.branches.some(row => row.ref === 'refs/remotes/origin/HEAD'))
    const request = { requestId: 'fixture-selected-base-0001', branch: 'kode/selected-base', baseRef: 'refs/heads/base-branch' }
    const result = await creator.create(repository, request)
    assert.equal(result.baseCommit, base); assert.equal(await readFile(join(result.path, 'tracked.txt'), 'utf8'), 'base\n')
    assert.deepEqual(await new WorktreeCreator(join(root, 'managed')).create(repository, request), result)
    await assert.rejects(creator.create(repository, { ...request, baseRef: 'HEAD' }), /已用于/)
    await assert.rejects(creator.create(repository, { requestId: 'fixture-selected-base-0002', baseRef: '--upload-pack=bad' }), /起始分支/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
