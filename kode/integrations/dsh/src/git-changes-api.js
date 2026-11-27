/**
 * Owner-only Git Source Control API for the DSH right-sidebar Git Changes plugin.
 * Inspects status, per-file numstat, unified diffs, recent commits, and runs
 * explicit stage / unstage / discard actions inside the session's Git checkout.
 */
import { execFile } from 'node:child_process'
import { readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { admitHostRequest } from './host-admission.js'
import { sessionDirectory } from './session-environment.js'

const execute = promisify(execFile)
const GIT_OVERRIDE_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM']
const MAX_DIFF_BYTES = 256 * 1024
const MAX_BODY_BYTES = 32 * 1024

function cleanGitEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  for (const key of GIT_OVERRIDE_VARS) delete env[key]
  return env
}

function makeGit(cwd, signal, { exec = execute } = {}) {
  const env = cleanGitEnv()
  return async (args, { maxBuffer = 2 * 1024 * 1024, timeout = 8000 } = {}) => {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { env, signal, timeout, maxBuffer, windowsHide: true })
    return stdout
  }
}

export function validateRepoRelativePath(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.replace(/\\/g, '/').trim()
  if (!trimmed || trimmed.length > 1024 || trimmed.includes('\0') || trimmed.startsWith('/') || trimmed.startsWith('-')) return null
  const parts = trimmed.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

/** Parse `git diff --numstat -z` output into a Map<path, { added, removed, binary }>. */
export function parseNumstatZ(output) {
  const map = new Map()
  if (!output) return map
  const tokens = output.split('\0')
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token) { i += 1; continue }
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(token)
    if (!match) { i += 1; continue }
    const binary = match[1] === '-' || match[2] === '-'
    const added = binary ? 0 : Number(match[1])
    const removed = binary ? 0 : Number(match[2])
    let filePath = match[3]
    if (filePath === '') {
      // Rename/copy entry in -z mode: `added\tremoved\t\0oldPath\0newPath\0`
      filePath = tokens[i + 2] ?? tokens[i + 1] ?? ''
      i += 3
    } else {
      i += 1
    }
    if (filePath) map.set(filePath, { added, removed, binary })
  }
  return map
}

/** Parse `git status --porcelain=v1 -z -uall` into { staged, unstaged, untracked }. */
export function parsePorcelainZ(output, stagedStats = new Map(), unstagedStats = new Map()) {
  const staged = []
  const unstaged = []
  const untracked = []
  if (!output) return { staged, unstaged, untracked }
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry || entry.length < 4) continue
    const x = entry[0], y = entry[1]
    const path = entry.slice(3)
    if (!path) continue
    if (x === '?' && y === '?') {
      untracked.push({ path, status: 'U', scope: 'untracked', added: 0, removed: 0, binary: false })
      continue
    }
    let origPath
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      origPath = entries[i + 1] || undefined
      i += 1
    }
    if (x !== ' ' && x !== '?') {
      const statInfo = stagedStats.get(path) ?? { added: 0, removed: 0, binary: false }
      staged.push({
        path,
        ...(origPath ? { origPath } : {}),
        status: x,
        scope: 'staged',
        ...statInfo,
      })
    }
    if (y !== ' ' && y !== '?') {
      const statInfo = unstagedStats.get(path) ?? { added: 0, removed: 0, binary: false }
      unstaged.push({
        path,
        ...(origPath ? { origPath } : {}),
        status: y,
        scope: 'unstaged',
        ...statInfo,
      })
    }
  }
  return { staged, unstaged, untracked }
}

function cleanDecorationLabel(raw) {
  const label = String(raw ?? '').trim()
  if (!label) return null
  if (label.startsWith('refs/heads/')) return label.slice('refs/heads/'.length)
  if (label.startsWith('refs/remotes/')) return label.slice('refs/remotes/'.length)
  if (label.startsWith('tag: refs/tags/')) return `tag: ${label.slice('tag: refs/tags/'.length)}`
  if (label.startsWith('refs/tags/')) return `tag: ${label.slice('refs/tags/'.length)}`
  return label
}

