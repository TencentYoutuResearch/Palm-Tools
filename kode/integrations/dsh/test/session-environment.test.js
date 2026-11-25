import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { registerSessionEnvironment } from '../src/session-environment.js'

const execute = promisify(execFile)
const git = async (cwd, ...args) => (await execute('git', ['-C', cwd, ...args])).stdout.trim()

function api(services = {}) {
  let route
  registerSessionEnvironment({
    webServer: { register: next => { route = next } },
    connection: { admit: () => ({ rejection: 401 }) },
    get: name => services[name],
  })
  assert.equal(route.path, '/api/kode/session-environment')
  return async (query, principal = 'owner', method = 'GET') => {
    let status, headers, value
    const peer = principal ? { principal: { kind: principal } } : undefined
    await route.handler({ method, url: route.path + '?' + query, headers: {} }, {
      writeHead(code, fields) { status = code; headers = fields },
      end(body) { value = JSON.parse(body) },
    }, peer)
    assert.equal(headers['cache-control'], 'no-store')
    return { status, value }
  }
}

test('checkout metadata follows the linked session directory rather than the original project', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kode-checkout-metadata-')))
  const repository = join(root, 'project'), linked = join(root, 'project-task'), sibling = join(root, 'project-worktree-looking-name')
  const nested = join(linked, 'src'), nestedPrimary = join(repository, 'src')
  const cwdById = new Map([['linked', nested], ['head', nestedPrimary], ['standalone', sibling], ['missing', join(root, 'missing')], ['non-git', root]])
  const active = { header: { cwd: repository } }
  const request = api({
    sessions: { get: id => id === 'linked' ? active : undefined },
    sessionProjections: { snapshot: (session, keys) => {
      assert.equal(session, active)
      assert.deepEqual(keys, ['workingDirectory'])
      return { values: { workingDirectory: nested } }
    } },
    sessionController: { list: async () => ({ items: [...cwdById].map(([sessionId, cwd]) => ({ sessionId, cwd })) }) },
  })
  try {
    for (const cwd of [repository, sibling]) await mkdir(cwd)
    await git(repository, 'init', '-q', '-b', 'main')
    await git(repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'base')
    await git(repository, 'tag', 'main')
    await git(repository, 'worktree', 'add', '-qb', 'fix/session-info', linked)
    await mkdir(nested)
    await mkdir(nestedPrimary)
    await git(sibling, 'init', '-q', '-b', 'unborn')
    const found = await request('sessionId=linked&cwd=' + encodeURIComponent(repository))
    assert.deepEqual(found, { status: 200, value: { cwd: nested, git: { root: linked, branch: 'fix/session-info', commit: null, kind: 'worktree' } } })
    assert.deepEqual((await request('sessionId=head')).value, { cwd: nestedPrimary, git: { root: repository, branch: 'main', commit: null, kind: 'primary' } })
    assert.deepEqual((await request('sessionId=standalone')).value, { cwd: sibling, git: { root: sibling, branch: 'unborn', commit: null, kind: 'primary' } })
    const commit = await git(linked, 'rev-parse', 'HEAD')
    await git(linked, 'switch', '--detach', commit)
    assert.deepEqual((await request('sessionId=linked')).value.git, { root: linked, branch: null, commit, kind: 'worktree' })
    assert.deepEqual((await request('sessionId=missing')).value, { cwd: cwdById.get('missing'), git: null })
    assert.deepEqual((await request('sessionId=non-git')).value, { cwd: root, git: null })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('cold metadata reads host-confirmed workspace moves and releases the observation without resuming', async () => {
  const original = join(tmpdir(), 'fixture-original'), moved = join(tmpdir(), 'fixture-workspace-move')
  let released = false
  const request = api({
    sessionQuery: { observeSession: async (id, options) => {
      assert.equal(id, 'cold')
      assert.equal(options.projectionMode, 'none')
      return {
        header: { cwd: original }, events: [
          { type: 'workspace-root/change', data: { cwd: moved } },
          { type: 'working-directory/change', data: { cwd: original } },
        ],
        [Symbol.dispose]() { released = true },
      }
    } },
    sessionController: { resolveAgent: () => assert.fail('metadata must not resume an Agent') },
  })
  assert.deepEqual(await request('sessionId=cold'), { status: 200, value: { cwd: moved, git: null } })
  assert.equal(released, true)
})

test('session environment only admits owner reads by a known session identity', async () => {
  let calls = 0
  const request = api({
    sessionQuery: { observeSession: async () => {
      calls++
      throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    } },
  })
  assert.equal((await request('sessionId=unknown', undefined, 'POST')).status, 405)
  assert.equal((await request('sessionId=unknown', 'session')).status, 403)
  assert.equal((await request('sessionId=unknown', null)).status, 403)
  assert.equal((await request('cwd=%2Fvar')).status, 400)
  assert.equal((await request('sessionId=..%2Foutside')).status, 400)
  assert.equal(calls, 0)
  assert.equal((await request('sessionId=unknown&cwd=%2Fvar')).status, 404)
  assert.equal(calls, 1)
})
