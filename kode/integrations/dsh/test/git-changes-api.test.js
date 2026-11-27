import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  parseCommitDecorations,
  parseNumstatZ,
  parsePorcelainZ,
  registerGitChangesApi,
  validateRepoRelativePath,
} from '../src/git-changes-api.js'

const exec = promisify(execFile)

test('git path validation and porcelain/numstat parsers handle renames, spaces and traversal safely', () => {
  assert.equal(validateRepoRelativePath('src/agent-client/git-changes.js'), 'src/agent-client/git-changes.js')
  assert.equal(validateRepoRelativePath('dir/file with space.txt'), 'dir/file with space.txt')
  assert.equal(validateRepoRelativePath('../etc/passwd'), null)
  assert.equal(validateRepoRelativePath('/etc/passwd'), null)
  assert.equal(validateRepoRelativePath('--upload-pack=bad'), null)
  assert.equal(validateRepoRelativePath('a/\0b'), null)

  const stats = parseNumstatZ('12\t3\tsrc/app.js\x00-\t-\timg.png\x004\t1\t\x00old.js\x00new.js\x00')
  assert.deepEqual(stats.get('src/app.js'), { added: 12, removed: 3, binary: false })
  assert.deepEqual(stats.get('img.png'), { added: 0, removed: 0, binary: true })
  assert.deepEqual(stats.get('new.js'), { added: 4, removed: 1, binary: false })

  const parsed = parsePorcelainZ('MM src/app.js\0R  new.js\0old.js\0?? docs/readme.md\0', stats, stats)
  assert.equal(parsed.staged.length, 2)
  assert.equal(parsed.staged[0].path, 'src/app.js')
  assert.equal(parsed.staged[0].added, 12)
  assert.equal(parsed.staged[1].origPath, 'old.js')
  assert.equal(parsed.unstaged.length, 1)
  assert.equal(parsed.unstaged[0].path, 'src/app.js')
  assert.equal(parsed.untracked.length, 1)
  assert.equal(parsed.untracked[0].path, 'docs/readme.md')

  assert.deepEqual(
    parseCommitDecorations('HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1.0'),
    ['HEAD', 'main', 'origin/main', 'tag: v1.0'],
  )
})

