/** Bridge Cursor CLI (`~/.cursor/chats/<md5(cwd)>/<id>`) and ACP (`~/.cursor/acp-sessions/<id>`) storage.
 *  Both modes use the same SQLite blob store (`store.db`), so linking the session directory keeps
 *  `store.db`, `-wal`, and `-shm` co-located across TUI ↔ dsh switches without diverging copies. */
import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9._-]+$/
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

export function cursorConfigDir(env = process.env) {
  if (env?.CURSOR_CONFIG_DIR?.trim()) return env.CURSOR_CONFIG_DIR.trim()
  if (env?.XDG_CONFIG_HOME?.trim()) return join(env.XDG_CONFIG_HOME.trim(), 'cursor')
  return join(homedir(), '.cursor')
}

export function cursorWorkspaceHash(cwd) {
  return createHash('md5').update(resolve(cwd)).digest('hex')
}

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

async function findCliChatDir(root, sessionId, cwd) {
  const chatsRoot = join(root, 'chats')
  if (cwd) {
    const direct = join(chatsRoot, cursorWorkspaceHash(cwd), sessionId)
    if (await exists(join(direct, 'store.db'))) return direct
  }
  let workspaces
  try { workspaces = await readdir(chatsRoot, { withFileTypes: true }) } catch { return undefined }
  for (const entry of workspaces) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const candidate = join(chatsRoot, entry.name, sessionId)
    if (await exists(join(candidate, 'store.db'))) return candidate
  }
  return undefined
}

/** Ensure `cursor-agent acp`'s `session/load` can find a session created by `cursor-agent` CLI. */
export async function ensureCursorAcpSession(sessionId, cwd, env = process.env) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId) || sessionId === '.' || sessionId === '..') return false
  const root = cursorConfigDir(env)
  const acpDir = join(root, 'acp-sessions', sessionId)
  if (await exists(join(acpDir, 'store.db'))) return true
  const chatDir = await findCliChatDir(root, sessionId, cwd)
  if (!chatDir) return false
  await mkdir(dirname(acpDir), { recursive: true })
  try {
    await lstat(acpDir)
    // Remove an empty/meta-only probe directory (no store.db) before linking.
    await rm(acpDir, { recursive: true, force: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try {
    await symlink(chatDir, acpDir, SYMLINK_TYPE)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return true
}

/** Ensure `cursor-agent --resume` in TUI can find a session created by `cursor-agent acp`. */
export async function ensureCursorCliChat(sessionId, cwd, env = process.env) {
  if (typeof sessionId !== 'string' || !SAFE_ID.test(sessionId) || sessionId === '.' || sessionId === '..' || !cwd) return false
  const root = cursorConfigDir(env)
  const acpDir = join(root, 'acp-sessions', sessionId)
  if (!(await exists(join(acpDir, 'store.db')))) return false
  if (await findCliChatDir(root, sessionId, cwd)) return true
  const chatDir = join(root, 'chats', cursorWorkspaceHash(cwd), sessionId)
  await mkdir(dirname(chatDir), { recursive: true })
  try {
    await lstat(chatDir)
    await rm(chatDir, { recursive: true, force: true })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try {
    await symlink(acpDir, chatDir, SYMLINK_TYPE)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return true
}
