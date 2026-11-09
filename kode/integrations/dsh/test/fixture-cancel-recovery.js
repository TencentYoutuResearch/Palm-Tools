/** Fresh process restores only cancellation control; it must never construct a Worker. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BackendClient } from '../src/backend-client.js'
import { AgentProfiles } from '../src/agent-profiles.js'
import { AssignmentDispatchHost } from '../src/assignment-dispatch-host.js'
import { WorkRunController } from '../src/work-run-controller.js'
import { RemoteAssignmentService } from '../src/remote-assignment-service.js'
import { WorkRunService } from '../src/work-run-service.js'
const [root, url, node, topology] = process.argv.slice(2)
let service, dispatcher
try {
  const client = new BackendClient(url, (await readFile(join(root, 'admin.token'), 'utf8')).trim())
  const profiles = await new AgentProfiles(join(root, 'profiles.json')).open()
  const host = { execution: { host: node, profiles, client }, stop: new AbortController(), handles: new Map() }
  dispatcher = new AssignmentDispatchHost(host)
  let result
  if (topology === 'remote') {
    service = new RemoteAssignmentService(dispatcher)
    const rows = await service.scan()
    result = rows[0] ?? { state: 'acknowledged' }
    if (!rows.length && !Object.values(profiles.bindings).some(row => row.remoteLifecycle?.phase === 'acknowledged')) throw new Error('Missing remote recovery evidence')
  } else {
    const controller = new WorkRunController(dispatcher, { prepare() { throw new Error('Recovery must not create execution') } })
    let resolve
    const observed = new Promise(done => { resolve = done })
    service = await new WorkRunService(controller, { intervalMs: 100, onState: value => resolve(value) }).open()
    service.start()
    result = await observed
  }
  await service.close(); await dispatcher.close()
  process.send({ type: 'recovered', state: result.state, handles: host.handles.size }, () => process.disconnect())
} catch {
  await service?.close().catch(() => {}); await dispatcher?.close().catch(() => {})
  process.send({ type: 'failed' }, () => process.disconnect())
}
