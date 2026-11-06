/** Provision only the Home-bound write stage; the receipt is not authority until Home accepts it. */
import { isDeepStrictEqual } from 'node:util'
import { realpath } from 'node:fs/promises'
import { assignmentHomeCall, readAssignmentRun } from './assignment-home.js'
import { taskStartingSnapshot } from './task-workspace-snapshot.js'
export const requiresTaskWorktree = assignment => assignment.candidate?.grant_scope?.capabilities?.includes('workspace_write') === true
export function taskWorkspaceIdentity(receipt) {
  return Object.fromEntries(['key', 'repository', 'common_dir', 'root', 'branch', 'base_commit'].map(key => [key, receipt[key]]))
}
export async function assertTaskWorkspace(runtime, assignment, repository, lock) {
  const derived = assignment.execution_workspace?.receipt
  if (!runtime.taskWorktrees || !derived || derived.kind !== 'derived_task_worktree' || derived.scope_authorized !== true
      || derived.assignment_id !== assignment.id || derived.run_id !== assignment.run_id || derived.host !== runtime.host
      || derived.repository !== repository?.workspace.root_ref || repository.workspace.host_id !== runtime.host
      || lock?.root !== derived.root || derived.scope.target.root !== derived.root
      || !isDeepStrictEqual(derived, assignment.task_workspace?.receipt)
      || !isDeepStrictEqual(derived.authority_scope, assignment.candidate.grant_scope)) throw Error('Authorized task worktree ownership unavailable')
  await runtime.taskWorktrees.validate(taskWorkspaceIdentity(derived))
  return derived.root
}
export async function prepareTaskWorkspace(runtime, assignment, signal, homeScope) {
  if (!requiresTaskWorktree(assignment)) return assignment
  if (!runtime.taskWorktrees || runtime.closed) throw Error('Automatic write task worktree Host unavailable')
  const command = assignment.dispatch.command, operation = command.operation
  const scope = { id: assignment.id, host: runtime.host, worker: assignment.worker.session_id, operation }
  if (homeScope && (!isDeepStrictEqual(operation, homeScope.operation) || scope.worker !== homeScope.worker_session)) throw Error('Task worktree Home binding changed')
  const original = assignment.candidate.grant_scope.target
  const registered = runtime.ctx.get('workspaceRegistry')?.list().find(row => row.id === original.workspace)
  if (original.host !== runtime.host || !registered || await realpath(registered.path) !== original.root) throw Error('Task worktree source is not the registered granted repository')
  const run = await readAssignmentRun(runtime, { id: scope.worker }, { managedAssignment: { id: assignment.id }, managedOperation: operation }, assignment, signal)
  const state = run.stages.find(row => row.stage_id === assignment.stage_id)
  const stage = run.context.binding.workflow.pack.stages.find(row => row.id === assignment.stage_id)
  if (run.context_hash !== assignment.context_hash || run.authorization?.snapshot_hash !== assignment.authorization_hash
      || state?.assignment_id !== assignment.id || state.attempt !== assignment.stage_attempt || !stage?.execution?.capabilities.includes('workspace_write')) throw Error('Task worktree current stage changed')
  const repository = run.context.binding.project.config.spec.repositories[stage.execution.repository_binding]
  const workspace = await runtime.taskWorktrees.prepare({ home: operation.home_node ?? runtime.host, host: runtime.host,
    run_id: assignment.run_id, repository_binding: stage.execution.repository_binding, repository: original.root }, { signal, authorize: async planned => {
      const request = assignment.task_workspace_prepare?.request ?? { request_id: `plan-${assignment.id}`, expected_revision: assignment.revision,
        input_hash: assignment.inputs.hash, context_hash: assignment.context_hash, authorization_hash: assignment.authorization_hash,
        stage_attempt: assignment.stage_attempt, operation, repository_binding: stage.execution.repository_binding, workspace: planned }
      if (!isDeepStrictEqual(request.workspace, planned)) throw Error('Task worktree preparation identity changed')
      const receipt = await assignmentHomeCall(runtime.client, scope, 'task_workspace_prepare', request, signal)
      const current = await assignmentHomeCall(runtime.client, scope, 'context', undefined, signal)
      if (receipt.kind !== 'task_worktree_preparation' || receipt.assignment_id !== assignment.id
          || receipt.provision_authorized !== true || receipt.scope_authorized !== false || receipt.execution_authorized !== false
          || receipt.operation_id !== operation.id || receipt.attempt !== operation.attempt || receipt.epoch !== operation.epoch
          || receipt.input_hash !== assignment.inputs.hash || !isDeepStrictEqual(taskWorkspaceIdentity(receipt), planned)
          || !isDeepStrictEqual(current.task_workspace_prepare?.receipt, receipt) || !isDeepStrictEqual(current.inputs, assignment.inputs)
          || !isDeepStrictEqual(current.dispatch.command.operation, operation) || current.state !== 'prepared') throw Error('Home task worktree preparation mismatch')
      assignment = current
    } })
  const current = await assignmentHomeCall(runtime.client, scope, 'context', undefined, signal)
  if (!isDeepStrictEqual(current, assignment)) throw Error('Assignment changed during task worktree preparation')
  const starting_snapshot = await taskStartingSnapshot(runtime, current, repository, workspace, signal)
  const request = current.task_workspace?.request ?? { request_id: `task-${assignment.id}`, expected_revision: current.revision,
    input_hash: current.inputs.hash, context_hash: current.context_hash, authorization_hash: current.authorization_hash,
    stage_attempt: current.stage_attempt, operation, repository_binding: stage.execution.repository_binding, workspace, starting_snapshot }
  if (!isDeepStrictEqual(request.workspace, workspace) || !isDeepStrictEqual(request.starting_snapshot, starting_snapshot)) throw Error('Task worktree saved identity changed')
  const receipt = await assignmentHomeCall(runtime.client, scope, 'task_workspace', request, signal)
  const prepared = await assignmentHomeCall(runtime.client, scope, 'context', undefined, signal)
  if (receipt.kind !== 'derived_task_worktree' || receipt.assignment_id !== assignment.id || receipt.run_id !== assignment.run_id
      || receipt.host !== runtime.host || receipt.operation_id !== operation.id || receipt.attempt !== operation.attempt || receipt.epoch !== operation.epoch
      || receipt.input_hash !== assignment.inputs.hash || receipt.repository_binding !== stage.execution.repository_binding
      || !isDeepStrictEqual(receipt.starting_snapshot, starting_snapshot)
      || receipt.scope_authorized !== true || receipt.execution_authorized !== false
      || !isDeepStrictEqual(taskWorkspaceIdentity(receipt), workspace)
      || !isDeepStrictEqual(receipt.authority_scope, assignment.candidate.grant_scope)
      || !isDeepStrictEqual(prepared.task_workspace?.receipt, receipt) || !isDeepStrictEqual(prepared.execution_workspace?.receipt, receipt)
      || prepared.dispatch.command.cwd !== workspace.root || prepared.state !== 'prepared'
      || !isDeepStrictEqual(prepared.inputs, assignment.inputs)) throw Error('Home task worktree receipt mismatch')
  await runtime.taskWorktrees.validate(workspace)
  signal?.throwIfAborted()
  return prepared
}
