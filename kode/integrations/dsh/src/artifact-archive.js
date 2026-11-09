/** Immutable local content archive. No checkout, symlink following or tool execution. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, lstat, open, link, unlink } from 'node:fs/promises'
import { join } from 'node:path'
const digest = value => createHash('sha256').update(value).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const MAX_BYTES = 128 * 1024 * 1024, MAX_DOCUMENT = 192 * 1024 * 1024
export const artifactSnapshotHash = payload => {
  if (payload.kind !== 'artifact') return payload.snapshot_hash
  const s = payload.snapshot
  const value = { repository_id: s.repository_id, base_revision: s.base_revision, tree_hash: s.tree_hash, patch_hash: s.patch_hash,
    artifact_hashes: Object.fromEntries(Object.entries(s.artifact_hashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }
  return digest(`kode.artifact.snapshot.v1\n${JSON.stringify(value)}`)
}
export function validateArtifactBundle(bundle) {
  const s = bundle?.snapshot
  if (!exact(bundle, ['version', 'snapshot', 'base_tree', 'manifest', 'contents']) || bundle.version !== 1
      || !exact(s, ['repository_id', 'base_revision', 'tree_hash', 'patch_hash', 'artifact_hashes'])
      || typeof s.repository_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(s.repository_id)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(s.base_revision)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(bundle.base_tree)
      || !hash(s.tree_hash) || !hash(s.patch_hash) || !s.artifact_hashes || Object.keys(s.artifact_hashes).length
      || !Array.isArray(bundle.manifest) || bundle.manifest.length > 10000
      || !bundle.contents || typeof bundle.contents !== 'object' || Array.isArray(bundle.contents)) throw new Error('Invalid artifact archive')
  let prior, bytes = 0
  const used = new Set()
  for (const row of bundle.manifest) {
    if (!Array.isArray(row)) throw new Error('Invalid archive manifest')
    const [path, kind, contentHash] = row
    if (typeof path !== 'string' || !path || Buffer.byteLength(path) > 4096 || path.includes('\0') || path.includes('\\')
        || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')
        || (prior !== undefined && path <= prior)) throw new Error('Unsafe or unordered archive path')
    prior = path
    if (kind === 'deleted') { if (row.length !== 2) throw new Error('Invalid deleted archive entry'); continue }
    if (row.length !== 3 || !['file', 'executable', 'symlink'].includes(kind) || !hash(contentHash)
        || !Object.hasOwn(bundle.contents, contentHash) || typeof bundle.contents[contentHash] !== 'string') throw new Error('Missing artifact content')
    if (bundle.contents[contentHash].length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('Artifact archive byte limit exceeded')
    const content = Buffer.from(bundle.contents[contentHash], 'base64')
    if (content.toString('base64') !== bundle.contents[contentHash] || digest(content) !== contentHash) throw new Error('Artifact content hash mismatch')
    if (kind === 'symlink' && !Buffer.from(content.toString('utf8')).equals(content)) throw new Error('Invalid symlink text')
    bytes += content.length
    if (bytes > MAX_BYTES) throw new Error('Artifact archive byte limit exceeded')
    used.add(contentHash)
  }
  if (Object.keys(bundle.contents).length !== used.size) throw new Error('Unreferenced archive content')
  if (digest(`kode.workspace.manifest.v1\n${JSON.stringify(bundle.manifest)}`) !== s.tree_hash
      || digest(`kode.workspace.delta.v1\n${bundle.base_tree}\n${s.tree_hash}`) !== s.patch_hash) throw new Error('Artifact manifest hash mismatch')
  return artifactSnapshotHash({ kind: 'artifact', snapshot: s })
}
export class ArtifactArchive {
  constructor(root) { this.root = root }
  async directory() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Artifact archive directory is not owned storage')
  }
  async read(snapshotHash, expected) {
    if (!hash(snapshotHash)) throw new Error('Invalid archive identity')
    await this.directory()
    const handle = await open(join(this.root, `${snapshotHash}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > MAX_DOCUMENT) throw new Error('Invalid artifact archive file')
      const data = await handle.readFile(), bundle = JSON.parse(data.toString('utf8'))
      if (validateArtifactBundle(bundle) !== snapshotHash || (expected && (expected.archive_hash !== digest(data) || expected.bytes !== data.length))) throw new Error('Artifact archive identity mismatch')
      return bundle
    } finally { await handle.close() }
  }
  async put(bundle) {
    const snapshotHash = validateArtifactBundle(bundle), data = Buffer.from(JSON.stringify(bundle))
    if (data.length > MAX_DOCUMENT) throw new Error('Artifact archive document too large')
    await this.directory()
    const temporary = join(this.root, `.${randomUUID()}.tmp`), destination = join(this.root, `${snapshotHash}.json`)
    const reference = { snapshot_hash: snapshotHash, archive_hash: digest(data), bytes: data.length, format: 'kode.artifact.bundle.v1' }
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(data); await handle.sync(); await handle.close()
      try { await link(temporary, destination) } catch (error) { if (error.code !== 'EEXIST') throw error }
      await this.read(snapshotHash, reference)
      const directory = await open(this.root, 'r')
      try { await directory.sync() } finally { await directory.close() }
      return reference
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
  }
}
