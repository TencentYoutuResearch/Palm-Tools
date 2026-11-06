import { readAssignmentContext, readAssignmentRun } from './assignment-home.js'
/** Resolve and execute only a frozen Verification output through the trusted Host runner registry. */
import { isDeepStrictEqual } from 'node:util'
import { recordAssignmentOutputCandidate } from './assignment-outputs.js'
export async function executeAssignmentVerification(runtime, agent, binding, lock, request, signal, authorize) {
  if (!request || Object.keys(request).sort().join(',') !== 'output,request_id'
      || !Object.values(request).every(v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(v))) throw new Error('Invalid Assignment verification request')
  const id = binding.managedAssignment?.id
  if (!id || !runtime.verificationRunners) throw new Error('Managed verification Assignment required')
  const assignment = await readAssignmentContext(runtime, agent, binding, signal)
  const derived = assignment.execution_workspace?.receipt
  if (assignment.id !== id || assignment.state !== 'prepared' || assignment.worker.session_id !== agent.id || assignment.worker.node_id !== runtime.host
      || !isDeepStrictEqual(assignment.dispatch.command.operation,binding.managedOperation) || !derived || !lock || lock.root !== derived.scope.target.root) throw new Error('Verification Assignment ownership mismatch')
  const run = await readAssignmentRun(runtime, agent, binding, assignment, signal)
  const pack = run.context.binding.workflow.pack, stage = pack.stages.find(s => s.id === assignment.stage_id)
  const state = run.stages.find(s => s.stage_id === assignment.stage_id), rule = pack.evidence_rules[request.output]
  if (!stage?.produces.includes(request.output) || rule?.kind !== 'verification' || state?.assignment_id !== id
      || state.attempt !== assignment.stage_attempt || state.evidence || run.context_hash !== assignment.context_hash) throw new Error('Frozen verification stage unavailable')
  const project = run.context.binding.project.config.spec, command = project.commands[rule.command_binding], environment = project.environments[rule.environment_binding]
  if (!command || !environment || command.environment_binding !== rule.environment_binding || command.repository_binding !== stage.execution.repository_binding
      || environment.host_id !== runtime.host || environment.adapter_id !== 'local_process_v1') throw new Error('Verification command or environment binding mismatch')
  const sources = Object.values(assignment.inputs.binding.sources).flatMap(s => Object.entries(s.outputs).filter(([name]) => name === rule.artifact_output).map(([,value])=>value))
  if (sources.length !== 1 || !sources[0].artifact || sources[0].artifact.snapshot_hash !== derived.snapshot_hash
      || sources[0].sequence !== assignment.input_workspace.receipt.sequence) throw new Error('Verification source binding mismatch')
  const reference = runtime.verificationRunners.reference(command.runner_id,command.id,command.revision)
  if (!derived.scope.tools.includes(reference.tool_id) || !stage.execution.tools.includes(reference.tool_id)
      || reference.definition_hash !== command.definition_hash || reference.environment_hash !== environment.configuration_hash
      || !isDeepStrictEqual(reference.exclusive_resources??[],command.exclusive_resources??[])
      || (reference.exclusive_resources?.length&&(!lock.assertExclusiveResources||reference.exclusive_resources.some(name=>!lock.exclusive_resources.includes(name))))
      || !isDeepStrictEqual(reference.scenario_ids,[...command.scenario_ids].sort())
      || rule.required_scenarios.some(id => !reference.scenario_ids.includes(id))
      || reference.capabilities.some(c => !derived.scope.capabilities.includes(c)) || (reference.network && !derived.scope.network)) throw new Error('Trusted verification definition exceeds frozen scope')
  lock.assertExclusiveResources?.()
  const operation = assignment.dispatch.command.operation, callId = `verify-${request.request_id}`
  const executionRequest={request_id:callId,command:reference,cwd:lock.root,operation,
    source_sequence:sources[0].sequence,snapshot_hash:derived.snapshot_hash}
  await runtime.tools.begin(agent.id,operation,{ callId, name: reference.tool_id,arguments:executionRequest })
  let observed
  try {
    const result = await runtime.verificationRunners.execute(executionRequest, { signal, authorize: async () => { await authorize(); return true } })
    observed=result
    await authorize()
    if (result.observed.reason === 'stop_unconfirmed' || result.observed.signal_failures.length) throw new Error('Verification process stop requires reconciliation')
    const observation = await runtime.artifacts.record(agent.id,operation,callId,{ kind:'verification', artifact_sequence: result.source_sequence,
      snapshot_hash: result.snapshot_hash, verdict: result.observed.passed ? 'passed' : result.observed.exit_code === null ? 'inconclusive' : 'failed',
      environment_hash: reference.environment_hash, command_id: command.id, command_revision: command.revision,
      scenario_ids: reference.scenario_ids, exit_code: result.observed.exit_code, log_ref: result.log_ref })
    const archive = await runtime.verificationArchive.record(agent.id,operation,result)
    await recordAssignmentOutputCandidate(runtime, assignment, stage.produces, request.output, observation.evidence.id)
    await runtime.tools.end(agent.id,callId,'returned','verification_process_observed',result)
    return { result, observation, log_archive_status:archive.home_reconciled ? 'home_archived' : 'pending_home', completion_authorized:false }
  } catch (error) {
    await runtime.tools.end(agent.id,callId,'uncertain','verification_execution_or_recording_failed',...(observed===undefined?[]:[observed])).catch(()=>{})
    throw error
  }
}
