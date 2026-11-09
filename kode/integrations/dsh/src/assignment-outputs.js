import { readAssignmentContext, readAssignmentRun } from './assignment-home.js'
/** Durable named outputs refer only to this Worker's already archived observations. */
import { isDeepStrictEqual } from 'node:util'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
function observation(binding, operation, evidenceId) {
  const row = Object.values(binding?.artifactOutbox ?? {}).find(row => row.evidence.id === evidenceId && isDeepStrictEqual(row.operation, operation))
  if (!row?.home_reconciled || !Number.isSafeInteger(row.home_sequence) || row.home_sequence < 1) throw new Error('Named output evidence is not home-reconciled')
  if (row.evidence.payload.kind === 'artifact' && (!row.archive || !row.home_archive_reconciled)) throw new Error('Named output artifact archive unavailable')
  if (row.evidence.payload.kind === 'verification' && !Object.values(binding.verificationRecords ?? {}).some(record =>
    isDeepStrictEqual(record.operation, operation) && record.evidence_id === evidenceId && record.home_reconciled && record.sequence === row.home_sequence)) {
    throw new Error('Named output verification archive unavailable')
  }
  return row
}
function identity(assignment) {
  return { assignment_id: assignment.id, context_hash: assignment.context_hash, authorization_hash: assignment.authorization_hash,
    stage_attempt: assignment.stage_attempt, operation: assignment.dispatch.command.operation }
}
function assertBinding(binding, assignment) {
  if (binding?.managedAssignment?.id !== assignment.id || !isDeepStrictEqual(binding.managedOperation, assignment.dispatch.command.operation)) {
    throw new Error('Named output Assignment binding changed')
  }
}
/** Preserve the output explicitly named by a successful trusted evidence tool. */
export async function recordAssignmentOutputCandidate(runtime, assignment, produces, output, evidenceId) {
  if (!produces.includes(output) || !valid(evidenceId)) throw new Error('Invalid Assignment output candidate')
  const fixed = identity(assignment)
  await runtime.profiles.update(profiles => {
    const binding = profiles.bindings[assignment.worker.session_id]
    assertBinding(binding, assignment)
    if (binding.operationClosed) throw new Error('Assignment output candidate ownership ended')
    const row = Object.values(binding.artifactOutbox ?? {}).find(row => row.evidence.id === evidenceId
      && isDeepStrictEqual(row.operation, fixed.operation))
    if (!row) throw new Error('Assignment output candidate observation missing')
    const ledger = binding.assignmentOutputCandidates ??= { identity: structuredClone(fixed), produces: [...produces], outputs: {} }
    if (!isDeepStrictEqual(ledger.identity, fixed) || !isDeepStrictEqual(ledger.produces, produces)) throw new Error('Assignment output candidate binding conflict')
    if (!Object.hasOwn(ledger.outputs, output)) Object.defineProperty(ledger.outputs, output,
      { value: [], enumerable: true, writable: true, configurable: true })
    const candidates = ledger.outputs[output]
    if (!candidates.includes(evidenceId)) {
      if (candidates.length >= 128) throw new Error('Assignment output candidate limit reached')
      candidates.push(evidenceId)
    }
  })
}
export async function publishAssignmentOutput(runtime, agent, binding, request, signal, authorize) {
  if (!request || Object.keys(request).sort().join(',') !== 'evidence_id,output' || !Object.values(request).every(valid)) throw new Error('Invalid named output request')
  const assignmentId = binding.managedAssignment?.id
  if (!assignmentId) throw new Error('Named output requires a managed Assignment')
  const assignment = await readAssignmentContext(runtime, agent, binding, signal)
  assertBinding(binding, assignment)
  if (assignment.state !== 'prepared' || assignment.worker.session_id !== agent.id || assignment.worker.node_id !== runtime.host) throw new Error('Named output ownership unavailable')
  const run = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  const pack = run.context.binding.workflow.pack, stage = pack.stages.find(stage => stage.id === assignment.stage_id)
  const state = run.stages.find(stage => stage.stage_id === assignment.stage_id)
  if (run.context_hash !== assignment.context_hash || run.authorization?.snapshot_hash !== assignment.authorization_hash
      || state?.assignment_id !== assignment.id || state.attempt !== assignment.stage_attempt || !stage?.produces.includes(request.output)) {
    throw new Error('Named output does not belong to the frozen stage')
  }
  const current = runtime.profiles.binding(agent.id)
  assertBinding(current, assignment)
  const row = observation(current, binding.managedOperation, request.evidence_id)
  if (row.evidence.payload.kind !== pack.evidence_rules[request.output]?.kind) throw new Error('Named output evidence kind mismatch')
  if (state.evidence && state.evidence.outputs[request.output] !== row.home_sequence) throw new Error('Named output differs from selected evidence')
  const fixed = identity(assignment), value = { evidence_id: request.evidence_id, sequence: row.home_sequence }
  await authorize()
  signal.throwIfAborted()
  await runtime.profiles.update(profiles => {
    const saved = profiles.bindings[agent.id]
    assertBinding(saved, assignment)
    if (saved.operationClosed || observation(saved, fixed.operation, request.evidence_id).home_sequence !== value.sequence) throw new Error('Named output execution changed')
    const ledger = saved.assignmentOutputs ??= { identity: structuredClone(fixed), produces: [...stage.produces], outputs: {} }
    if (!isDeepStrictEqual(ledger.identity, fixed) || !isDeepStrictEqual(ledger.produces, stage.produces)) throw new Error('Named output ledger identity conflict')
    if (Object.hasOwn(ledger.outputs, request.output)) {
      if (!isDeepStrictEqual(ledger.outputs[request.output], value)) throw new Error('Named output already published; a new attempt is required')
    } else Object.defineProperty(ledger.outputs, request.output, { value, enumerable: true, writable: true, configurable: true })
  })
  return { ...fixed, output: request.output, ...value, completion_authorized: false }
}
export function readAssignmentOutputs(runtime, assignment) {
  const binding = runtime.profiles.binding(assignment.worker.session_id)
  assertBinding(binding, assignment)
  const published = binding.assignmentOutputs, candidates = binding.assignmentOutputCandidates
  const ledger = published ?? candidates
  if (!ledger) return null
  if (!isDeepStrictEqual(ledger.identity, identity(assignment)) || !Array.isArray(ledger.produces)) throw new Error('Named output ledger binding mismatch')
  if (candidates && (!isDeepStrictEqual(candidates.identity, ledger.identity)
      || !isDeepStrictEqual(candidates.produces, ledger.produces))) throw new Error('Assignment output candidate binding conflict')
  const selected = {}
  for (const output of ledger.produces) {
    let saved = published && Object.hasOwn(published.outputs, output) ? published.outputs[output] : undefined
    if (!saved) {
      if (!assignment.dispatch.command.tools?.includes('kode_publish_output')) return null
      const choices = candidates?.outputs[output]
      if (!Array.isArray(choices) || choices.length !== 1) return null
      // Only durable trusted-tool intent can fill an omitted publication. No
      // observation guessing, model inference or external tool replay occurs.
      runtime.tools.assertSettled(assignment.worker.session_id, ledger.identity.operation)
      const candidate = Object.values(binding.artifactOutbox ?? {}).find(row => row.evidence.id === choices[0]
        && isDeepStrictEqual(row.operation, ledger.identity.operation))
      if (!candidate?.home_reconciled || (candidate.evidence.payload.kind === 'artifact' && !candidate.home_archive_reconciled)) return null
      if (candidate.evidence.payload.kind === 'verification' && !Object.values(binding.verificationRecords ?? {}).some(record =>
        isDeepStrictEqual(record.operation, ledger.identity.operation) && record.evidence_id === choices[0]
        && record.home_reconciled && record.sequence === candidate.home_sequence)) return null
      saved = { evidence_id: choices[0], sequence: candidate.home_sequence }
    }
    const row = observation(binding, ledger.identity.operation, saved.evidence_id)
    if (row.home_sequence !== saved.sequence) throw new Error('Named output sequence changed')
    Object.defineProperty(selected, output, { value: saved.sequence, enumerable: true })
  }
  return selected
}
