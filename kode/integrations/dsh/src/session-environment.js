/** Read the selected session's checkout on its owning Host without resuming an Agent. */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { admitHostRequest } from './host-admission.js'

const execute = promisify(execFile)
const checkoutOverrides = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']

async function checkout(cwd, signal) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const key of checkoutOverrides) delete env[key]
  const git = async (...args) => {
    const { stdout } = await execute('git', ['-C', cwd, ...args], { env, signal, timeout: 2500, maxBuffer: 16 * 1024, windowsHide: true })
    return stdout.replace(/\r?\n$/, '')
  }
  try {
    const gitInfo = await git('rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir')
    const [root, gitDir, commonDir, ...extra] = gitInfo.split(/\r?\n/)
    if (!isAbsolute(root) || !gitDir || !commonDir || extra.length) return null
    const kind = resolve(cwd, gitDir) === resolve(cwd, commonDir) ? 'primary' : 'worktree'
    let branch = null, commit = null
    try { branch = (await git('symbolic-ref', '--quiet', 'HEAD')).replace(/^refs\/heads\//, '') || null }
    catch (error) { if (error.code !== 1) throw error }
    if (!branch) {
      commit = await git('rev-parse', '--verify', 'HEAD^{commit}')
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) return null
    }
    return { root, branch, commit, kind }
  } catch {
    signal.throwIfAborted()
    return null // Non-Git, missing Git, inaccessible or outdated metadata.
  }
}

const directory = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0') ? value : null

async function sessionDirectory(ctx, id, signal) {
  const live = ctx.get('sessions')?.get(id) ?? ctx.get('agents')?.get(id)?.session
  if (live) {
    const projected = ctx.get('sessionProjections')?.snapshot?.(live, ['workingDirectory'])?.values?.workingDirectory
    return directory(projected) ?? directory(live.header?.cwd)
  }
  const query = ctx.get('sessionQuery')
  if (typeof query?.observeSession === 'function') {
    try {
      const snapshot = await query.observeSession(id, { signal, projectionMode: 'none' })
      try {
        // Only host-confirmed workspace changes move the working directory.
        const moved = snapshot.events.findLast(event => event.type === 'workspace-root/change')
        return directory(moved?.data?.cwd) ?? directory(snapshot.header?.cwd)
      } finally { snapshot[Symbol.dispose]() }
    } catch (error) {
      if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
      throw error
    }
  }
  const controller = ctx.get('sessionController')
  if (!controller) throw new Error('Session service is not ready')
  const { items } = await controller.list({}, signal)
  const row = items.find(item => item.sessionId === id)
  return row ? directory(row.projections?.values?.workingDirectory) ?? directory(row.cwd) : undefined
}

export function registerSessionEnvironment(ctx) {
  return ctx.webServer.register({ kind: 'exact', path: '/api/kode/session-environment', handler: async (req, res, peer) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
    const admitted = admitHostRequest(ctx, req, peer)
    if ('rejection' in admitted || admitted.peer.principal.kind !== 'owner') return send(403, { error: 'Host owner required' })
    if (req.method !== 'GET') return send(405, { error: 'GET required' })
    const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId')
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)) return send(400, { error: 'Session identifier required' })
    const closed = new AbortController()
    res.once?.('close', () => closed.abort())
    const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(5500)])
    try {
      const cwd = await sessionDirectory(ctx, id, signal)
      if (cwd === undefined) return send(404, { error: 'Session not found on this Host' })
      const path = cwd ? await realpath(cwd).catch(() => null) : null
      signal.throwIfAborted()
      const git = path ? await checkout(path, signal) : null
      return send(200, { cwd, git })
    } catch {
      if (!closed.signal.aborted) return send(503, { error: 'Session environment unavailable' })
    }
  } })
}
