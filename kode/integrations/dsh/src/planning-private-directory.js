/** A neutral CLI cwd under the existing local application-data root.
 * This is not a filesystem sandbox or an execution-workspace grant. Native
 * tools retain their existing approval policy; no project permission is copied.
 */
import { createHash } from 'node:crypto'
import { mkdir, lstat, realpath, open } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
const fail = (code, message) => Object.assign(Error(message), { code })
const privateDirectory = async path => {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777n) !== 0o700n
    || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())
    || await realpath(path) !== path) throw fail('PLANNING_DIRECTORY_CHANGED', 'Private planning directory identity or permissions changed')
  return info
}
async function paths(profilesPath, home, draftId, sessionId) {
  if (typeof profilesPath !== 'string' || !isAbsolute(profilesPath)) throw fail('PLANNING_DIRECTORY_UNAVAILABLE', 'Local application-data root is unavailable')
  const base = await realpath(dirname(profilesPath)), info = await lstat(base, { bigint: true })
  if (!info.isDirectory() || (info.mode & 0o022n) !== 0n
    || typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) throw fail('PLANNING_DIRECTORY_UNAVAILABLE', 'Local application-data root is not owner-controlled')
  const root = join(base, 'planning-sessions')
  const digest = createHash('sha256').update(JSON.stringify([home, draftId, sessionId])).digest('hex')
  return { root, cwd: join(root, digest) }
}
export async function createPrivatePlanningLocation({ profilesPath, home, draftId, sessionId }) {
  try {
    const { root, cwd } = await paths(profilesPath, home, draftId, sessionId)
    try { await mkdir(root, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    await privateDirectory(root)
    // A new server session identity must get an empty new directory, never
    // adopt an existing path even when its spelling looks appropriate.
    await mkdir(cwd, { mode: 0o700 })
    const info = await privateDirectory(cwd)
    const handle = await open(root, 'r')
    try { await handle.sync() } finally { await handle.close() }
    return { workspace_id: null, cwd, location: { kind: 'private_planning', device: String(info.dev), inode: String(info.ino) } }
  } catch (error) {
    if (error.code?.startsWith('PLANNING_DIRECTORY_')) throw error
    throw fail('PLANNING_DIRECTORY_UNAVAILABLE', 'Private planning directory could not be created; no project or home fallback was used')
  }
}
export async function assertPrivatePlanningLocation(binding, profilesPath) {
  try {
    const { root, cwd } = await paths(profilesPath, binding.home_hub, binding.draft_id, binding.session_id)
    if (binding.workspace_id !== null || binding.location?.kind !== 'private_planning' || binding.cwd !== cwd) throw fail('PLANNING_DIRECTORY_CHANGED', 'Private planning directory binding changed')
    await privateDirectory(root)
    const info = await privateDirectory(cwd)
    if (binding.location.device !== String(info.dev) || binding.location.inode !== String(info.ino)) throw fail('PLANNING_DIRECTORY_CHANGED', 'Private planning directory was replaced')
    return cwd
  } catch (error) {
    if (error.code?.startsWith('PLANNING_DIRECTORY_')) throw error
    throw fail('PLANNING_DIRECTORY_CHANGED', 'Private planning directory is missing or unavailable; it was not recreated')
  }
}
