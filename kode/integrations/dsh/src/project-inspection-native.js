import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { resolveBundledServer } from './bundle-runtime.js'

const statuses = new Set(['observed', 'missing', 'unsupported_file', 'too_large', 'changed_during_read', 'not_text', 'symlink_denied', 'unavailable', 'directory_scanned', 'directory_partial'])

export async function inspectProjectConfiguration({ root, workspaceId, paths, identity, command, signal }) {
  signal?.throwIfAborted()
  command ??= await resolveBundledServer()
  if (!command) throw Object.assign(Error('directory-safe project inspector unavailable'), { code: 'INSPECTOR_UNAVAILABLE' })
  const request = { root, workspace_id: workspaceId, device: String(identity.dev), inode: String(identity.ino), paths }
  const task = promisify(execFile)(command, ['--inspect-project'], {
    timeout: 15000, maxBuffer: 512 * 1024, encoding: 'utf8', env: { LANG: 'C.UTF-8' }, signal,
  })
  const closed = new Promise(resolve => task.child.once('close', resolve))
  task.child.stdin?.on('error', () => {})
  task.child.stdin?.end(JSON.stringify(request))
  let result
  try {
    const output = await task
    await closed
    signal?.throwIfAborted()
    result = JSON.parse(output.stdout)
  }
  catch (error) {
    await closed
    signal?.throwIfAborted()
    const unsupported = error.code === 'ENOENT' || (typeof error.stderr === 'string' && error.stderr.includes('unknown argument: --inspect-project'))
    throw Object.assign(Error('directory-safe project inspection unavailable'), { code: unsupported ? 'INSPECTOR_UNAVAILABLE' : 'INSPECTION_FAILED' })
  }
  if (result.schema_version !== 2 || result.workspace_id !== workspaceId || result.eligible_for_execution !== false
    || result.root_identity?.device !== request.device || result.root_identity?.inode !== request.inode
    || !Array.isArray(result.facts) || result.facts.length < 1 || result.facts.length > 56
    || !Array.isArray(result.pending_checks) || result.pending_checks.length > 16
    || result.pending_checks.some(value => typeof value !== 'string')) throw Error('project inspection scope mismatch')
  const seen = new Set()
  for (const fact of result.facts) {
    if (typeof fact.path !== 'string' || fact.path.length > 1024 || fact.path.includes('\\') || fact.path.includes('\0')
      || fact.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(fact.path)
      || !paths.some(path => fact.path === path || fact.path.startsWith(path + '/')) || !statuses.has(fact.status)) throw Error('project inspection path mismatch')
    seen.add(fact.path)
    if (fact.status === 'observed') {
      if (typeof fact.content !== 'string' || fact.content.includes('\0') || Buffer.byteLength(fact.content) > 65536
        || fact.bytes !== Buffer.byteLength(fact.content) || fact.trust !== 'untrusted_project_data'
        || !Number.isSafeInteger(fact.observed_at) || fact.observed_at <= 0
        || fact.sha256 !== createHash('sha256').update(fact.content).digest('hex')) throw Error('project inspection content mismatch')
    } else if (['content', 'bytes', 'sha256', 'trust', 'observed_at'].some(key => Object.hasOwn(fact, key))) throw Error('unobserved project content returned')
  }
  return result
}
