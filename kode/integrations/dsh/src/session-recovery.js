/** Recover only recognized legacy JSONL failures, using the maintenance writer lock. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const worker = fileURLToPath(new URL('../scripts/repair-inbox-history.py', import.meta.url))
const recoverable = /system\/message requires a protected first surface head|invalid persisted inbox splice/
const installations = new WeakMap()

export function recoveryLocation(error, id) {
  if (error?.name !== 'SessionPersistenceCorruptionError' || !recoverable.test(error.message)) return
  const path = error.message.match(/\(raw log: (.+)\)$/)?.[1]
  if (!path || !id || basename(id) !== id || id === '.' || id === '..') return
  const directory = dirname(path), sessions = dirname(dirname(directory))
  if (basename(path) !== 'session.v4.jsonl.zstd' || basename(directory) !== id || basename(sessions) !== 'sessions' || resolve(path) !== path) return
  return { path, home: dirname(sessions) }
}

export async function repairStoredSession({ id, home, signal }) {
  // Resolve the same released reader used by this adapter, not a different
  // globally installed harness. The worker validates both relationships and Session.
  const modules = resolve(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-session'))), '../../..')
  const { stdout } = await run('python3', [worker, '--home', home, '--session-id', id,
    '--runtime-modules', modules, '--node', process.execPath, '--apply'],
  { signal, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout)
}

/** Install below both history queries and resume. Every failed open retries at most once. */
export function installSessionRecovery(ctx, { repair = repairStoredSession } = {}) {
  const storage = ctx.sessionPersistence
  const existing = installations.get(storage)
  if (existing) { existing.users++; return existing.release }
  const open = storage.open, pending = new Map()
  const state = { users: 1, release }
  const wrapped = async function(id, access, options) {
    try { return await open.call(this, id, access, options) }
    catch (original) {
      options?.signal?.throwIfAborted()
      const location = recoveryLocation(original, id)
      if (!location) throw original
      let task = pending.get(id)
      if (!task) {
        // Do not let one disconnected reader cancel a repair shared with others.
        task = Promise.resolve().then(() => repair({ id, ...location })).then(report => {
          if (report.applied) ctx.logger.warn('Kode repaired session %s; original log backup: %s', id, report.backup)
          return report
        }).finally(() => pending.delete(id))
        pending.set(id, task)
      }
      try { await task }
      catch (error) {
        ctx.logger.warn('Kode could not repair session %s: %s', id, error.message)
        throw original
      }
      options?.signal?.throwIfAborted()
      return open.call(this, id, access, options)
    }
  }
  function release() {
    if (--state.users) return
    if (storage.open === wrapped) storage.open = open
    installations.delete(storage)
  }
  storage.open = wrapped
  installations.set(storage, state)
  return release
}
