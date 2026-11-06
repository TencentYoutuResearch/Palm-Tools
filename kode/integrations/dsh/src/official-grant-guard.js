import { isDeepStrictEqual } from 'node:util'
/** Host policy boundary; no heuristic tool-name-to-capability mapping. */
import { realpath } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'
export class OfficialToolPolicies {
  constructor() { this.entries = new Map(); this.scoped = new WeakMap() }
  register(name, policy, agent) {
    if (agent && (typeof agent !== 'object' && typeof agent !== 'function')) throw new Error('Agent identity required')
    const entries = agent ? (this.scoped.get(agent) ?? new Map()) : this.entries
    if (agent) this.scoped.set(agent, entries)
    if (entries.has(name) || !Array.isArray(policy.capabilities) || typeof policy.network !== 'boolean' || typeof policy.authorize !== 'function') throw new Error('Explicit trusted tool policy required')
    if (policy.validateArguments != null && typeof policy.validateArguments !== 'function') throw new Error('Trusted tool argument validator required')
    if (policy.readOnlyErrors != null && typeof policy.readOnlyErrors !== 'boolean') throw new Error('Trusted tool error policy required')
    if (policy.readOnlyErrors && (policy.network || policy.capabilities.some(cap => cap !== 'read'))) throw new Error('Read-only error policy requires local read capabilities')
    const entry = Object.freeze({ capabilities: Object.freeze([...policy.capabilities]), network: policy.network, workspaceLock: policy.workspaceLock === true, authorize: policy.authorize, implementation: policy.implementation, validateArguments: policy.validateArguments, readOnlyErrors: policy.readOnlyErrors === true })
    entries.set(name, entry)
    return () => { if (entries.get(name) === entry) entries.delete(name) }
  }
  get(name, agent) { return (agent && this.scoped.get(agent)?.get(name)) || this.entries.get(name) }
}
export async function officialGrantGuard(ctx, client, agent, operation, tools, host, validateDerivedWorkspace) {
  const read = () => operation.home_node && operation.home_node !== host
    ? client.call(`/api/v1/messaging/operation-accounting-relay/${encodeURIComponent(operation.home_node)}`, { operation_id: operation.id, worker_session: agent.id, command: null, accounting: { attempt: operation.attempt, action: { kind: 'grant_context' } } })
    : client.call(`/api/v1/messaging/operations/${encodeURIComponent(operation.id)}/grant`)
  const first = await read()
  const checkIdentity = row => {
    if (row.operation_id !== operation.id || row.attempt !== operation.attempt || row.epoch !== operation.epoch || row.worker?.session_id !== agent.id || (host && row.worker?.node_id !== host)) throw new Error('Official grant assignment mismatch')
  }
  checkIdentity(first)
  if (!first.grant_required) return { check: async () => {}, tool: async () => {} }
  if (!host || !first.binding || !first.available) throw new Error('Official grant unavailable')
  const derived = first.execution_workspace
  const authority = first.binding.scope
  if (derived && (!['derived_readonly_snapshot', 'derived_task_worktree'].includes(derived.kind) || derived.scope_authorized !== true
      || derived.operation_id !== operation.id || derived.attempt !== operation.attempt || derived.epoch !== operation.epoch
      || !isDeepStrictEqual(derived.authority_scope, authority)
      || !isDeepStrictEqual({ ...derived.scope, target: authority.target }, authority)
      || (derived.kind === 'derived_readonly_snapshot' && (derived.scope.network || derived.scope.capabilities.some(cap => cap !== 'read')))
      || (derived.kind === 'derived_task_worktree' && (!authority.capabilities.includes('workspace_write') || derived.repository !== authority.target.root))
      || typeof validateDerivedWorkspace !== 'function')) throw new Error('Official derived workspace authority unavailable')
  const scope = derived?.scope ?? authority, frozen = JSON.stringify([first.binding, derived ?? null])
  const policies = ctx.get('kodeOfficialToolPolicies')
  const toolRuntime = () => agent.ctx.get ? agent.ctx.get('tools') : agent.ctx.tools
  const captured = new Map()
  for (const name of tools) {
    const policy = policies?.get(name, agent)
    if (!scope.tools.includes(name) || !policy || policy.capabilities.some(cap => !scope.capabilities.includes(cap)) || (policy.network && !scope.network)) throw new Error('Official tool exceeds grant or lacks a trusted policy')
    if (typeof toolRuntime()?.get !== 'function' || !policy.implementation || toolRuntime()?.get(name, agent) !== policy.implementation) throw new Error('Official tool implementation is not trusted')
    captured.set(name, policy)
  }
  const check = async () => {
    const current = await read(); checkIdentity(current)
    if (!current.grant_required || !current.available || JSON.stringify([current.binding, current.execution_workspace ?? null]) !== frozen) throw new Error('Official grant changed')
    if (scope.target.host !== host) throw new Error('Official grant workspace not registered')
    const root = await realpath(scope.target.root)
    if (derived) {
      if (derived.kind === 'derived_task_worktree') {
        const original = ctx.get('workspaceRegistry')?.list().find(row => row.id === authority.target.workspace)
        if (!original || await realpath(original.path) !== authority.target.root) throw new Error('Official task source registration changed')
      }
      if (root !== scope.target.root || await validateDerivedWorkspace(derived) !== root) throw new Error('Official derived workspace changed')
    } else {
      const workspace = ctx.get('workspaceRegistry')?.list().find(row => row.id === scope.target.workspace)
      if (!workspace) throw new Error('Official grant workspace not registered')
      if (root !== scope.target.root || await realpath(workspace.path) !== root) throw new Error('Official grant workspace root changed')
    }
    const cwd = await realpath(agent.session.header.cwd)
    const inside = relative(root, cwd)
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('Official execution outside grant workspace')
    for (const [name, policy] of captured) {
      if (policies.get(name, agent) !== policy) throw new Error('Official tool policy changed')
      if (typeof toolRuntime()?.get !== 'function' || toolRuntime()?.get(name, agent) !== policy.implementation) throw new Error('Official tool implementation changed')
    }
    return root
  }
  await check()
  return { check, tool: async request => {
    const root = await check(), policy = captured.get(request.name)
    if (!policy) throw new Error('Official tool has no grant policy')
    const accepted = await policy.authorize(request, { root, scope: structuredClone(scope) })
    if (accepted !== true) throw new Error('Official tool arguments exceed grant')
    return { root, workspaceLock: policy.workspaceLock || policy.capabilities.includes('workspace_write') }
  } }
}
