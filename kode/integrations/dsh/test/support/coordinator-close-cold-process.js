/** Fresh process: actual close recovery/Host method, no executor or prior in-memory state.
 * IPC carries backend requests to the isolated fixture Hub; no credentials are sent.
 */
import { CoordinatorCloseRecovery } from '../../src/coordinator-close-recovery.js'
import { closeCoordinator } from '../../src/coordinator-close.js'
const pending = new Map()
let sequence = 0
process.on('message', async message => {
  if (message.kind === 'response') {
    const waiter = pending.get(message.id); pending.delete(message.id)
    if (message.error) waiter?.reject(Error(message.error)); else waiter?.resolve(message.value)
    return
  }
  if (message.kind !== 'start') return
  const host = { stop: new AbortController(), handles: new Map(), execution: {
    host: message.home, profiles: { binding: () => undefined }, client: {
      call(path, body) { return new Promise((resolve, reject) => {
        const id = ++sequence; pending.set(id, { resolve, reject }); process.send({ kind: 'request', id, path, body })
      }) },
    },
  } }
  host.closeCoordinator = input => closeCoordinator(host, input)
  const service = new CoordinatorCloseRecovery(host)
  try {
    const results = await service.scan()
    process.send({ kind: 'done', results, handles: host.handles.size })
  } catch (error) { process.send({ kind: 'failed', error: error.message }) }
  finally { await service.close(); process.disconnect() }
})
