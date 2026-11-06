/** Trusted Host routing; remote Assignment authority never falls back to the execution Hub. */
const prefix = '/api/v1/messaging/'
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value)
export async function assignmentHomeCall(client, scope, action, payload, signal) {
  const { id, host, worker, operation } = scope
  if (![id, host, worker, operation?.id].every(validId) || !Number.isSafeInteger(operation?.attempt) || operation.attempt < 1
      || !['context', 'admission', 'creation', 'stop', 'run_context', 'outputs', 'workspace_receipt', 'task_workspace', 'task_workspace_prepare', 'clarification', 'clarification_read'].includes(action)) throw new Error('Invalid Assignment home scope')
  const home = operation.home_node ?? host
  if (!validId(home)) throw new Error('Invalid Assignment home identity')
  const path = `${prefix}work-assignments/${encodeURIComponent(id)}`
  if (home === host && ['run_context', 'outputs', 'workspace_receipt'].includes(action)) throw new Error('Use the bound WorkRun local reader')
  if (action === 'clarification_read' && !validId(payload?.request_id)) throw new Error('Invalid clarification identity')
  let value
  if (home === host) {
    const routes = {
      context: path,
      admission: `${path}/admit`,
      creation: `${path}/creation`,
      stop: `${path}/stop-receipt`,
      task_workspace: `${path}/task-workspace`,
      task_workspace_prepare: `${path}/task-workspace/prepare`,
      clarification: `${path}/clarifications`,
      clarification_read: `${path}/clarifications/${encodeURIComponent(payload?.request_id)}`,
    }
    const body = action === 'clarification_read' ? undefined : payload
    value = await client.call(routes[action], body, signal)
  } else {
    const fields = {
      outputs: { declaration: payload },
      admission: { admission: payload },
      creation: { receipt: payload },
      stop: { receipt: payload },
      workspace_receipt: { receipt: payload },
      task_workspace: { receipt: payload },
      task_workspace_prepare: { receipt: payload },
      clarification: { observation: payload },
      clarification_read: { request_id: payload?.request_id },
    }
    value = await client.call(`${prefix}operation-accounting-relay/${encodeURIComponent(home)}`, {
      operation_id: operation.id, worker_session: worker, command: null,
      accounting: { attempt: operation.attempt, action: { kind: `assignment_${action}`, assignment_id: id, ...fields[action] } },
    }, signal)
  }
  if (action === 'context' && (value?.id !== id || value.worker?.node_id !== host || value.worker?.session_id !== worker
      || value.bundle?.operation?.id !== operation.id || value.bundle?.operation?.attempt !== operation.attempt)) {
    throw new Error('Assignment home context identity mismatch')
  }
  return value
}

function boundScope(runtime, agent, binding) {
  return { id: binding.managedAssignment?.id, host: runtime.host, worker: agent.id, operation: binding.managedOperation }
}
export async function readAssignmentContext(runtime, agent, binding, signal) {
  const scope = boundScope(runtime, agent, binding)
  return scope.operation?.home_node && scope.operation.home_node !== scope.host
    ? assignmentHomeCall(runtime.client, scope, 'context', undefined, signal)
    : runtime.client.call(`${prefix}work-assignments/${encodeURIComponent(scope.id)}`, undefined, signal)
}
export async function readAssignmentRun(runtime, agent, binding, assignment, signal) {
  const scope = boundScope(runtime, agent, binding)
  if (!scope.operation?.home_node || scope.operation.home_node === scope.host) {
    return runtime.client.call(`${prefix}work-runs/${encodeURIComponent(assignment.run_id)}`, undefined, signal)
  }
  const run = await assignmentHomeCall(runtime.client, scope, 'run_context', undefined, signal)
  if (run?.id !== assignment.run_id || run.context_hash !== assignment.context_hash
      || run.authorization?.snapshot_hash !== assignment.authorization_hash) throw new Error('Assignment home WorkRun identity mismatch')
  return run
}
