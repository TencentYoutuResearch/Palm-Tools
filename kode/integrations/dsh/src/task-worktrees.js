/** Trusted Host task checkouts. The original repository is inspected, never reset or cleaned. */
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, realpath, lstat, open } from 'node:fs/promises'
import { join, resolve, isAbsolute, relative } from 'node:path'
import { taskGit as git, materializeTaskBase } from './task-worktree-git.js'
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
async function inspect(repository) {
  const root = await realpath(repository)
  let top
  try { top = await git(root, ['rev-parse', '--show-toplevel']) }
  catch { throw Error('Automatic write requires a committed Git repository; non-Git workspaces are unsupported') }
  if (top !== root) throw new Error('Automatic write requires a registered Git repository top-level')
  const common = await git(root, ['rev-parse', '--git-common-dir'])
  return { repository: root, common_dir: await realpath(resolve(root, common)), base_commit: await git(root, ['rev-parse', '--verify', 'HEAD^{commit}']) }
}
async function save(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeDurable(temporary, record)
  await rename(temporary, path)
  await syncDirectory(resolve(path, '..'))
}
async function writeDurable(path, record) {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
}
async function syncDirectory(path) {
  const directory = await open(path, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
export class TaskWorktrees {
  constructor(root) { this.root = resolve(root); this.pending = new Map(); this.closed = false }
  async close() { this.closed = true; await Promise.allSettled(this.pending.values()) }
  prepare(input, { signal, authorize } = {}) {
    if (this.closed || !input || Object.keys(input).sort().join(',') !== 'home,host,repository,repository_binding,run_id'
        || ![input.home, input.host, input.run_id, input.repository_binding].every(validId)
        || typeof input.repository !== 'string' || !isAbsolute(input.repository)) return Promise.reject(Error('Invalid task worktree binding'))
    const fixed = structuredClone(input)
    const key = createHash('sha256').update(JSON.stringify([fixed.home, fixed.run_id, fixed.repository_binding, fixed.host])).digest('hex')
    const existing = this.pending.get(key)
    if (existing) return existing.then(async result => {
      if (result.repository !== fixed.repository) throw Error('Task worktree repository identity conflict')
      if (authorize) await authorize(structuredClone(result))
      return result
    })
    const task = this.provision(fixed, key, signal, authorize).finally(() => this.pending.delete(key))
    this.pending.set(key, task)
    return task
  }
  async canonicalStorage() {
    if ((await lstat(this.root)).isSymbolicLink()) throw Error('Task worktree storage must be canonical')
    this.root = await realpath(this.root)
    return this.root
  }
  async provision(input, key, signal, authorize) {
    signal?.throwIfAborted()
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await this.canonicalStorage()
    const directory = join(this.root, key)
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw Error('Task worktree journal changed')
    const path = join(directory, 'receipt.json')
    let record
    try { record = JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!record) {
      const info = await inspect(input.repository)
      if (info.repository !== input.repository) throw Error('Task worktree original root must be canonical')
      const root = join(directory, 'checkout')
      const relation = relative(input.repository, root)
      if (!relation || (!relation.startsWith('..') && !isAbsolute(relation)) || input.repository.startsWith(`${root}/`)) throw Error('Task worktree must be outside the original workspace')
      record = { format: 'kode.task-worktree.v1', binding: input, status: 'planned', result: { key, ...info, root, branch: `kode/task-${key}` } }
      try { await writeDurable(path, record); await syncDirectory(directory) }
      catch (error) { if (error.code !== 'EEXIST') throw error; record = JSON.parse(await readFile(path, 'utf8')) }
    }
    if (!isDeepStrictEqual(record.binding, input) || record.format !== 'kode.task-worktree.v1'
        || record.result?.key !== key || record.result?.root !== join(directory, 'checkout')
        || record.result?.branch !== `kode/task-${key}`) throw Error('Task worktree durable identity conflict')
    signal?.throwIfAborted()
    // Home authorization precedes any Git branch/checkout effect, including recovery.
    if (authorize) await authorize(structuredClone(record.result))
    signal?.throwIfAborted()
    if (record.status !== 'ready') {
      let present
      try { present = await lstat(record.result.root) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!present) {
        // The deterministic ref/destination make an uncertain add recoverable without creating another branch.
        try { await git(record.result.repository, ['worktree', 'add', '--no-checkout', '-b', record.result.branch, '--', record.result.root, record.result.base_commit]) }
        catch (error) { await this.validate(record.result).catch(() => { throw error }) }
      }
      await this.validate(record.result)
      await materializeTaskBase(record.result.root, record.result.base_commit)
      record.status = 'ready'
      await save(path, record)
    }
    await this.validate(record.result)
    signal?.throwIfAborted()
    return structuredClone(record.result)
  }
  async validate(receipt) {
    await this.canonicalStorage()
    if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.key) || receipt.root !== join(this.root, receipt.key, 'checkout')
        || receipt.branch !== `kode/task-${receipt.key}` || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.base_commit)) throw Error('Invalid task worktree receipt')
    const record = JSON.parse(await readFile(join(this.root, receipt.key, 'receipt.json'), 'utf8'))
    if (record.format !== 'kode.task-worktree.v1' || !isDeepStrictEqual(record.result, receipt)) throw Error('Task worktree journal identity changed')
    const directory = await lstat(receipt.root)
    if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(receipt.root) !== receipt.root) throw Error('Task worktree path changed')
    const actual = await inspect(receipt.root)
    const source = await inspect(receipt.repository)
    if (actual.common_dir !== receipt.common_dir || source.common_dir !== receipt.common_dir
        || actual.base_commit !== receipt.base_commit
        || await git(receipt.root, ['branch', '--show-current']) !== receipt.branch) throw Error('Task worktree Git identity changed')
    // git worktree list is authoritative; an ordinary clone with copied files is not the prepared checkout.
    const registered = (await git(receipt.repository, ['worktree', 'list', '--porcelain'])).split('\n\n')
      .some(row => row.split('\n').includes(`worktree ${receipt.root}`) && row.split('\n').includes(`branch refs/heads/${receipt.branch}`))
    if (!registered) throw Error('Task worktree registration unavailable')
    return receipt.root
  }
}
