export const managedSessionReason = '受管会话，只读排障。请在 IM 工作过程中暂停并接管或恢复任务。'
export function createManagedSessionNavigation({ blocks, workspace, sessions, selectMode }) {
  const owned = new Map()
  let closed = false
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
  return {
    read, block, clear,
    get closed() { return closed },
    close() { closed = true; for (const id of [...owned.keys()]) clear(id) },
    async open(run, item) {
      if (closed) throw Error('Session view disposed')
      const value = await read(item.worker.session_id)
      if (closed || !value.read_only || value.host !== item.worker.node_id || value.home_hub !== run.home_hub
        || value.managed?.assignment_id !== item.assignment_id || value.managed.operation_id !== item.operation.id) throw Error('Worker Session belongs to another Host or scope')
      await sessions.refresh()
      if (closed) throw Error('Session view disposed')
      block(item.worker.session_id, managedSessionReason)
      workspace.openSession(item.worker.session_id)
      selectMode('session')
    },
  }
}
