import { selectInputArtifact } from './assignment-input-artifact.js'
import { assignmentHomeCall, readAssignmentRun } from './assignment-home.js'
import { prepareTaskWorkspace, requiresTaskWorktree } from './assignment-task-workspace.js'
/** Prepare a downstream cwd from frozen inputs before any Worker creation or resource hold. */
import { isDeepStrictEqual } from 'node:util'
const prefix = '/api/v1/messaging/'
export async function prepareDispatchWorkspace(runtime, assignment, signal, homeScope) {
  if (requiresTaskWorktree(assignment)) return prepareTaskWorkspace(runtime, assignment, signal, homeScope)
  const sources = assignment.inputs?.binding?.sources
  if (!sources || Object.keys(sources).length === 0) return assignment
  const path = `${prefix}work-assignments/${encodeURIComponent(assignment.id)}`
  const homeBinding = homeScope ? { id: assignment.id, host: runtime.host, worker: homeScope.worker_session, operation: homeScope.operation } : null
  const read = () => homeBinding ? assignmentHomeCall(runtime.client, homeBinding, 'context', undefined, signal) : runtime.client.call(path, undefined, signal)
  const run = await readAssignmentRun(runtime, { id: assignment.worker.session_id }, { managedAssignment: { id: assignment.id }, managedOperation: assignment.dispatch.command.operation }, assignment, signal)
  if (run.context_hash !== assignment.context_hash || run.authorization?.snapshot_hash !== assignment.authorization_hash
      || !run.stages?.some(s => s.stage_id === assignment.stage_id && s.assignment_id === assignment.id && s.attempt === assignment.stage_attempt)) {
    throw new Error('Assignment dispatch input context changed')
  }
  const pack = run.context.binding.workflow.pack
  const stage = pack.stages.find(s => s.id === assignment.stage_id)
  if (!stage?.execution || stage.execution.network || stage.execution.capabilities.some(c => c !== 'read')) {
    throw new Error('Automatic downstream workspace requires read-only offline scope')
  }
  const artifacts = Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .flatMap(([source_stage, source]) => Object.entries(source.outputs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, value]) => value.artifact).map(([output, value]) => ({ ...value, source_stage, output })))
  const referenced = new Set(stage.produces.map(output => pack.evidence_rules[output]?.artifact_output).filter(Boolean))
  const mapped = selectInputArtifact(stage, artifacts, referenced)
  const choices = mapped ? [mapped] : artifacts.filter(source => !referenced.size || referenced.has(source.output))
  const first = choices[0]
  if (!first || [...referenced].some(output => !choices.some(source => source.output === output))) {
    throw new Error('Automatic downstream workspace has no bound artifact source')
  }
  if (!mapped && (artifacts.some(source => source.artifact.repository_binding !== stage.execution.repository_binding
      || source.artifact.snapshot_hash !== first.artifact.snapshot_hash)
      || choices.some(source => source.sequence !== first.sequence && referenced.size > 1))) {
    throw new Error('Automatic downstream workspace requires explicit multi-source mapping')
  }
  // Preserve an already committed materialization identity, including a lost reply.
  const saved = assignment.input_workspace?.request
  const source = saved ? choices.find(s => s.source_stage === saved.source_stage && s.output === saved.output) : first
  if (!source) throw new Error('Assignment dispatch materialization source changed')
  const request = { assignment_id: assignment.id, source_stage: source.source_stage, output: source.output }
  const materialized = await runtime.bindAssignmentInput(request, { signal, homeScope })
  const current = await read()
  if (current.state !== 'prepared' || current.worker.node_id !== runtime.host
      || !isDeepStrictEqual(current.inputs, assignment.inputs)
      || !isDeepStrictEqual(current.input_workspace?.receipt, materialized)) {
    throw new Error('Assignment dispatch workspace binding changed')
  }
  if (homeScope) return current
  const command = current.execution_workspace?.request ?? {
    request_id: `host-scope-${assignment.id}`, expected_revision: current.revision,
  }
  const scope = await runtime.client.call(`${path}/workspace-scope`, command, signal)
  const prepared = await runtime.client.call(path, undefined, signal)
  if (scope.assignment_id !== assignment.id || scope.input_hash !== assignment.inputs.hash
      || scope.snapshot_hash !== source.artifact.snapshot_hash || scope.scope?.target.root !== materialized.root
      || scope.scope_authorized !== true || scope.execution_authorized !== false
      || !isDeepStrictEqual(prepared.execution_workspace?.receipt, scope)
      || prepared.dispatch.command.cwd !== materialized.root || prepared.state !== 'prepared'
      || !isDeepStrictEqual(prepared.inputs, assignment.inputs)) {
    throw new Error('Assignment dispatch derived scope mismatch')
  }
  signal?.throwIfAborted()
  return prepared
}