test('git-changes API inspects real repo status, diffs, commits, and performs stage/unstage/discard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kode-git-changes-'))
  try {
    const git = (...args) => exec('git', ['-C', dir, ...args])
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'dev@example.com')
    await git('config', 'user.name', 'Dev')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src/index.js'), 'const a = 1\nconsole.log(a)\n')
    await git('add', '.')
    await git('commit', '-m', 'init repo')

    // Modify tracked file + create untracked file
    await writeFile(join(dir, 'src/index.js'), 'const a = 2\nconst b = 3\nconsole.log(a + b)\n')
    await writeFile(join(dir, 'src/new.js'), 'export const x = 42\n')

    let registered
    const services = {
      sessions: { get: id => id === 's1' ? { header: { cwd: dir } } : undefined },
      sessionProjections: { snapshot: () => ({ values: { workingDirectory: dir } }) },
    }
    let principalKind = 'owner'
    registerGitChangesApi({
      get: name => services[name],
      connection: { admit: () => ({ peer: { principal: { kind: principalKind } } }) },
      webServer: { register: route => { registered = route; return () => {} } },
    })

    const request = async (method, url, body) => {
      const res = {
        statusCode: 0,
        writeHead(status) { this.statusCode = status },
        end(text) { this.body = JSON.parse(text) },
      }
      const req = {
        method,
        url,
        async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body) },
      }
      await registered.handler(req, res)
      return res
    }

    // Non-owner rejected
    principalKind = 'guest'
    assert.equal((await request('GET', '/api/kode/git-changes?sessionId=s1')).statusCode, 403)
    principalKind = 'owner'

    // Status includes branch, modified file with numstat, untracked file, and recent commit
    const status = await request('GET', '/api/kode/git-changes?sessionId=s1')
    assert.equal(status.statusCode, 200)
    assert.equal(status.body.git.branch, 'main')
    assert.equal(status.body.unstaged.length, 1)
    assert.equal(status.body.unstaged[0].path, 'src/index.js')
    assert.equal(status.body.unstaged[0].added, 3)
    assert.equal(status.body.unstaged[0].removed, 2)
    assert.equal(status.body.untracked.length, 1)
    assert.equal(status.body.untracked[0].path, 'src/new.js')
    assert.equal(status.body.commits.length, 1)
    assert.equal(status.body.commits[0].subject, 'init repo')

    // Diff for unstaged tracked file & untracked file & commit
    const unstagedDiff = await request('GET', '/api/kode/git-changes?sessionId=s1&diff=1&scope=unstaged&path=src/index.js')
    assert.equal(unstagedDiff.statusCode, 200)
    assert.match(unstagedDiff.body.diff, /\+const b = 3/)

    const untrackedDiff = await request('GET', '/api/kode/git-changes?sessionId=s1&diff=1&scope=untracked&path=src/new.js')
    assert.equal(untrackedDiff.statusCode, 200)
    assert.match(untrackedDiff.body.diff, /\+export const x = 42/)

    const commitDiff = await request('GET', `/api/kode/git-changes?sessionId=s1&diff=1&scope=commit&commit=${status.body.commits[0].hash}`)
    assert.equal(commitDiff.statusCode, 200)
    assert.match(commitDiff.body.diff, /init repo/)

    // Commit detail returns message + changed files with numstat, and per-file commit diff works
    assert.ok(status.body.commits[0].decorations.includes('HEAD'))
    assert.ok(status.body.commits[0].decorations.includes('main'))
    const detail = await request('GET', `/api/kode/git-changes?sessionId=s1&commitDetail=${status.body.commits[0].hash}`)
    assert.equal(detail.statusCode, 200)
    assert.equal(detail.body.message, 'init repo')
    assert.equal(detail.body.files.length, 1)
    assert.equal(detail.body.files[0].path, 'src/index.js')
    assert.equal(detail.body.files[0].status, 'A')
    const perFileCommitDiff = await request('GET', `/api/kode/git-changes?sessionId=s1&diff=1&scope=commit&commit=${status.body.commits[0].hash}&path=src/index.js`)
    assert.equal(perFileCommitDiff.statusCode, 200)
    assert.match(perFileCommitDiff.body.diff, /\+const a = 1/)

    // Path traversal rejected
    const bad = await request('GET', '/api/kode/git-changes?sessionId=s1&diff=1&scope=untracked&path=../escape.txt')
    assert.equal(bad.statusCode, 400)

    // Stage -> Unstage -> Discard
    const staged = await request('POST', '/api/kode/git-changes', { sessionId: 's1', action: 'stage', path: 'src/index.js' })
    assert.equal(staged.statusCode, 200)
    assert.equal(staged.body.staged.length, 1)
    assert.equal(staged.body.unstaged.length, 0)

    const unstaged = await request('POST', '/api/kode/git-changes', { sessionId: 's1', action: 'unstage', path: 'src/index.js' })
    assert.equal(unstaged.statusCode, 200)
    assert.equal(unstaged.body.staged.length, 0)
    assert.equal(unstaged.body.unstaged.length, 1)

    const discardedTracked = await request('POST', '/api/kode/git-changes', { sessionId: 's1', action: 'discard', path: 'src/index.js', scope: 'unstaged' })
    assert.equal(discardedTracked.statusCode, 200)
    assert.equal(discardedTracked.body.unstaged.length, 0)

    const discardedUntracked = await request('POST', '/api/kode/git-changes', { sessionId: 's1', action: 'discard', path: 'src/new.js', scope: 'untracked' })
    assert.equal(discardedUntracked.statusCode, 200)
    assert.equal(discardedUntracked.body.untracked.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
