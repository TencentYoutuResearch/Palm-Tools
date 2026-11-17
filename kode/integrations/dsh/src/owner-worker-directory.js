/** Owner-local UI metadata only. Never feed this projection into runtime/mobile/federation catalogues. */
import { isDeepStrictEqual } from 'node:util'
export const OWNER_WORKER_CANDIDATE_LIMIT = 100
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
export async function ownerWorkerDirectory(ctx, client, directory) {
  if (!client || !valid(directory.nodeId)) return []
  const profiles = ctx.get('kodeAgents')?.profiles, controller = ctx.get('sessionController')
  if (!profiles?.binding || !controller?.list) return []
  const host = directory.nodeId, rows = (await controller.list({})).items, result = []
  const archived = new Set(directory.archivedSessionIds)
  // Bounded owner-only reads; incomplete or remote identities stay hidden.
  const candidates = rows.filter(row => { const b = profiles.binding(row.sessionId); return !row.blank && !archived.has(row.sessionId)
    && valid(row.sessionId) && valid(b?.managedAssignment?.id) && valid(b?.managedOperation?.id)
    && (b.managedOperation.home_node ?? host) === host && !b.managedCoordinator && !b.managedBuilder }).slice(0, OWNER_WORKER_CANDIDATE_LIMIT)
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const page = await Promise.all(candidates.slice(offset, offset + 4).map(async row => {
      try {
        const binding = profiles.binding(row.sessionId), assignment = await client.call('/api/v1/messaging/work-assignments/' + encodeURIComponent(binding.managedAssignment.id))
        if (assignment.id !== binding.managedAssignment.id || assignment.worker?.node_id !== host || assignment.worker.session_id !== row.sessionId
          || assignment.dispatch?.command?.command_id !== assignment.id || assignment.dispatch.command.session_id !== row.sessionId
          || !isDeepStrictEqual(assignment.dispatch.command.operation, binding.managedOperation) || !valid(assignment.run_id)) return null
        const run = await client.call('/api/v1/messaging/work-runs/' + encodeURIComponent(assignment.run_id))
        if (run?.id !== assignment.run_id || run.home_hub !== host || !valid(run.team_id) || assignment.team_id !== run.team_id || !/^[a-f0-9]{64}$/.test(run.context_hash ?? '') || run.context_hash !== assignment.context_hash) return null
        const stage = run.context?.binding?.workflow?.pack?.stages?.find(s => s.id === assignment.stage_id)
        const workspace = run.context?.binding?.project?.config?.spec?.repositories?.[stage?.execution?.repository_binding]?.workspace
        if (!workspace || workspace.host_id !== host || !directory.workspaces.some(w => w.id === workspace.workspace_id && w.path === workspace.root_ref)) return null
        return { id: row.sessionId, title: String(row.projections?.values?.title || 'Worker · ' + assignment.stage_id).slice(0, 200), read_only: true,
          scope: { home_hub: host, host_id: host, workspace_id: workspace.workspace_id, root_ref: workspace.root_ref },
          run: { id: run.id, team_id: run.team_id, home_hub: host },
          item: { assignment_id: assignment.id, worker: assignment.worker, operation: { id: binding.managedOperation.id } } }
      } catch { return null }
    }))
    result.push(...page.filter(Boolean))
  }
  return result
}
