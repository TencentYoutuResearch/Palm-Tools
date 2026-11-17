/** Read-only navigation identity. No run creation, execution preview or authorization. */
import { sameWorkspace, teamInWorkspace, validWorkspaceScope } from './workspace-scope.js'
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
export const validProcessTarget = target => validWorkspaceScope(target?.scope) && [target.runId, target.teamId].every(id)
  && ((target.taskId === undefined && target.contextId === undefined) || [target.taskId, target.contextId].every(id))
/** An existing local run link, not a cached run or authorization. */
export function sessionProcessTarget(scope, run, team, task) {
  if (!teamInWorkspace(team, scope) || scope.host_id !== scope.home_hub || run?.home_hub !== scope.home_hub
    || run.team_id !== team.id || !id(run.id)) throw Error('会话工作过程归属不匹配。')
  if (task) {
    const target = discussionProcessTarget(scope, task, team)
    if (target.runId !== run.id) throw Error('会话与讨论任务不匹配。')
    return target
  }
  if (run.collaboration) return discussionProcessTarget(scope, { id: run.collaboration.task_id, context_id: run.collaboration.context_id,
    work_run_id: run.id, team_id: run.team_id, scope: run.collaboration.scope }, team)
  return { scope: { home_hub: scope.home_hub, host_id: scope.host_id, workspace_id: scope.workspace_id, root_ref: scope.root_ref }, runId: run.id, teamId: team.id }
}
export function discussionProcessTarget(scope, task, team) {
  if (!sameWorkspace(task?.scope, scope) || !teamInWorkspace(team, scope) || team.id !== task.team_id
    || ![task.id, task.context_id, task.work_run_id].every(id)) throw Error('任务与工作过程归属不匹配，请刷新原讨论串。')
  return { scope: { home_hub: scope.home_hub, host_id: scope.host_id, workspace_id: scope.workspace_id, root_ref: scope.root_ref },
    taskId: task.id, contextId: task.context_id, runId: task.work_run_id, teamId: team.id }
}
export function validateProcessTargetRun(run, target) {
  if (!target) return run
  const source = run?.collaboration
  const repositories = run?.context?.binding?.project?.config?.spec?.repositories
  const scopeMatches = target.taskId !== undefined
    ? source?.task_id === target.taskId && source.context_id === target.contextId && sameWorkspace(source.scope, target.scope)
    : Object.values(repositories ?? {}).some(repository => sameWorkspace({ ...repository?.workspace, home_hub: run?.home_hub }, target.scope))
  if (!validProcessTarget(target) || run?.id !== target.runId || run.team_id !== target.teamId || run.home_hub !== target.scope.home_hub || !scopeMatches) {
    throw Error('工作过程与原讨论任务不匹配。')
  }
  return run
}
/** Re-enter the original task audience guard before reading a discussion's run. */
export async function readProcessReturn(target, request, signal) {
  const readTask = async current => {
    const task = await request('/api/kode/collaboration?' + new URLSearchParams({ path: 'tasks/' + current.taskId }), { signal })
    if (task?.id !== current.taskId || task.context_id !== current.contextId || task.work_run_id !== current.runId
      || task.team_id !== current.teamId || !sameWorkspace(task.scope, current.scope)) throw Error('任务读取归属已改变。')
  }
  if (target.taskId) await readTask(target)
  signal?.throwIfAborted()
  const run = validateProcessTargetRun(await request('/api/kode/work-run?run_id=' + encodeURIComponent(target.runId), { signal }), target)
  // Owner Worker rows carry only run identity. If that run belongs to a discussion,
  // retain its full task identity and apply the same audience guard before opening.
  if (!target.taskId && run.collaboration) {
    target = { ...target, taskId: run.collaboration.task_id, contextId: run.collaboration.context_id }
    validateProcessTargetRun(run, target)
    await readTask(target)
  }
  return target
}
