import { readAssignmentContext, readAssignmentRun } from './assignment-home.js'
/** Bounded source inspection within the exact held Assignment workspace. No shell or caller-selected root. */
import { open, lstat, realpath, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
const maxBytes = 256 * 1024
export function validSourceRequest(request) {
  return request && Object.keys(request).join(',') === 'path' && typeof request.path === 'string'
    && request.path.length <= 1024 && (request.path === '.' || request.path.split('/').every(part =>
      part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !/[\\\x00-\x1f\x7f:]/.test(part)))
}
export async function inspectPath(root, relative) {
  if (await realpath(root) !== root) throw new Error('Source root identity changed')
  let current = root
  for (const part of relative === '.' ? [] : relative.split('/')) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error('Source symlinks are not readable')
    if (!stat.isDirectory() && current !== join(root, relative)) throw new Error('Source parent is not a directory')
  }
  if (await realpath(current) !== current) throw new Error('Source path identity changed')
  return current
}
export async function inspectAssignmentSource(root, name, request, signal, authorize) {
  if (!validSourceRequest(request) || !['kode_read_source', 'kode_list_source'].includes(name)) throw new Error('Invalid source inspection request')
  signal?.throwIfAborted(); await authorize()
  const path = await inspectPath(root, request.path)
  if (name === 'kode_list_source') {
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.length > 2048) throw new Error('Source directory exceeds inspection limit')
    const items = entries.filter(entry => entry.name.toLowerCase() !== '.git').map(entry => ({ name: entry.name,
      kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'unsupported' }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    await inspectPath(root, request.path); signal?.throwIfAborted(); await authorize()
    return { path: request.path, entries: items }
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new Error('Source must be a bounded regular file without hardlinks')
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < buffer.length) {
      signal?.throwIfAborted()
      const chunk = await file.read(buffer, size, buffer.length - size, size)
      if (!chunk.bytesRead) break
      size += chunk.bytesRead
    }
    if (size > maxBytes) throw new Error('Source file exceeds inspection limit')
    const after = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true })
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || current.isSymbolicLink()
        || await realpath(dirname(path)) !== dirname(path)) throw new Error('Source changed during inspection')
    await inspectPath(root, request.path); signal?.throwIfAborted(); await authorize()
    const bytes = buffer.subarray(0, size)
    if (bytes.includes(0)) throw new Error('Binary source is not supported')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { path: request.path, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex'), text }
  } finally { await file.close() }
}
export async function resolveAssignmentSource(runtime, agent, binding, lock, request, signal) {
  if (!validSourceRequest(request) || !binding.managedAssignment?.id || !lock) throw new Error('Managed source inspection required')
  const assignment = await readAssignmentContext(runtime, agent, binding, signal)
  if (assignment.id !== binding.managedAssignment.id || assignment.state !== 'prepared'
      || assignment.worker.session_id !== agent.id || assignment.worker.node_id !== runtime.host
      || !isDeepStrictEqual(assignment.dispatch.command.operation, binding.managedOperation)
      || assignment.dispatch.command.cwd !== lock.root) throw new Error('Source Assignment ownership mismatch')
  const run = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  const state = run.stages.find(stage => stage.stage_id === assignment.stage_id)
  if (state?.assignment_id !== assignment.id || state.attempt !== assignment.stage_attempt || state.evidence
      || run.context_hash !== assignment.context_hash || run.authorization.snapshot_hash !== assignment.authorization_hash) throw new Error('Source Assignment is stale')
  return { assignment, run }
}
export async function executeAssignmentSourceTool(runtime, agent, binding, lock, name, request, signal, authorize) {
  await resolveAssignmentSource(runtime, agent, binding, lock, request, signal)
  return inspectAssignmentSource(lock.root, name, request, signal, authorize)
}
