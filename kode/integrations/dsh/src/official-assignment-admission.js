import { assignmentHomeCall } from './assignment-home.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { resourceNames } from './exclusive-resources.js'
import { taskStartingSnapshot } from './task-workspace-snapshot.js'
import { taskWorkspaceIdentity } from './assignment-task-workspace.js'
const initialPolicyEvents=new Set(['permission/preset','sandbox/mode','approval/policy'])
export function freshAssignmentContext(agent,fresh){
  const events=typeof agent.session.snapshotEvents==='function'?agent.session.snapshotEvents():null
  const reject=()=>{throw Object.assign(Error('Derived Assignment requires a fresh empty official context'),{contextDiagnostic:{fresh,seeded:agent.session.header.isSeeded===true,event_types:events?.slice(0,8).map(event=>event.type)??null}})}
  if(!fresh||agent.session.header.id!==agent.id||agent.session.header.isSeeded||!events)reject()
  if(!events.length)return {kind:'official_fresh_empty',session_id:agent.id,event_count:0}
  const types=events.map(event=>event.type)
  if(types.length>3||new Set(types).size!==types.length||types.some(type=>!initialPolicyEvents.has(type)))reject()
  return {kind:'official_fresh_policy_metadata',session_id:agent.id,event_count:events.length,policy_metadata:{event_types:types,event_hash:createHash('sha256').update(JSON.stringify(events)).digest('hex')}}
}
/** Trusted Host effect boundary. Agents cannot supply their own readiness assertions. */
export async function admitOfficialAssignment(runtime, agent, binding, operation, tools, configuration, grant, signal, freshContext = false) {
  const id = binding.managedAssignment?.id
  if (!id) return null
  if (!runtime.host) throw new Error('Assignment execution Host identity required')
  if (!configuration || !runtime.workspaceLocks) throw new Error('Official assignment configuration and workspace locks required')
  const scope = { id, host: runtime.host, worker: agent.id, operation }
  const assignment = await assignmentHomeCall(runtime.client, scope, 'context', undefined, signal)
  if (assignment.id !== id || assignment.worker.node_id !== runtime.host || assignment.worker.session_id !== agent.id
      || assignment.bundle.operation.id !== operation.id || assignment.bundle.operation.attempt !== operation.attempt
      || assignment.bundle.operation.epoch !== operation.epoch || assignment.state !== 'prepared') throw new Error('Official assignment identity changed')
  let context, checkContext = () => {}
  if (assignment.execution_workspace) {
    const initial=freshAssignmentContext(agent,freshContext)
    const checkEmpty = () => {
      if(!isDeepStrictEqual(freshAssignmentContext(agent,freshContext),initial))throw Error('Derived Assignment initial policy context changed')
    }
    checkContext = checkEmpty
    checkEmpty()
    const sessions = runtime.ctx.get?.('sessions') ?? runtime.ctx.sessions
    if (typeof sessions?.flush !== 'function' || await sessions.flush(agent.session) !== true) throw new Error('Fresh Assignment context persistence unavailable')
    checkEmpty()
    const derived = assignment.execution_workspace.receipt
    context = { ...initial, input_hash: assignment.inputs.hash,
      ...(derived.kind === 'derived_task_worktree' ? { task_workspace_key: derived.key, task_start_snapshot_hash: derived.starting_snapshot?.snapshot_hash } : { snapshot_hash: derived.snapshot_hash }) }
  }
  const root = await grant.check()
  if (typeof root !== 'string') throw new Error('Official assignment requires a canonical granted workspace')
  const exclusive=resourceNames(assignment.resources?.exclusive_resources??[])
  if(exclusive.length&&assignment.resources.exclusive_resource_scope!=='home')throw Error('Home exclusive resource authority unavailable')
  const lock = await runtime.workspaceLocks.acquire(root, operation.id, { signal })
  let resourceLease
  try {
    if(exclusive.length){
      if(!runtime.exclusiveResources)throw Error('Exclusive resource kernel ownership unavailable')
      resourceLease=await runtime.exclusiveResources.acquire(exclusive,operation.id,{signal})
      runtime.exclusiveResources.assertHeld(resourceLease,exclusive,operation.id)
    }
    signal.throwIfAborted()
    checkContext()
    if (assignment.execution_workspace?.receipt.kind === 'derived_task_worktree') {
      const derived = assignment.execution_workspace.receipt
      const run = operation.home_node && operation.home_node !== runtime.host
        ? await assignmentHomeCall(runtime.client, scope, 'run_context', undefined, signal)
        : await runtime.client.call(`/api/v1/messaging/work-runs/${encodeURIComponent(assignment.run_id)}`, undefined, signal)
      const repository = run.context.binding.project.config.spec.repositories[derived.repository_binding]
      const start = await taskStartingSnapshot(runtime, assignment, repository, taskWorkspaceIdentity(derived), signal)
      if (!isDeepStrictEqual(start, derived.starting_snapshot)) throw Error('Task starting content changed before admission')
    }
    const request = { request_id: id, expected_revision: assignment.admission?.request.expected_revision ?? assignment.revision,
      worker_session: agent.id, profile_revision: configuration.profile_revision, provider: configuration.provider,
      model: configuration.model, effort: configuration.reasoning_effort, tools: [...tools].sort(), root, ...(context ? { context } : {}),...(exclusive.length?{exclusive_resources:exclusive,exclusive_resource_scope:'home'}:{}) }
    const receipt = await assignmentHomeCall(runtime.client, scope, 'admission', request, signal)
    checkContext()
    signal.throwIfAborted()
    if (receipt.assignment_id !== id || receipt.operation_id !== operation.id || receipt.worker?.session_id !== agent.id
        || receipt.worker?.node_id !== runtime.host || receipt.state !== 'ready') throw new Error('Official assignment admission receipt mismatch')
    if(!resourceLease)return lock
    const assertExclusiveResources=()=>runtime.exclusiveResources.assertHeld(resourceLease,exclusive,operation.id)
    assertExclusiveResources()
    let releasing
    return Object.freeze({...lock,exclusive_resources:Object.freeze(exclusive),assertExclusiveResources,
      release:()=>releasing??=(async()=>{runtime.verificationRunners?.assertStopped(operation);await resourceLease.release();await lock.release()})()})
  } catch (error) {
    const released=await Promise.allSettled([resourceLease?.release(),lock.release()])
    const failures=released.filter(row=>row.status==='rejected').map(row=>row.reason)
    if(failures.length)throw new AggregateError([error,...failures],'Assignment admission cleanup failed')
    throw error
  }
}
