import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

async function loadSqlite() {
  try {
    const mod = await import('node:sqlite')
    return typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null
  } catch {
    return null
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function withFileLock(data, operation, { onWait, waitMs = 480_000 } = {}) {
  const lockPath = join(data, 'install.lock')
  const deadline = performance.now() + waitMs
  let handle = null
  let waiting = false
  for (;;) {
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }) + '\n')
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const raw = await readFile(lockPath, 'utf8')
        const parsed = JSON.parse(raw)
        if (!isPidAlive(parsed?.pid)) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // Lock file is being created or unreadable; wait and retry unless expired.
      }
      if (performance.now() >= deadline) {
        throw new Error('另一个 Kode 进程仍在安装 dsh，请等它结束后重试', { cause: error })
      }
      if (!waiting) onWait?.()
      waiting = true
      await setTimeout(250)
    }
  }
  try {
    return await operation()
  } finally {
    await handle?.close().catch(() => {})
    await unlink(lockPath).catch(() => {})
  }
}

// SQLite holds the writer lock at the OS level, so an interrupted launcher
// cannot leave an installation lock that future launches have to remove.
// On older Node.js releases without `node:sqlite` (< 22.5), fall back to an
// atomic PID lockfile so the launcher can still bootstrap fallbackNode.
export async function withInstallLock(data, operation, { onWait, waitMs = 480_000 } = {}) {
  await mkdir(data, { recursive: true })
  const DatabaseSync = await loadSqlite()
  if (!DatabaseSync) {
    return withFileLock(data, operation, { onWait, waitMs })
  }
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
