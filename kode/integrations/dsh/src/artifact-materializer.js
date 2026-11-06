/** Restore verified snapshots into new Host-owned directories; never grant execution or overwrite a project. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, realpath, open, readdir, readlink, symlink, chmod } from 'node:fs/promises'
import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fetchArtifactArchive, readArtifactArchiveReceipt } from './artifact-transfer.js'
import { ArtifactArchive, validateArtifactBundle } from './artifact-archive.js'
import { writePrivateJson } from './agent-profiles.js'
const digest = value => createHash('sha256').update(value).digest('hex')
const inside = (root, target) => { const path = relative(root, target); return !isAbsolute(path) && path !== '..' && !path.startsWith('../') }
async function syncDirectory(path) { const file = await open(path, 'r'); try { await file.sync() } finally { await file.close() } }
function layout(bundle, root) {
  validateArtifactBundle(bundle)
  const entries = new Map(), directories = new Set(['']), deleted = new Set(bundle.manifest.filter(row => row[1] === 'deleted').map(row => row[0]))
  for (const row of bundle.manifest) {
    if (row[1] === 'deleted') continue
    entries.set(row[0], row)
    let parent = dirname(row[0])
    while (parent !== '.') { directories.add(parent); parent = dirname(parent) }
    if (row[1] === 'symlink') {
      const text = Buffer.from(bundle.contents[row[2]], 'base64').toString('utf8')
      if (!text || text.includes('\0') || isAbsolute(text) || !inside(root, resolve(root, dirname(row[0]), text))) throw new Error('Artifact symlink escapes materialized workspace')
    }
  }
  for (const path of directories) if (entries.has(path) || deleted.has(path)) throw new Error('Artifact entry conflicts with parent directory')
  return { entries, directories }
}
export async function verifyArtifactWorkspace(root, bundle, signal) {
  const { entries, directories } = layout(bundle, root), seen = new Set()
  async function visit(path) {
    signal?.throwIfAborted()
    const absolute = join(root, path), stat = await lstat(absolute)
    if (directories.has(path)) {
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o222)) throw new Error('Materialized directory changed')
      seen.add(path)
      for (const name of await readdir(absolute)) await visit(path ? `${path}/${name}` : name)
      return
    }
    const row = entries.get(path)
    if (!row) throw new Error('Unexpected materialized content')
    seen.add(path)
    if (row[1] === 'symlink') {
      if (!stat.isSymbolicLink() || digest(await readlink(absolute, { encoding: 'buffer' })) !== row[2]) throw new Error('Materialized symlink changed')
      return
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o222) || Boolean(stat.mode & 0o111) !== (row[1] === 'executable')) throw new Error('Materialized file mode changed')
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat(), hash = createHash('sha256'), buffer = Buffer.alloc(65536)
      if (before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('Materialized file identity changed')
      for (;;) { signal?.throwIfAborted(); const { bytesRead } = await file.read(buffer); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)) }
      const after = await file.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || hash.digest('hex') !== row[2]) throw new Error('Materialized file content changed')
    } finally { await file.close() }
  }
  await visit('')
  if ([...entries.keys(), ...directories].some(path => !seen.has(path))) throw new Error('Materialized content missing')
  return { snapshot_hash: validateArtifactBundle(bundle), verified: true }
}
export class ArtifactMaterializer {
  constructor(root, client) {
    if (!isAbsolute(root)) throw new Error('Absolute trusted artifact workspace storage required')
    this.root = root; this.archives = new ArtifactArchive(join(root, '.archives')); this.client = client; this.pending = new Map(); this.stop = new AbortController()
  }
  prepare(request, { signal, remote } = {}) {
    if (this.stop.signal.aborted) return Promise.reject(new Error('Artifact materializer closed'))
    signal = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal
    if (!request || Object.keys(request).sort().join(',') !== 'request_id,sequence,snapshot_hash'
        || typeof request.request_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(request.request_id)
        || !Number.isSafeInteger(request.sequence) || request.sequence < 1 || !/^[a-f0-9]{64}$/.test(request.snapshot_hash ?? '')) return Promise.reject(new Error('Invalid artifact workspace request'))
    const fixed = structuredClone({ ...request, ...(remote ? { home_scope: remote } : {}) }), key = digest(`kode.artifact.workspace.v1\n${request.request_id}${remote ? '\n' + JSON.stringify(remote) : ''}`)
    const pending = this.pending.get(key)
    if (pending) return isDeepStrictEqual(pending.request, fixed) ? pending.task : Promise.reject(new Error('Artifact workspace request conflict'))
    const task = this.restore(key, fixed, signal)
    this.pending.set(key, { request: fixed, task })
    task.finally(() => this.pending.delete(key)).catch(() => {})
    return task
  }
  async close() { this.stop.abort(new Error('Artifact materializer closed')); await Promise.allSettled([...this.pending.values()].map(row => row.task)) }
  async restore(key, request, signal) {
    const receipt = await readArtifactArchiveReceipt(this.client, request.sequence, request.snapshot_hash, signal, request.home_scope)
    try {
      if (!(await lstat(this.root)).isDirectory()) throw new Error('Artifact storage is not a directory')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    let bundle, cacheMiss = false
    try {
      await lstat(join(this.archives.root, `${request.snapshot_hash}.json`))
      bundle = await this.archives.read(request.snapshot_hash, receipt)
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const fetched = await fetchArtifactArchive(this.client, request.sequence, request.snapshot_hash, signal, request.home_scope)
      if (fetched.receipt.archive_hash !== receipt.archive_hash || fetched.receipt.bytes !== receipt.bytes) throw new Error('Artifact archive changed during download')
      bundle = fetched.bundle
      cacheMiss = true
    }
    signal?.throwIfAborted()
    // Preflight link containment before any destination writes.
    layout(bundle, '/artifact-workspace-fixture')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Artifact storage is not a directory')
    if (cacheMiss) await this.archives.put(bundle)
    const cache = await realpath(this.root), directory = join(cache, key), source = join(directory, 'source'), stateFile = join(directory, 'state.json')
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (!(await lstat(directory)).isDirectory()) throw new Error('Artifact workspace identity changed')
      const file = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW)
      let saved
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid artifact workspace receipt')
        saved = JSON.parse(await file.readFile('utf8'))
      } finally { await file.close() }
      if (Object.keys(saved).sort().join(',') !== 'archive_hash,execution_authorized,request,source,state,version' || saved.version !== 1 || saved.execution_authorized !== false) throw new Error('Artifact workspace receipt changed')
      if (!isDeepStrictEqual(saved.request, request) || saved.archive_hash !== receipt.archive_hash) throw new Error('Artifact workspace request conflict')
      if (saved.state !== 'ready' || saved.source !== source) throw new Error('Artifact workspace preparation requires recovery')
      await verifyArtifactWorkspace(source, bundle, signal)
      return saved
    }
    const intent = { version: 1, request, archive_hash: receipt.archive_hash, source, state: 'preparing', execution_authorized: false }
    await writePrivateJson(stateFile, intent)
    await mkdir(source, { mode: 0o700 })
    const { entries, directories } = layout(bundle, source)
    const ordered = [...directories].filter(Boolean).sort((a, b) => a.split('/').length - b.split('/').length)
    for (const path of ordered) { signal?.throwIfAborted(); await mkdir(join(source, path), { mode: 0o700 }) }
    for (const [path, row] of entries) {
      signal?.throwIfAborted()
      const target = join(source, path), bytes = Buffer.from(bundle.contents[row[2]], 'base64')
      if (row[1] === 'symlink') { await symlink(bytes.toString('utf8'), target); continue }
      const file = await open(target, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.chmod(row[1] === 'executable' ? 0o500 : 0o400); await file.sync() }
      finally { await file.close() }
    }
    for (const path of [...ordered].reverse().concat('')) { await chmod(join(source, path), 0o500); await syncDirectory(join(source, path)) }
    await verifyArtifactWorkspace(source, bundle, signal)
    signal?.throwIfAborted()
    const ready = { ...intent, state: 'ready' }
    await writePrivateJson(stateFile, ready); await syncDirectory(directory); await syncDirectory(cache)
    return ready
  }
}
