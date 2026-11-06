import { readAssignmentContext, readAssignmentRun } from './assignment-home.js'
/** Capture/record against frozen Assignment bindings; model arguments never choose a repository or source hash. */
import { isDeepStrictEqual } from 'node:util'
import { recordAssignmentOutputCandidate } from './assignment-outputs.js'
import { assertTaskWorkspace, requiresTaskWorktree } from './assignment-task-workspace.js'
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value)
export function validReviewShape(request) {
  return request && Object.keys(request).sort().join(',') === 'findings,output,request_id,verdict'
    && id(request.output) && id(request.request_id) && ['passed', 'failed', 'inconclusive'].includes(request.verdict)
    && Array.isArray(request.findings) && request.findings.length <= 128
    && request.findings.every(f => f && Object.keys(f).sort().join(',') === 'blocking,evidence_ref,id'
      && id(f.id) && id(f.evidence_ref) && typeof f.blocking === 'boolean')
}
export function validReviewRequest(request) {
  return validReviewShape(request)
    && new Set(request.findings.map(f => f.id)).size === request.findings.length
    && !(request.verdict === 'passed' && request.findings.some(f => f.blocking))
}
export async function executeAssignmentEvidenceTool(runtime, agent, binding, lock, name, request, signal, authorize) {
  const review = name === 'kode_review_output'
  if (review ? !validReviewRequest(request) : !request || Object.keys(request).sort().join(',') !== 'output,request_id' || !Object.values(request).every(id)) {
    throw new Error('Invalid Assignment evidence tool request')
  }
  const assignmentId = binding.managedAssignment?.id
  if (!assignmentId) throw new Error('Managed evidence Assignment required')
  const assignment = await readAssignmentContext(runtime, agent, binding, signal)
  if (assignment.state !== 'prepared' || assignment.worker.session_id !== agent.id || assignment.worker.node_id !== runtime.host
      || !isDeepStrictEqual(assignment.dispatch.command.operation, binding.managedOperation) || !lock) throw new Error('Evidence Assignment ownership mismatch')
  const run = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  const pack = run.context.binding.workflow.pack, stage = pack.stages.find(s => s.id === assignment.stage_id)
  const state = run.stages.find(s => s.stage_id === assignment.stage_id), rule = pack.evidence_rules[request.output]
  if (!stage?.produces.includes(request.output) || rule?.kind !== (review ? 'review' : 'artifact')
      || state?.assignment_id !== assignment.id || state.attempt !== assignment.stage_attempt || state.evidence
      || run.context_hash !== assignment.context_hash || run.authorization.snapshot_hash !== assignment.authorization_hash) throw new Error('Frozen evidence stage unavailable')
  await authorize()
  let observation
  if (review) {
    const derived = assignment.execution_workspace?.receipt
    const sources = Object.values(assignment.inputs.binding.sources).flatMap(source => Object.entries(source.outputs)
      .filter(([output]) => output === rule.artifact_output).map(([, value]) => value))
    if (!derived || derived.scope.target.root !== lock.root || sources.length !== 1 || !sources[0].artifact
        || sources[0].sequence !== assignment.input_workspace.receipt.sequence || sources[0].artifact.snapshot_hash !== derived.snapshot_hash) throw new Error('Review source snapshot mismatch')
    observation = await runtime.artifacts.record(agent.id, binding.managedOperation, request.request_id, { kind: 'review',
      artifact_sequence: sources[0].sequence, snapshot_hash: derived.snapshot_hash, verdict: request.verdict, findings: request.findings })
  } else {
    const repository = run.context.binding.project.config.spec.repositories[rule.repository_binding]
    if (!repository || stage.execution.repository_binding !== rule.repository_binding || repository.workspace.host_id !== runtime.host) throw new Error('Artifact repository binding mismatch')
    if (requiresTaskWorktree(assignment)) await assertTaskWorkspace(runtime, assignment, repository, lock)
    else if (repository.workspace.root_ref !== lock.root || assignment.execution_workspace) throw new Error('Artifact repository binding mismatch')
    observation = await runtime.artifacts.capture(agent.id, binding.managedOperation, request.request_id,
      { workspaceRoot: lock.root, repositoryId: repository.repository_id, signal })
  }
  await authorize()
  await recordAssignmentOutputCandidate(runtime, assignment, stage.produces, request.output, observation.evidence.id)
  return { output: request.output, evidence_id: observation.evidence.id, sequence: observation.home_sequence ?? null,
    verdict: observation.evidence.payload.verdict ?? null, home_reconciled: observation.home_reconciled,
    archive_status: review ? 'not_applicable' : observation.home_archive_reconciled ? 'home_archived' : 'pending_home', completion_authorized: false }
}
