/** Owner-only creation of a fresh checkout; existing worktrees and uncommitted files are never moved. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { homedir } from 'node:os'
const execute = promisify(execFile)
async function git(cwd, args) {
  try { return (await execute('git', ['-C', cwd, ...args], { timeout: 60000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim() }
  catch (error) { throw new Error(String(error.stderr || error.message).trim().slice(0,1500)) }
}
async function save(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(tmp, path)
}
export class WorktreeCreator {
  constructor(root = join(homedir(), '.local/share/kode/worktrees')) { this.root = root; this.jobs = new Map(); this.closed = false }
  async close() { this.closed = true; await Promise.allSettled([...this.jobs.values()].map(job => job.promise)) }
  async inspect(path) {
    const cwd = await realpath(path)
    const repository = await git(cwd, ['rev-parse', '--show-toplevel'])
    const commit = await git(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const branch = await git(repository, ['branch', '--show-current'])
    return { repository, commit, branch }
  }
  create(path, input) {
    if (this.closed) return Promise.reject(new Error('Host is stopping'))
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId ?? '')) return Promise.reject(new Error('无效的 worktree 创建请求。'))
    const key = createHash('sha256').update(input.requestId).digest('hex')
    const identity = JSON.stringify([resolve(path), String(input.branch ?? '').trim()])
    if (this.jobs.has(key)) {
      const job = this.jobs.get(key)
      return job.identity === identity ? job.promise : Promise.reject(new Error('创建请求已用于另一个工作目录。'))
    }
    const promise = this.prepare(path, input, key, identity).finally(() => this.jobs.delete(key))
    this.jobs.set(key, { identity, promise }); return promise
  }
  async prepare(path, input, key, identity) {
    await mkdir(join(this.root, '.requests'), { recursive: true, mode: 0o700 })
    const recordPath = join(this.root, '.requests', `${key}.json`)
    let record
    try { record = JSON.parse(await readFile(recordPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (record) {
      if (record.identity !== identity) throw new Error('创建请求已用于另一个工作目录。')
      if (record.status !== 'ready') throw new Error(`上次创建未完成，工作目录保留在 ${record.path}；请检查后重新创建。`)
      const actual = await this.inspect(record.path)
      if (actual.branch !== record.branch) throw new Error('已有 worktree 分支发生变化，请重新选择工作目录。')
      return record.result
    }
    const info = await this.inspect(path), requested = String(input.branch ?? '').trim()
    const branch = requested || `kode/${basename(info.repository).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0,40) || 'work'}-${key.slice(0,8)}`
    if (branch.length > 200 || branch.startsWith('-') || /[\x00-\x1f]/.test(branch)) throw new Error('请输入有效的 Git 分支名称。')
    await git(info.repository, ['check-ref-format', '--branch', branch])
    const destination = join(this.root, `${basename(info.repository).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0,50) || 'work'}-${key.slice(0,12)}`)
    record = { identity, status: 'creating', path: destination, branch, baseCommit: info.commit, repository: info.repository }
    await save(recordPath, record)
    try {
      await git(info.repository, ['worktree', 'add', '-b', branch, '--', destination, info.commit])
      const result = { path: await realpath(destination), branch, baseCommit: info.commit, repository: info.repository }
      await save(recordPath, { ...record, status: 'ready', result }); return result
    } catch (error) { await save(recordPath, { ...record, status: 'failed' }); throw error }
  }
}
export function registerWorktreeApi(ctx, config = {}) {
  const creator = new WorktreeCreator(config.worktreeDirectory)
  const dispose = ctx.webServer.register({ kind: 'exact', path: '/api/kode/worktrees', handler: async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    try {
      let input
      if (req.method === 'GET') input = { workspaceId: new URL(req.url, 'http://localhost').searchParams.get('workspaceId') }
      else if (req.method === 'POST' && (req.headers['content-type'] ?? '').startsWith('application/json')) {
        let text = ''; for await (const part of req) { text += part; if (Buffer.byteLength(text) > 8192) throw new Error('Request too large') }; input = JSON.parse(text)
      } else return send(405, { error: 'GET or JSON POST required' })
      const workspace = ctx.get('workspaceRegistry')?.list().find(row => row.id === input.workspaceId)
      if (!workspace) throw new Error('请选择当前执行主机上已注册的项目。')
      send(200, req.method === 'GET' ? await creator.inspect(workspace.path) : await creator.create(workspace.path, input))
    } catch (error) { send(400, { error: error.message }) }
  } })
  return async () => { dispose(); await creator.close() }
}
