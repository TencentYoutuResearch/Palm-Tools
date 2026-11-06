/** Host-local cooperative exclusion. Every participant must use the same trusted lock directory.
 * No TTL takeover: a wedged writer retains ownership until it releases or its process dies.
 */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, realpath, open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, isAbsolute } from 'node:path'
let native
async function lockExclusive(fd) {
  native ??= (async () => {
    const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl'))
    return import(require.resolve('@deepseek-ai/node-addon-system/flock'))
  })()
  const { tryLockExclusive } = await native
  await tryLockExclusive(fd)
}
export class WorkspaceLocks {
  constructor(directory) {
    if (!isAbsolute(directory)) throw new Error('Absolute Host lock directory required')
    this.directory = directory
  }
  async acquire(workspaceRoot, owner, { signal } = {}) {
    signal?.throwIfAborted()
    if (process.platform === 'win32') throw new Error('Workspace kernel locks unavailable on this platform')
    if (!isAbsolute(workspaceRoot) || typeof owner !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(owner)) throw new Error('Explicit workspace lock identity required')
    const root = await realpath(workspaceRoot)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await realpath(this.directory)
    const key = createHash('sha256').update(`kode.workspace.lock.v1\n${root}`).digest('hex')
    const path = join(directory, `${key}.lock`)
    const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      try { await lockExclusive(file.fd) } catch (error) {
        if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw Object.assign(new Error('Workspace is already owned'), { code: 'WORKSPACE_BUSY' })
        throw error
      }
      const held = await file.stat({ bigint: true }), current = await lstat(path, { bigint: true })
      if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino) throw new Error('Workspace lock identity changed')
      signal?.throwIfAborted()
      let releasing
      return Object.freeze({ root, owner, key, release: () => (releasing ??= file.close()) })
    } catch (error) { await file.close(); throw error }
  }
  async withLock(workspaceRoot, owner, options, action) {
    const lease = await this.acquire(workspaceRoot, owner, options)
    try {
      options?.signal?.throwIfAborted()
      return await action(lease)
    } finally { await lease.release() }
  }
}
