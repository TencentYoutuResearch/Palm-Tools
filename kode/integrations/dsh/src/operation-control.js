/** Explicit owner opt-in for the partial native lease adapter. No work is started here. */
export function registerOperationControl(ctx) {
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/session-operation', handler: async (req, res) => {
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission || admission.peer.principal.kind !== 'owner') return json(res, 403, { error: 'Host owner required' })
    if (req.method !== 'POST' || !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 405, { error: 'JSON POST required' })
    try {
      let text = ''
      for await (const part of req) { text += part; if (Buffer.byteLength(text) > 8192) throw new Error('Request too large') }
      const input = JSON.parse(text)
      if (typeof input.session_id !== 'string' || typeof input.operation_id !== 'string' || !Number.isSafeInteger(input.expected_revision)) throw new Error('Session, operation and expected revision required')
      const agent = ctx.agents.get(input.session_id), service = ctx.get('kodeAgents'), backend = ctx.get('kodeBackend')
      if (!agent?.isKodeNativeAgent || agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || service.adapter.busy.has(agent.id)) throw new Error('An idle loaded native session with an empty inbox is required')
      const prior = service.profiles.binding(agent.id)
      if (!prior || prior.stopBlocked || (prior.managedOperation && !prior.operationClosed)) throw new Error('Session has an unresolved execution binding')
      const operation = await agent.runMaintenance(async () => {
      const node = await backend.call('/api/v1/messaging/node')
      if (input.home_node !== undefined && (typeof input.home_node !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.home_node))) throw new Error('Invalid home Hub identity')
      const remote = input.home_node && input.home_node !== node.node_id
      const operation = remote
        ? await backend.call(`/api/v1/messaging/operation-relay/${encodeURIComponent(input.home_node)}`, { operation_id: input.operation_id, worker_session: String(agent.id), command: null })
        : await backend.call(`/api/v1/messaging/operations/${encodeURIComponent(input.operation_id)}`)
      if (operation.state !== 'prepared' || operation.revision !== input.expected_revision || operation.worker.node_id !== node.node_id || operation.worker.session_id !== String(agent.id)) throw new Error('Operation identity or revision changed')
      if (operation.resource_required && (operation.resource?.profile !== prior.profile?.id || operation.resource?.host !== node.node_id)) throw new Error('Operation resource does not match session profile')
      // Check again after I/O; never switch an active or newly queued session.
      if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length || service.adapter.busy.has(agent.id)) throw new Error('Session became busy')
      await service.profiles.update(state => {
        const binding = state.bindings[agent.id]
        if (!binding || binding.stopBlocked || (binding.managedOperation && !binding.operationClosed)) throw new Error('Session binding changed')
        binding.managedOperation = { id: operation.id, attempt: operation.attempt, epoch: operation.epoch, budget_required: operation.budget_required === true, ...(remote ? { home_node: input.home_node } : {}) }
        binding.operationClosed = false
        return binding.managedOperation
      })
      return operation
      })
      json(res, 200, { attached: true, started: false, operation_id: operation.id, enforcement: 'turn_and_host_tools_only' })
    } catch (error) { json(res, 400, { error: error.message }) }
  } })
}
