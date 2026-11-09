/** Read-only Git workspace capture. Caller must supply an already-authorized repository root.
 * No user config discovery, execution, commit, index write or automatic evidence submission.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { resolve, relative, dirname, isAbsolute } from 'node:path'
const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
const MAX_FILES = 10000, MAX_BYTES = 128 * 1024 * 1024
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')) }

async function git(root, args, signal) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' })
  try {
    return (await exec('/usr/bin/git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
      { env, signal, encoding: 'buffer', maxBuffer: MAX_BYTES, timeout: 30000 })).stdout
  } catch { throw new Error(signal?.aborted ? 'Artifact capture cancelled' : 'Artifact Git inspection failed') }
}

/** Read-only prerequisites; never initialize a repository or create a baseline. */
export async function inspectArtifactRepository({workspaceRoot,signal}){
  if(typeof workspaceRoot!=='string'||!isAbsolute(workspaceRoot))throw Error('Explicit artifact workspace required')
  const root=await realpath(workspaceRoot)
  if(root!==workspaceRoot)throw Error('Artifact workspace identity changed')
  const top=(await git(root,['rev-parse','--show-toplevel'],signal)).toString().trim()
  if(await realpath(top)!==root)throw Error('Artifact workspace must be the repository root')
  const base=(await git(root,['rev-parse','--verify','HEAD^{commit}'],signal)).toString().trim()
  const tree=(await git(root,['rev-parse','--verify','HEAD^{tree}'],signal)).toString().trim()
  if(!/^[a-f0-9]{40,64}$/.test(base)||!/^[a-f0-9]{40,64}$/.test(tree))throw Error('Artifact baseline identity unavailable')
  return {status:'ready',base_revision:base}
}

async function capture(root, repositoryId, signal, archive = false) {
  const base = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).toString().trim()
  const index = await git(root, ['ls-files', '--stage', '-z'], signal)
  if (index.toString().split('\0').some(line => line.startsWith('160000 ') || (line && !/^\d+ [a-f0-9]+ 0\t/.test(line)))) {
    throw new Error('Artifact capture requires resolved files and no submodules')
  }
  const listing = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal)
  const baseline = await git(root, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], signal)
  // Reject non-UTF8 paths instead of hashing a lossy replacement path.
  const decoded = listing.toString('utf8')
  const basePaths = baseline.toString('utf8')
  if (!Buffer.from(decoded).equals(listing) || !Buffer.from(basePaths).equals(baseline)) throw new Error('Artifact capture requires UTF-8 paths')
  const paths = [...new Set([...decoded.split('\0'), ...basePaths.split('\0')].filter(Boolean))].sort()
  if (paths.length > MAX_FILES) throw new Error('Artifact capture file limit exceeded')
  const manifest = [], contents = Object.create(null); let total = 0
  for (const path of paths) {
    signal?.throwIfAborted()
    const absolute = resolve(root, path)
    if (!inside(root, absolute) || path === '.git' || path.startsWith('.git/')) throw new Error('Artifact path exceeds workspace')
    // Parent links cannot redirect file reads outside the authorized repository.
    let parent
    try { parent = await realpath(dirname(absolute)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (parent && !inside(root, parent)) throw new Error('Artifact parent exceeds workspace')
    let stat
    try { stat = await lstat(absolute) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!stat) { manifest.push([path, 'deleted']); continue }
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: 'buffer' })
      if (!Buffer.from(target.toString('utf8')).equals(target)) throw new Error('Artifact symlink requires UTF-8 text')
      total += target.length
      if (total > MAX_BYTES) throw new Error('Artifact capture byte limit exceeded')
      const hash = digest(target)
      manifest.push([path, 'symlink', hash]); if (archive) contents[hash] = target.toString('base64')
      continue
    }
    if (!stat.isFile()) throw new Error('Unsupported artifact file type')
    const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('Artifact changed during capture')
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536), chunks = []
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await file.read(buffer)
        if (!bytesRead) break
        total += bytesRead
        if (total > MAX_BYTES) throw new Error('Artifact capture byte limit exceeded')
        hash.update(buffer.subarray(0, bytesRead))
        if (archive) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      }
      const after = await file.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Artifact changed during capture')
      const contentHash = hash.digest('hex')
      manifest.push([path, (before.mode & 0o111) ? 'executable' : 'file', contentHash])
      if (archive) contents[contentHash] = Buffer.concat(chunks).toString('base64')
    } finally { await file.close() }
  }
  const treeHash = digest(`kode.workspace.manifest.v1\n${JSON.stringify(manifest)}`)
  // Do not use git diff: repository-defined clean filters can execute even with
  // --no-ext-diff/--no-textconv. Bind the base tree to the raw workspace manifest.
  const baseTree = (await git(root, ['rev-parse', '--verify', 'HEAD^{tree}'], signal)).toString().trim()
  const snapshot = { repository_id: repositoryId, base_revision: base, tree_hash: treeHash,
    patch_hash: digest(`kode.workspace.delta.v1\n${baseTree}\n${treeHash}`), artifact_hashes: {} }
  return archive ? { version: 1, snapshot, base_tree: baseTree, manifest, contents } : snapshot
}

async function captureVerified({ workspaceRoot, repositoryId, signal }, archive) {
  if (!id(repositoryId) || typeof workspaceRoot !== 'string' || !isAbsolute(workspaceRoot)) throw new Error('Explicit artifact workspace and repository identity required')
  const root = await realpath(workspaceRoot)
  const top = (await git(root, ['rev-parse', '--show-toplevel'], signal)).toString().trim()
  if (await realpath(top) !== root) throw new Error('Artifact workspace must be the repository root')
  const first = await capture(root, repositoryId, signal, archive)
  const second = await capture(root, repositoryId, signal)
  if (JSON.stringify(archive ? first.snapshot : first) !== JSON.stringify(second)) throw new Error('Artifact changed during capture')
  return first
}

export const captureArtifactSnapshot = options => captureVerified(options, false)
export const captureArtifactBundle = options => captureVerified(options, true)
