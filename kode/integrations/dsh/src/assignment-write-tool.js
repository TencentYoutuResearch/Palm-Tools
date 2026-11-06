/** Optimistic, atomic UTF-8 replacement under the existing cooperative workspace lease. */
import { open, lstat, rename, link, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, posix } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { validSourceRequest, inspectPath, inspectAssignmentSource, resolveAssignmentSource } from './assignment-source-tools.js'
import { assertTaskWorkspace } from './assignment-task-workspace.js'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function validWriteRequest(request) {
  return request && Object.keys(request).sort().join(',') === 'content,expected_sha256,path'
    && validSourceRequest({ path: request.path }) && request.path !== '.'
    && (request.expected_sha256 === null || typeof request.expected_sha256 === 'string' && /^[a-f0-9]{64}$/.test(request.expected_sha256))
    && typeof request.content === 'string' && !request.content.includes('\0')
    && Buffer.byteLength(request.content, 'utf8') <= 256 * 1024
    && Buffer.from(request.content, 'utf8').toString('utf8') === request.content
}
export async function writeAssignmentSource(root, request, signal, authorize) {
  if (!validWriteRequest(request)) throw new Error('Invalid source write request')
  signal?.throwIfAborted(); await authorize()
  const parent = await inspectPath(root, posix.dirname(request.path)), target = join(root, request.path)
  const bytes = Buffer.from(request.content, 'utf8'), desired = hash(bytes)
  const readCurrent = async () => {
    try {
      const value = await inspectAssignmentSource(root, 'kode_read_source', { path: request.path }, signal, authorize)
      const stat = await lstat(target)
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Source write target identity changed')
      return { hash: value.sha256, mode: stat.mode & 0o777 }
    } catch (error) { if (error.code === 'ENOENT') return { hash: null, mode: 0o600 }; throw error }
  }
  const before = await readCurrent()
  // Report the observed desired state, not a claim that this call performed an earlier uncertain write.
  if (before.hash === desired) return { path: request.path, sha256: desired, bytes: bytes.length, state: 'already_present' }
  if (before.hash !== request.expected_sha256) throw new Error('Source write conflict: expected hash does not match current content')
  const temporary = join(parent, `.kode-write-${randomUUID()}`)
  let file
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await file.writeFile(bytes); await file.chmod(before.mode); await file.sync(); await file.close(); file = undefined
    await authorize(); signal?.throwIfAborted()
    await inspectPath(root, posix.dirname(request.path))
    const current = await readCurrent()
    if (current.hash !== before.hash || current.mode !== before.mode) throw new Error('Source write conflict: changed before replacement')
    // The held cooperative lease excludes other managed writers; recheck abort before replacement.
    signal?.throwIfAborted()
    if (before.hash === null) { await link(temporary, target); await unlink(temporary) }
    else await rename(temporary, target)
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
    signal?.throwIfAborted(); await authorize()
    const after = await readCurrent()
    if (after.hash !== desired) throw new Error('Source write result changed; reconciliation required')
    return { path: request.path, previous_sha256: before.hash, sha256: desired, bytes: bytes.length, state: 'written' }
  } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
export async function executeAssignmentWriteTool(runtime, agent, binding, lock, request, signal, authorize) {
  if (!validWriteRequest(request)) throw new Error('Invalid source write request')
  const { assignment, run } = await resolveAssignmentSource(runtime, agent, binding, lock, { path: request.path }, signal)
  const stage = run.context.binding.workflow.pack.stages.find(stage => stage.id === assignment.stage_id)
  const repository = run.context.binding.project.config.spec.repositories[stage?.execution?.repository_binding]
  if (!stage?.execution?.capabilities.includes('workspace_write')) throw new Error('Source write exceeds frozen workspace scope')
  await assertTaskWorkspace(runtime, assignment, repository, lock)
  return writeAssignmentSource(lock.root, request, signal, authorize)
}