export function parseCommitDecorations(raw) {
  const labels = []
  for (const part of String(raw ?? '').split(',')) {
    const label = part.trim().replace(/^\(+/, '').replace(/\)+$/, '').trim()
    if (!label) continue
    if (label.startsWith('HEAD -> ')) {
      labels.push('HEAD')
      const cleaned = cleanDecorationLabel(label.slice('HEAD -> '.length))
      if (cleaned) labels.push(cleaned)
    } else {
      const cleaned = cleanDecorationLabel(label)
      if (cleaned) labels.push(cleaned)
    }
  }
  return labels
}

export function parseCommits(output) {
  if (!output) return []
  return output.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\x1f')
    const hash = (parts[0] ?? '').trim()
    const shortHash = (parts[1] ?? '').trim()
    const author = (parts[2] ?? '').trim()
    const timestampSecs = Number(parts[3]) || 0
    const relativeTime = (parts[4] ?? '').trim()
    const subject = (parts[5] ?? '').trim()
    const parents = (parts[6] ?? '').trim().split(/\s+/).filter(Boolean)
    const decorations = parseCommitDecorations(parts.slice(7).join('\x1f'))
    return { hash, shortHash, author, timestampSecs, relativeTime, subject, parents, decorations }
  }).filter(row => row.hash)
}

export function parseNameStatusZ(output, numstats = new Map()) {
  if (!output) return []
  const tokens = output.split('\0')
  const files = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i]
    if (!code) { i += 1; continue }
    const status = code[0]
    if (status === 'R' || status === 'C') {
      const origPath = tokens[i + 1] ?? ''
      const path = tokens[i + 2] ?? ''
      i += 3
      if (path) files.push({ path, origPath, status, ...(numstats.get(path) ?? { added: 0, removed: 0, binary: false }) })
    } else {
      const path = tokens[i + 1] ?? ''
      i += 2
      if (path) files.push({ path, status, ...(numstats.get(path) ?? { added: 0, removed: 0, binary: false }) })
    }
  }
  return files
}

