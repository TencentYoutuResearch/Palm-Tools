import { validProcessTarget } from './process-target.js'
import { sameWorkspace } from './workspace-scope.js'
export const managedSessionReason = '受管会话，只读排障。请在 IM 工作过程中暂停并接管或恢复任务。'
export function createManagedSessionNavigation({ blocks, workspace, sessions, selectMode, returnProcess }) {
  const owned = new Map()
  const listeners = new Set()
  let closed = false, generation = 0, pendingOpen = null, returnLink = null
  const setReturn = value => { returnLink = value; for (const listener of listeners) listener() }
  const invalidate = () => { generation++; pendingOpen?.abort(); pendingOpen = null; if (returnLink) setReturn(null) }
  const block = (id, text) => {
    const current = blocks.storeFor(id).getSnapshot(), previous = owned.get(id)
    if (current !== undefined && current !== previous) return
    if (current?.reason === text) return
    const value = { reason: text }; owned.set(id, value); blocks.set(id, value)
  }
  const clear = id => {
    const previous = owned.get(id)
    if (previous && blocks.storeFor(id).getSnapshot() === previous) blocks.set(id, undefined)
    owned.delete(id)
  }
  const read = async (id, signal) => {
    const response = await fetch('/api/kode/managed-session?' + new URLSearchParams({ session_id: id }), {
      method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    })
    if (!response.ok) throw Error('Session ownership unavailable')
    const value = await response.json()
    if (value.session_id !== id || value.scope !== 'host_managed_session_binding' || typeof value.host !== 'string'
      || typeof value.home_hub !== 'string' || typeof value.read_only !== 'boolean'
      || value.read_only !== (value.managed !== null)) throw Error('Session ownership scope changed')
    return value
  }
  const matches = (value, run, item) => value.read_only && value.host === item.worker.node_id && value.home_hub === run.home_hub
    && value.managed?.assignment_id === item.assignment_id && value.managed.operation_id === item.operation.id
  return {
    read, block, clear, invalidate,
    getSnapshot: () => returnLink,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    get closed() { return closed },
    close() { closed = true; invalidate(); for (const id of [...owned.keys()]) clear(id) },
    async returnToProcess(sessionId) {
      const link = returnLink
      if (closed || !link || link.sessionId !== sessionId || !returnProcess?.current(link.target)) return false
      invalidate()
      const ticket = generation, controller = new AbortController(); pendingOpen = controller
      const current = () => !closed && ticket === generation && !controller.signal.aborted && returnProcess.current(link.target)
      try {
        const value = await read(sessionId, controller.signal)
        if (!current()) return false
        if (!matches(value, link.run, link.item)) throw Error('Session ownership changed')
        const target = await returnProcess.read(link.target, controller.signal) ?? link.target
        if (!current()) return false
        if (!validProcessTarget(target) || target.runId !== link.target.runId || target.teamId !== link.target.teamId
          || !sameWorkspace(target.scope, link.target.scope) || (link.target.taskId !== undefined
            && (target.taskId !== link.target.taskId || target.contextId !== link.target.contextId))) throw Error('Process return identity changed')
        returnProcess.open(target)
        return true
      } catch (error) { if (!current()) return false; throw error }
      finally { if (pendingOpen === controller) pendingOpen = null }
    },
    // `present` shows the verified, read-only Session elsewhere (Orbit's right-Sidebar tab) instead of session mode.
    async open(run, item, target = null, { present } = {}) {
      if (closed) throw Error('Session view disposed')
      invalidate()
      const ticket = generation, controller = new AbortController(); pendingOpen = controller
      const current = () => {
        if (closed) throw Error('Session view disposed')
        return ticket === generation && !controller.signal.aborted
      }
      try {
        const value = await read(item.worker.session_id, controller.signal)
        if (!current()) return false
        if (!matches(value, run, item)) throw Error('Worker Session belongs to another Host or scope')
        await sessions.refresh()
        if (!current()) return false
        block(item.worker.session_id, managedSessionReason)
        if (present) present(item.worker.session_id)
        else { workspace.openSession(item.worker.session_id); selectMode('session') }
        // The synchronous native transition invalidates the previous navigation.
        // Publish only after it finishes, and keep no run contents or grant state.
        // A presented tab never leaves Orbit, so there is no process to return to.
        if (!present && target?.runId === run.id && target.teamId === run.team_id && target.scope?.home_hub === run.home_hub
          && target.scope.host_id === item.worker.node_id && returnProcess?.current(target) && !closed) {
          setReturn({ sessionId: item.worker.session_id, target: structuredClone(target),
            run: { home_hub: run.home_hub }, item: { assignment_id: item.assignment_id, worker: { ...item.worker }, operation: { id: item.operation.id } } })
        }
        return true
      } catch (error) {
        if (!current()) return false
        throw error
      } finally { if (pendingOpen === controller) pendingOpen = null }
    },
  }
}
