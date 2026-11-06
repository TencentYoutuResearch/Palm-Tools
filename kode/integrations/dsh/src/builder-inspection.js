/** Selected project documents are retained as untrusted, versioned observations. */
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inspectProjectConfiguration } from './project-inspection-native.js'

export const BUILDER_INSPECTION_PATH = '/api/kode/builder/inspect-workspace'
const rootFiles = ['README.md', 'AGENTS.md', 'CODEBUDDY.md', 'CLAUDE.md', 'package.json', 'Cargo.toml', 'Makefile', 'pyproject.toml']
export const BUILDER_INSPECTION_DIRECTORIES = Object.freeze(['.github/workflows', 'skills', '.agents/skills', '.codex/skills', '.claude/skills'])
export const BUILDER_INSPECTION_FILES = Object.freeze([...rootFiles, '.gitlab-ci.yml', '.codex-plugin/plugin.json', ...BUILDER_INSPECTION_DIRECTORIES])
const allowed = new Set(BUILDER_INSPECTION_FILES)
const maximumBytes = 64 * 1024

export async function inspectBuilderWorkspace(registry, input, { signal } = {}) {
  signal?.throwIfAborted()
  if (!input || Object.keys(input).some(key => !['workspace_id', 'paths'].includes(key)) ||
      typeof input.workspace_id !== 'string' || !Array.isArray(input.paths) || !input.paths.length ||
      input.paths.length > 8 || new Set(input.paths).size !== input.paths.length ||
      input.paths.some(path => !allowed.has(path))) throw new Error('invalid inspection selection')
  const workspace = registry?.list().find(row => row.id === input.workspace_id)
  if (!workspace) throw new Error('selected workspace unavailable')
  const root = await realpath(workspace.path)
  const identity = await lstat(root, { bigint: true })
  if (!identity.isDirectory()) throw new Error('selected workspace unavailable')
  try { return await inspectProjectConfiguration({ root, workspaceId: workspace.id, paths: input.paths, identity, signal }) }
  catch (error) {
    if (error.code !== 'INSPECTOR_UNAVAILABLE' || input.paths.some(path => !rootFiles.includes(path))) throw error
  }
  const facts = []
  for (const path of input.paths) {
    signal?.throwIfAborted()
    let handle
    try {
      // No following even an in-project symlink: it could point to a credential file.
      handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat()
      if (!before.isFile() || before.nlink !== 1) { facts.push({ path, status: 'unsupported_file' }); continue }
      if (before.size > maximumBytes) { facts.push({ path, status: 'too_large' }); continue }
      const bytes = Buffer.alloc(maximumBytes + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat()
      const rootAfter = await lstat(root, { bigint: true })
      if (bytesRead > maximumBytes || before.size !== bytesRead || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          rootAfter.dev !== identity.dev || rootAfter.ino !== identity.ino || !rootAfter.isDirectory()) {
        facts.push({ path, status: 'changed_during_read' }); continue
      }
      const data = bytes.subarray(0, bytesRead)
      let content
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) } catch { facts.push({ path, status: 'not_text' }); continue }
      if (content.includes('\0')) { facts.push({ path, status: 'not_text' }); continue }
      facts.push({ path, status: 'observed', sha256: createHash('sha256').update(data).digest('hex'), bytes: bytesRead, observed_at: Date.now(), content, trust: 'untrusted_project_data' })
    } catch (error) {
      if (error.code === 'ENOENT') facts.push({ path, status: 'missing' })
      else if (error.code === 'ELOOP') facts.push({ path, status: 'symlink_denied' })
      else facts.push({ path, status: 'unavailable' })
    } finally { await handle?.close() }
  }
  signal?.throwIfAborted()
  return { schema_version: 1, workspace_id: workspace.id, facts, eligible_for_execution: false,
    pending_checks: ['native_directory_anchor_unavailable', 'nested_ci_and_skills', 'trusted_resources', 'workflow_preflight', 'human_activation'] }
}

export function registerBuilderInspection(ctx) {
  return ctx.webServer.register({ kind: 'exact', path: BUILDER_INSPECTION_PATH, handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'POST') return send(405, { error: 'POST required' })
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error: 'JSON required' })
    try {
      let body = ''
      for await (const part of req) { body += part; if (Buffer.byteLength(body) > 4096) throw new Error('request too large') }
      send(200, await inspectBuilderWorkspace(ctx.get('workspaceRegistry'), JSON.parse(body)))
    } catch { send(400, { error: 'workspace inspection unavailable or selection invalid' }) }
  } })
}
