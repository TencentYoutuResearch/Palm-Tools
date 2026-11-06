/** Default trusted preparation only admits built-in tools and already-registered frozen runners. */
import { verificationReadiness } from './verification-readiness.js'
import { readAssignmentRun } from './assignment-home.js'
import { assignmentToolNames } from './assignment-tools.js'
export async function prepareWorkRunAssignment(runtime, assignment, { signal } = {}) {
  if (!assignment.dispatch.command.tools.every(name => assignmentToolNames.includes(name))) return null
  const run = await readAssignmentRun(runtime, { id: assignment.worker.session_id }, { managedAssignment: { id: assignment.id }, managedOperation: assignment.dispatch.command.operation }, assignment, signal)
  const pack = run.context.binding.workflow.pack, stage = pack.stages.find(s => s.id === assignment.stage_id)
  for (const output of stage.produces) {
    const rule = pack.evidence_rules[output]
    if (rule?.kind !== 'verification') continue
    if (verificationReadiness(runtime, run.context.binding.project.config.spec, stage, rule) !== 'registered') return null
  }
  return {}
}
