import { readAssignmentContext, readAssignmentRun } from './assignment-home.js'
/** Revalidate the selected immutable input under the held derived workspace lock before report. */
import { isDeepStrictEqual } from 'node:util'
import { taskWorkspaceIdentity } from './assignment-task-workspace.js'
export async function captureAssignmentFinalInput(runtime, agent, binding, lock, signal) {
  const id = binding.managedAssignment?.id
  if (!id) return null
  const assignment = await readAssignmentContext(runtime, agent, binding, signal)
  const derived = assignment.execution_workspace?.receipt
  if (!derived) return null
  if (assignment.worker.session_id !== agent.id || !isDeepStrictEqual(assignment.dispatch.command.operation, binding.managedOperation)
      || !lock || lock.root !== derived.scope.target.root) throw new Error('Final input requires owned derived workspace lock')
  if (derived.kind === 'derived_task_worktree') {
    if (!runtime.taskWorktrees || lock.root !== derived.root) throw Error('Final task worktree ownership unavailable')
    await runtime.taskWorktrees.validate(taskWorkspaceIdentity(derived))
    return null
  }
  const run = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  const stage = run.stages.find(s => s.stage_id === assignment.stage_id)
  if (stage?.assignment_id !== id || stage.attempt !== assignment.stage_attempt) throw new Error('Final input stage changed')
  const prepared = await runtime.prepareAssignmentInput({ assignment_id: id, source_stage: derived.source_stage, output: derived.output }, { signal, homeScope: binding.managedOperation.home_node && binding.managedOperation.home_node !== runtime.host ? { worker_session: agent.id, operation: binding.managedOperation } : undefined })
  if (prepared.workspace.source !== lock.root || prepared.input_hash !== derived.input_hash || prepared.snapshot_hash !== derived.snapshot_hash) throw new Error('Final input snapshot changed')
  const current = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  if (!isDeepStrictEqual(current.stages.find(s => s.stage_id === assignment.stage_id)?.evidence, stage.evidence)) throw new Error('Final input evidence selection changed')
  return { assignment_id: id, input_hash: derived.input_hash, snapshot_hash: prepared.snapshot_hash,
    source_sequence: prepared.sequence, selection: stage.evidence ?? null }
}
