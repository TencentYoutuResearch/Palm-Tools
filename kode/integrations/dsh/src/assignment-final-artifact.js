import { readAssignmentContext, readAssignmentRun } from './assignment-home.js'
/** Host-only final source observation while the Assignment still owns its workspace lock. */
import { isDeepStrictEqual } from 'node:util'
import { captureArtifactSnapshot } from './artifact-snapshot.js'
import { artifactSnapshotHash } from './artifact-archive.js'
import { assertTaskWorkspace, requiresTaskWorktree } from './assignment-task-workspace.js'
export async function captureAssignmentFinalArtifact(runtime, agent, binding, workspaceLease, signal) {
  const id = binding.managedAssignment?.id
  if (!id) return null
  const assignment = await readAssignmentContext(runtime, agent, binding, signal)
  const run = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  const state = run.stages.find(row => row.stage_id === assignment.stage_id)
  if (!state?.evidence) return null // Reporting may precede selection; this cannot authorize stage completion.
  if (state.assignment_id !== id || state.attempt !== assignment.stage_attempt || assignment.context_hash !== run.context_hash
      || assignment.authorization_hash !== run.authorization?.snapshot_hash || assignment.worker.session_id !== agent.id
      || !isDeepStrictEqual(assignment.dispatch.command.operation, binding.managedOperation)) throw new Error('Final artifact Assignment binding changed')
  const pack = run.context.binding.workflow.pack, stage = pack.stages.find(row => row.id === assignment.stage_id)
  const artifactOutputs = stage?.produces.filter(output => pack.evidence_rules[output]?.kind === 'artifact') ?? []
  if (!artifactOutputs.length) return null
  const repository = run.context.binding.project.config.spec.repositories[stage.execution.repository_binding]
  if (requiresTaskWorktree(assignment)) await assertTaskWorkspace(runtime, assignment, repository, workspaceLease)
  else if (!workspaceLease || workspaceLease.root !== repository.workspace.root_ref || repository.workspace.host_id !== runtime.host) throw new Error('Final artifact requires the held authorized workspace')
  const snapshot = await captureArtifactSnapshot({ workspaceRoot: workspaceLease.root, repositoryId: repository.repository_id, signal })
  const snapshotHash = artifactSnapshotHash({ kind: 'artifact', snapshot })
  const observations = Object.values(runtime.profiles.binding(agent.id)?.artifactOutbox ?? {})
  for (const output of artifactOutputs) {
    const row = observations.find(row => row.home_sequence === state.evidence.outputs[output])
    if (!row?.home_archive_reconciled || !isDeepStrictEqual(row.operation, binding.managedOperation)
        || row.evidence.payload.kind !== 'artifact' || !isDeepStrictEqual(row.evidence.payload.snapshot, snapshot)) throw new Error('Selected artifact no longer matches final workspace')
  }
  const current = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  if (!isDeepStrictEqual(current.stages.find(row => row.stage_id === assignment.stage_id)?.evidence, state.evidence)) throw new Error('Final artifact selection changed')
  return { assignment_id: id, selection: structuredClone(state.evidence), snapshot_hash: snapshotHash }
}
