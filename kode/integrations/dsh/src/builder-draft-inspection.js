/** Prepare an exact draft command. Persist/retry that command, never silently reread
 * project files after an ambiguous write. Project text cannot grant capabilities.
 */
import { inspectBuilderWorkspace, BUILDER_INSPECTION_DIRECTORIES } from './builder-inspection.js'
const drafts = '/api/v1/messaging/superagents/drafts'
export async function prepareBuilderDraftInspection(client, registry, input, { signal } = {}) {
  const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
  if (!input || Object.keys(input).some(key => !['draft_id', 'request_id', 'expected_revision', 'workspace_id', 'paths'].includes(key)) ||
      !validId(input.draft_id) || !validId(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) {
    throw new Error('invalid Builder inspection command')
  }
  const draft = await client.call(`${drafts}/${input.draft_id}`)
  if (draft.status !== 'draft' || draft.revision !== input.expected_revision) throw new Error('Builder draft unavailable or revision conflict')
  const node = await client.call('/api/v1/messaging/node')
  if (draft.home_hub !== node.node_id) throw new Error('Builder home mismatch')
  const selected = registry?.list().find(row => row.id === input.workspace_id)
  const workspace = draft.interview.workspace_refs.find(row => row.host_id === node.node_id && row.workspace_id === input.workspace_id && row.root_ref === selected?.path)
  if (!selected || !workspace) throw new Error('workspace is not selected in this Builder draft')
  const result = await inspectBuilderWorkspace(registry, { workspace_id: input.workspace_id, paths: input.paths }, { signal })
  const interview = structuredClone(draft.interview)
  const inspections = interview.inspections ?? []
  const index = inspections.findIndex(row => row.workspace.host_id === workspace.host_id && row.workspace.workspace_id === workspace.workspace_id && row.workspace.root_ref === workspace.root_ref)
  // A complete supported-directory inventory supersedes its prior active cache.
  // Earlier draft revisions retain those observations. Partial scans retain them.
  const scanned = result.facts.filter(fact => fact.status === 'directory_scanned'
    || (fact.status === 'missing' && BUILDER_INSPECTION_DIRECTORIES.includes(fact.path))).map(fact => fact.path)
  const oldFacts = (index < 0 ? [] : inspections[index].facts)
    .filter(fact => !scanned.some(path => fact.path === path || fact.path.startsWith(path + '/')))
  const byPath = new Map(oldFacts.map(fact => [fact.path, fact]))
  for (const fact of result.facts) byPath.set(fact.path, fact)
  if (byPath.size > 64) throw Error('Builder inspection fact capacity reached; incomplete observations remain in the previous draft revision')
  const inspection = { workspace, facts: [...byPath.values()].sort((a,b) => a.path.localeCompare(b.path)), pending_checks: result.pending_checks }
  if (index < 0) inspections.push(inspection); else inspections[index] = inspection
  interview.inspections = inspections
  return { command: { id: draft.id, request_id: input.request_id, expected_revision: draft.revision, revoked: false, interview },
    eligible_for_execution: false, pending_checks: result.pending_checks }
}

export function registerBuilderDraftInspection(ctx, config) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/builder/prepare-inspection', handler: async (req,res) => {
    const send = (status,body) => { res.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error:'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error:'Host owner required' })
    if (req.method !== 'POST') return send(405, { error:'POST required' })
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, { error:'JSON required' })
    try {
      if (!config?.backendClient) throw new Error('backend unavailable')
      let body = ''
      for await (const part of req) { body += part; if (Buffer.byteLength(body) > 4096) throw new Error('request too large') }
      send(200, await prepareBuilderDraftInspection(config.backendClient, ctx.get('workspaceRegistry'), JSON.parse(body)))
    } catch { send(400, { error:'Builder inspection unavailable or draft selection invalid' }) }
  } })
}
