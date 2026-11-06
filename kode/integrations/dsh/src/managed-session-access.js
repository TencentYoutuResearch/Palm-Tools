import { symbols } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
export const managedSessionReadOnlyReason = '此会话由协作流程管理。请在 IM 工作过程中暂停并接管或恢复任务。'

export function managedSessionBinding(profiles, sessionId) {
  const binding = profiles.binding(sessionId)
  if (!binding?.managedOperation) return null
  const role = binding.managedAssignment ? 'worker' : binding.managedCoordinator ? 'superagent' : binding.managedBuilder ? 'builder' : 'operation'
  return { role, operation_id: binding.managedOperation.id,
    ...(binding.managedOperation.home_node ? { home_hub: binding.managedOperation.home_node } : {}),
    ...(binding.managedAssignment ? { assignment_id: binding.managedAssignment.id } : {}),
    ...(binding.managedCoordinator ? { team_id: binding.managedCoordinator.team_id } : {}),
    ...(binding.managedBuilder ? { draft_id: binding.managedBuilder.draft_id } : {}) }
}

/** Fence public Session writes before Agent resolution, queue changes or history append. */
export function installManagedSessionCommandGuard(controller, profiles) {
  const target = controller?.[symbols.original] ?? controller
  if (typeof target?.prompt !== 'function' || typeof target?.promote !== 'function') throw Error('Session guard requires command and cold-history promotion entries')
  const disposers = []
  for (const method of ['prompt', 'updateQueue', 'cancel', 'selectModel', 'rename', 'fork', 'promote']) {
    const original = target[method]
    if (typeof original !== 'function') continue
    const descriptor = Object.getOwnPropertyDescriptor(target, method)
    const guarded = function (request, ...args) {
      // dsh rc.2 transfers a retained cold observation to background activation
      // after yielding history. Managed diagnostics release that reference here.
      if (method === 'promote' && managedSessionBinding(profiles, request.header.id)) {
        request[Symbol.dispose]()
        return
      }
      if (request?.sessionId && managedSessionBinding(profiles, request.sessionId)) throw new RemoteError('gateway/bad-request', managedSessionReadOnlyReason, {})
      return original.call(this, request, ...args)
    }
    Object.defineProperty(target, method, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: guarded })
    disposers.push(() => {
      if (Object.getOwnPropertyDescriptor(target, method)?.value !== guarded) return
      if (descriptor) Object.defineProperty(target, method, descriptor)
      else delete target[method]
    })
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** dsh rc.2 resolves Agent-scoped UI APIs before calling their business methods. */
export function installManagedSessionGatewayGuard(gateway, profiles) {
  const target = gateway?.[symbols.original] ?? gateway
  const disposers = []
  for (const method of ['resolveReceiverContext', 'resolveParameter']) {
    if (typeof target?.[method] !== 'function') throw Error('Managed Session access requires Gateway resolution fences')
  }
  for (const method of ['resolveReceiverContext', 'resolveParameter']) {
    const original = target[method], descriptor = Object.getOwnPropertyDescriptor(target, method)
    const guarded = function (definition, args, ...rest) {
      const scope = method === 'resolveReceiverContext' ? definition.invocation : definition
      const key = method === 'resolveReceiverContext' ? scope.context : scope.source === 'lookup' ? scope.lookup : undefined
      const id = args[scope.wire]
      if (['agent', 'session'].includes(key) && typeof id === 'string' && managedSessionBinding(profiles, id)) {
        throw new RemoteError('gateway/bad-request', managedSessionReadOnlyReason, {})
      }
      return original.call(this, definition, args, ...rest)
    }
    Object.defineProperty(target, method, { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: guarded })
    disposers.push(() => {
      if (Object.getOwnPropertyDescriptor(target, method)?.value !== guarded) return
      if (descriptor) Object.defineProperty(target, method, descriptor)
      else delete target[method]
    })
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

/** Minimal local ownership metadata. Reads never resolve an Agent or discover models. */
export function registerManagedSessionAccess(ctx, service, host) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/managed-session', handler: async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    const admitted = ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection, { error: 'authentication required' })
    if (admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const query = new URL(req.url, 'http://localhost').searchParams, id = query.get('session_id')
    if ([...query.keys()].length !== 1 || query.getAll('session_id').length !== 1 || !valid(id)) return send(400, { error: 'Exact Session identity required' })
    try {
      const managed = managedSessionBinding(service.profiles, id)
      return send(200, { session_id: id, host, home_hub: managed?.home_hub ?? host,
        read_only: managed !== null, managed, scope: 'host_managed_session_binding' })
    } catch { return send(503, { error: 'Session ownership unavailable' }) }
  } })
}
