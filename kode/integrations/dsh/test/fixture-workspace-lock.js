import { WorkspaceLocks } from '../src/workspace-locks.js'
const [directory, root] = process.argv.slice(2)
try {
  const lease = await new WorkspaceLocks(directory).acquire(root, 'fixture-child')
  process.send?.({ event: 'locked', key: lease.key })
  process.on('message', async message => {
    if (message === 'release') { await lease.release(); process.exit(0) }
  })
} catch (error) { process.send?.({ event: error.code === 'WORKSPACE_BUSY' ? 'busy' : 'failed' }); process.exit(1) }
