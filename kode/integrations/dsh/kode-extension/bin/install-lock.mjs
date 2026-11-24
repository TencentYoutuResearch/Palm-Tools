import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout } from 'node:timers/promises'

// SQLite holds the writer lock at the OS level, so an interrupted launcher
// cannot leave an installation lock that future launches have to remove.
export async function withInstallLock(data, operation, { onWait, waitMs = 480_000 } = {}) {
  await mkdir(data, { recursive: true })
  const db = new DatabaseSync(join(data, 'install.sqlite'))
  const deadline = performance.now() + waitMs
  try {
    let waiting = false
    for (;;) {
      try {
        db.exec('BEGIN IMMEDIATE')
        break
      } catch (error) {
        if (error.errcode !== 5) throw error // SQLITE_BUSY
        if (performance.now() >= deadline) {
          throw new Error('另一个 Kode 进程仍在安装 dsh，请等它结束后重试', { cause: error })
        }
        if (!waiting) onWait?.()
        waiting = true
        await setTimeout(250)
      }
    }
    return await operation()
  } finally {
    db.close()
  }
}
