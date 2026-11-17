/** The existing Home Assignment/WorkRun owns the role, never a profile or message.
 * Reading the frozen run avoids silently adopting a newer editable Team revision.
 */
import { isDeepStrictEqual } from 'node:util'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { readAssignmentContext, readAssignmentRun } from './assignment-home.js'
import { snapshotTeamRolePrompt, validateRolePromptSnapshot, rolePromptInstructions } from './team-role-prompts.js'
export const ASSIGNMENT_ROLE_PROMPT_RECORD = 'plugin:kode/assignment-role-prompt'
const pendingPublication = new WeakMap()
const fail = text => Object.assign(Error(text), { code: 'ROLE_PROMPT_SCOPE_REJECTED' })
export async function readAssignmentRolePrompt(runtime, agent, binding, signal, knownAssignment) {
  const op = binding?.managedOperation, id = binding?.managedAssignment?.id
  if (!runtime?.client || !runtime.host || !op || !id || binding.operationClosed || binding.managedBuilder || binding.managedCoordinator) throw fail('Exact Assignment runtime required')
  const assignment = knownAssignment ?? await readAssignmentContext(runtime, agent, binding, signal)
  if (assignment.id !== id || assignment.state !== 'prepared' || assignment.worker?.node_id !== runtime.host || assignment.worker?.session_id !== agent.id
    || assignment.bundle?.operation?.id !== op.id || assignment.bundle.operation.attempt !== op.attempt || assignment.bundle.operation.epoch !== op.epoch) throw fail('Assignment operation or Worker changed')
  const run = await readAssignmentRun(runtime, agent, binding, assignment, signal), team = run?.context?.team
  if (run.id !== assignment.run_id || run.context_hash !== assignment.context_hash || run.authorization?.snapshot_hash !== assignment.authorization_hash
    || run.home_hub !== (op.home_node ?? runtime.host) || !team || team.home_hub !== run.home_hub || team.id !== assignment.team_id || team.id !== run.team_id
    || team.revision !== run.team_revision || !Number.isSafeInteger(team.revision) || team.revision < 1) throw fail('Frozen Assignment Team scope mismatch')
  const workerId = assignment.candidate?.worker_id
  if (workerId !== null && typeof workerId !== 'string') throw fail('Selected Assignment role is unavailable')
  const snapshot = snapshotTeamRolePrompt({ home_hub: team.home_hub, team_id: team.id, team_revision: team.revision, spec: team.spec, ...(workerId === null ? {} : { worker_id: workerId }) })
  signal?.throwIfAborted(); return snapshot
}
export async function mountAssignmentRolePrompt(ctx, agent, runtime, { prepublication = false } = {}) {
  const binding = runtime.profiles.binding(agent.id), snapshot = await readAssignmentRolePrompt(runtime, agent, binding)
  const events = Session.prototype.snapshotEvents.call(agent.session), records = events.filter(event => event.type === ASSIGNMENT_ROLE_PROMPT_RECORD)
  if (records.length > 1 || records.length === 1 && !isDeepStrictEqual(records[0].data, { version: 1, session_id: agent.id, snapshot })) throw fail('Persisted Assignment role prompt changed')
  if (!records.length && snapshot !== null) {
    if (events.some(event => /^(user|assistant|turn|request)\//.test(event.type))) throw fail('Existing Assignment cannot adopt a new role prompt')
    // Derived Assignment admission must still observe the real fresh context.
    // Stage the trusted snapshot in memory until execution.open succeeds; write
    // it through the original live SessionStore before registry publication.
    if (!prepublication) {
      appendPluginRecord(agent.session, ASSIGNMENT_ROLE_PROMPT_RECORD, { version: 1, session_id: agent.id, snapshot })
      if (await ctx.sessions.flush(agent.session) !== true) throw fail('Assignment role prompt persistence unavailable')
    }
  }
  if (prepublication) pendingPublication.set(agent.session, { snapshot })
  if (snapshot === null) return () => { pendingPublication.delete(agent.session) }
  const prompt = ctx.get('systemPrompt')
  if (typeof prompt?.section !== 'function') throw fail('Assignment prompt service unavailable')
  const dispose = prompt.section({ name: 'kode.assignment.owner-role', order: 81, text: rolePromptInstructions(snapshot), interpolate: false })
  return () => { pendingPublication.delete(agent.session); dispose() }
}
export async function assertAssignmentRolePromptDurable(agent, runtime) {
  const snapshot = await readAssignmentRolePrompt(runtime, agent, runtime.profiles.binding(agent.id))
  const pending = pendingPublication.get(agent.session)
  if (!pending || !isDeepStrictEqual(pending.snapshot, snapshot)) throw fail('Assignment role changed before publication')
  let records = Session.prototype.snapshotEvents.call(agent.session).filter(event => event.type === ASSIGNMENT_ROLE_PROMPT_RECORD)
  if (snapshot === null && records.length === 0) return
  if (records.length === 0 && snapshot !== null) {
    if (Session.prototype.snapshotEvents.call(agent.session).some(event => /^(user|assistant|turn|request)\//.test(event.type))) throw fail('Assignment received input before role publication')
    appendPluginRecord(agent.session, ASSIGNMENT_ROLE_PROMPT_RECORD, { version: 1, session_id: agent.id, snapshot })
    records = Session.prototype.snapshotEvents.call(agent.session).filter(event => event.type === ASSIGNMENT_ROLE_PROMPT_RECORD)
  }
  if (records.length !== 1 || !isDeepStrictEqual(records[0].data, { version: 1, session_id: agent.id, snapshot })) throw fail('Published Assignment role prompt changed')
  if (await agent.ctx.sessions.flush(agent.session) !== true) throw fail('Assignment role prompt persistence unavailable')
  if (!isDeepStrictEqual(await readAssignmentRolePrompt(runtime, agent, runtime.profiles.binding(agent.id)), snapshot)) throw fail('Assignment role changed during publication')
}
export async function assertAssignmentRolePrompt(runtime, agent, binding, assignment, mandate, options, signal) {
  const records = Session.prototype.snapshotEvents.call(agent.session).filter(event => event.type === ASSIGNMENT_ROLE_PROMPT_RECORD)
  if (mandate.role_prompt === undefined && records.length === 0) return
  const expected = await readAssignmentRolePrompt(runtime, agent, binding, signal, assignment)
  const incoming = mandate.role_prompt == null ? null : validateRolePromptSnapshot(mandate.role_prompt)
  if (!isDeepStrictEqual(incoming, expected) || records.length !== 1 || !isDeepStrictEqual(records[0].data, { version: 1, session_id: agent.id, snapshot: expected })) throw fail('Mandate role prompt differs from frozen Team and journal')
  const text = rolePromptInstructions(expected)
  const systems = (options.messages ?? []).filter(message => message.role === 'system').flatMap(message => Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }])
  if (!systems.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.includes(text))) throw fail('Prepared system prompt omits the exact assigned role')
}