function insideRoot(root, target) {
  const rel = relative(root, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')
}

async function resolveCheckout(cwd, signal, deps) {
  const git = makeGit(cwd, signal, deps)
  try {
    const info = (await git(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'])).replace(/\r?\n$/, '')
    const [root, gitDir, commonDir, ...extra] = info.split(/\r?\n/)
    if (!isAbsolute(root) || !gitDir || !commonDir || extra.length) return null
    const kind = resolve(cwd, gitDir) === resolve(cwd, commonDir) ? 'primary' : 'worktree'
    let branch = null, commit = null, upstream = null, ahead = 0, behind = 0
    try {
      branch = (await git(['symbolic-ref', '--quiet', 'HEAD'])).trim().replace(/^refs\/heads\//, '') || null
    } catch (error) {
      if (error.code !== 1) throw error
    }
    try {
      commit = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
    } catch {
      commit = null
    }
    if (branch) {
      try {
        upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim() || null
        if (upstream) {
          const counts = (await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim().split(/\s+/)
          behind = Number(counts[0]) || 0
          ahead = Number(counts[1]) || 0
        }
      } catch {
        upstream = null
      }
    }
    return { root, branch, commit, upstream, ahead, behind, kind }
  } catch {
    signal?.throwIfAborted?.()
    return null
  }
}

export async function readGitStatus(cwd, signal, deps = {}) {
  const gitInfo = await resolveCheckout(cwd, signal, deps)
  if (!gitInfo) return { cwd, git: null, staged: [], unstaged: [], untracked: [], commits: [] }
  const git = makeGit(gitInfo.root, signal, deps)
  const [porcelain, stagedNumstat, unstagedNumstat, logText] = await Promise.all([
    git(['status', '--porcelain=v1', '-z', '-uall']),
    git(['diff', '--cached', '--numstat', '-z']).catch(() => ''),
    git(['diff', '--numstat', '-z']).catch(() => ''),
    git(['log', '--all', '-n', '40', '--date=unix', '--decorate=full', '--format=%H%x1f%h%x1f%an%x1f%ct%x1f%ar%x1f%s%x1f%P%x1f%D']).catch(() => ''),
  ])
  const parsed = parsePorcelainZ(porcelain, parseNumstatZ(stagedNumstat), parseNumstatZ(unstagedNumstat))
  return {
    cwd,
    git: gitInfo,
    ...parsed,
    commits: parseCommits(logText),
  }
}

export async function readCommitDetail(cwd, commit, signal, deps = {}) {
  const gitInfo = await resolveCheckout(cwd, signal, deps)
  if (!gitInfo) throw new Error('当前工作区不是 Git 仓库')
  if (!/^[a-f0-9]{7,40}$/i.test(String(commit ?? ''))) throw new Error('无效的提交哈希')
  const git = makeGit(gitInfo.root, signal, deps)
  const [message, nameStatus, numstat] = await Promise.all([
    git(['show', '--no-patch', '--format=%B', commit]),
    git(['diff-tree', '--no-commit-id', '--name-status', '-r', '-m', '--first-parent', '--root', '-z', commit]).catch(() => ''),
    git(['diff-tree', '--no-commit-id', '--numstat', '-r', '-m', '--first-parent', '--root', '-z', commit]).catch(() => ''),
  ])
  return {
    hash: commit,
    message: message.trimEnd(),
    files: parseNameStatusZ(nameStatus, parseNumstatZ(numstat)),
  }
}

export async function readGitDiff(cwd, { path, scope = 'unstaged', commit }, signal, deps = {}) {
  const gitInfo = await resolveCheckout(cwd, signal, deps)
  if (!gitInfo) throw new Error('当前工作区不是 Git 仓库')
  const git = makeGit(gitInfo.root, signal, deps)
  if (commit) {
    if (!/^[a-f0-9]{7,40}$/i.test(commit)) throw new Error('无效的提交哈希')
    const relPath = path ? validateRepoRelativePath(path) : null
    if (path && !relPath) throw new Error('无效的文件路径')
    const args = relPath
      ? ['show', '--patch', '--no-color', '--first-parent', commit, '--', relPath]
      : ['show', '--stat', '--patch', '--no-color', '--first-parent', commit]
    const raw = await git(args, { maxBuffer: 4 * 1024 * 1024 })
    const binary = /^Binary files .* differ$/m.test(raw)
    const truncated = Buffer.byteLength(raw, 'utf8') > MAX_DIFF_BYTES
    const diff = truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw
    return { commit, ...(relPath ? { path: relPath } : {}), scope: 'commit', diff, binary, truncated }
  }
  const relPath = validateRepoRelativePath(path)
  if (!relPath) throw new Error('无效的文件路径')
  if (scope === 'untracked') {
    const abs = resolve(gitInfo.root, relPath)
    if (!insideRoot(gitInfo.root, abs)) throw new Error('路径超出仓库范围')
    const realRoot = await realpath(gitInfo.root)
    const realTarget = await realpath(abs)
    if (!insideRoot(realRoot, realTarget)) throw new Error('路径超出仓库范围')
    const info = await stat(realTarget)
    if (!info.isFile()) return { path: relPath, scope, diff: '', binary: false, truncated: false }
    const buf = await readFile(realTarget)
    const sample = buf.subarray(0, Math.min(buf.length, 4096))
    if (sample.includes(0)) return { path: relPath, scope, diff: '', binary: true, truncated: false }
    const truncated = buf.length > MAX_DIFF_BYTES
    const text = (truncated ? buf.subarray(0, MAX_DIFF_BYTES) : buf).toString('utf8')
    const lines = text.split('\n')
    if (lines.length > 1 && lines.at(-1) === '') lines.pop()
    const diff = [
      `--- /dev/null`,
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map(line => `+${line}`),
    ].join('\n')
    return { path: relPath, scope, diff, binary: false, truncated }
  }
  const args = scope === 'staged'
    ? ['diff', '--cached', '--no-color', '--unified=3', '--', relPath]
    : ['diff', '--no-color', '--unified=3', '--', relPath]
  const raw = await git(args, { maxBuffer: 4 * 1024 * 1024 })
  const binary = /^Binary files .* differ$/m.test(raw)
  const truncated = Buffer.byteLength(raw, 'utf8') > MAX_DIFF_BYTES
  const diff = truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw
  return { path: relPath, scope, diff, binary, truncated }
}

export async function applyGitAction(cwd, { action, path, all = false, scope = 'unstaged' }, signal, deps = {}) {
  const gitInfo = await resolveCheckout(cwd, signal, deps)
  if (!gitInfo) throw new Error('当前工作区不是 Git 仓库')
  const git = makeGit(gitInfo.root, signal, deps)
  if (action === 'stage') {
    if (all) {
      await git(['add', '-A'])
    } else {
      const relPath = validateRepoRelativePath(path)
      if (!relPath) throw new Error('无效的文件路径')
      await git(['add', '--', relPath])
    }
    return readGitStatus(cwd, signal, deps)
  }
  if (action === 'unstage') {
    if (all) {
      try { await git(['reset', 'HEAD']) } catch { await git(['rm', '-r', '--cached', '.']).catch(() => {}) }
    } else {
      const relPath = validateRepoRelativePath(path)
      if (!relPath) throw new Error('无效的文件路径')
      try { await git(['reset', 'HEAD', '--', relPath]) } catch { await git(['rm', '--cached', '--', relPath]) }
    }
    return readGitStatus(cwd, signal, deps)
  }
  if (action === 'discard') {
    const relPath = validateRepoRelativePath(path)
    if (!relPath) throw new Error('无效的文件路径')
    if (scope === 'untracked') {
      const status = await git(['status', '--porcelain=v1', '-z', '--', relPath])
      const entry = status.split('\0')[0] ?? ''
      if (!entry.startsWith('?? ')) throw new Error('只能删除未跟踪的新文件')
      const abs = resolve(gitInfo.root, relPath)
      const realRoot = await realpath(gitInfo.root)
      const realTarget = await realpath(abs)
      if (!insideRoot(realRoot, realTarget)) throw new Error('路径超出仓库范围')
      await rm(realTarget, { force: true })
    } else {
      await git(['checkout', '--', relPath])
    }
    return readGitStatus(cwd, signal, deps)
  }
  throw new Error('未知的 Git 操作')
}

export function registerGitChangesApi(ctx, deps = {}) {
  return ctx.webServer.register({
    kind: 'exact',
    path: '/api/kode/git-changes',
    handler: async (req, res, peer) => {
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      const admitted = admitHostRequest(ctx, req, peer)
      if ('rejection' in admitted || admitted.peer?.principal?.kind !== 'owner') return send(403, { error: 'Host owner required' })
      const closed = new AbortController()
      res.once?.('close', () => closed.abort())
      const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(10_000)])
      try {
        if (req.method === 'GET') {
          const params = new URL(req.url, 'http://localhost').searchParams
          const id = params.get('sessionId')
          if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)) return send(400, { error: 'Session identifier required' })
          const cwd = await sessionDirectory(ctx, id, signal)
          if (cwd === undefined) return send(404, { error: 'Session not found on this Host' })
          const path = cwd ? await realpath(cwd).catch(() => null) : null
          signal.throwIfAborted()
          if (!path) return send(200, { cwd, git: null, staged: [], unstaged: [], untracked: [], commits: [] })
          if (params.get('commitDetail')) {
            return send(200, await readCommitDetail(path, params.get('commitDetail'), signal, deps))
          }
          if (params.get('diff') === '1') {
            const result = await readGitDiff(path, {
              path: params.get('path') ?? undefined,
              scope: params.get('scope') || 'unstaged',
              commit: params.get('commit') ?? undefined,
            }, signal, deps)
            return send(200, result)
          }
          return send(200, await readGitStatus(path, signal, deps))
        }
        if (req.method === 'POST') {
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (Buffer.byteLength(body) > MAX_BODY_BYTES) return send(413, { error: 'Request too large' })
          }
          const input = JSON.parse(body)
          const id = input?.sessionId
          if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)) return send(400, { error: 'Session identifier required' })
          const cwd = await sessionDirectory(ctx, id, signal)
          if (cwd === undefined) return send(404, { error: 'Session not found on this Host' })
          const path = cwd ? await realpath(cwd).catch(() => null) : null
          if (!path) return send(400, { error: '工作区目录不可用' })
          const result = await applyGitAction(path, input, signal, deps)
          return send(200, result)
        }
        return send(405, { error: 'GET or POST required' })
      } catch (error) {
        if (!closed.signal.aborted) return send(400, { error: error.message || 'Git 变更接口暂不可用' })
      }
    },
  })
}
