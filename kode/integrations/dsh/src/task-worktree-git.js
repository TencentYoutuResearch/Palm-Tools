/** Git plumbing only: no checkout filters, hooks, remote fetches or user config discovery. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, writeFile, lstat, readFile, readlink, symlink, realpath } from 'node:fs/promises'
import { join } from 'node:path'
const execute = promisify(execFile), maximum = 128 * 1024 * 1024
export async function taskGit(root, args, { input, binary = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' })
  try {
    const pending = execute('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
      env, encoding: binary ? 'buffer' : 'utf8', timeout: 60000, maxBuffer: maximum + 2 * 1024 * 1024,
    })
    if (input !== undefined) { pending.child.stdin.on('error', () => {}); pending.child.stdin.end(input) }
    const result = (await pending).stdout
    return binary ? result : result.trim()
  } catch { throw new Error('Task worktree Git operation failed; the original workspace was preserved') }
}
async function parent(root, parts) {
  let path = root
  for (const part of parts) {
    path = join(path, part)
    await mkdir(path, { mode: 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw Error('Unsafe task base directory')
  }
}
/** Materialize raw tree blobs, never Git's smudge/process filters. Only planned, unadmitted checkouts call this. */
async function readTaskBase(root, base) {
  const listing = await taskGit(root, ['ls-tree', '-r', '-z', '--full-tree', base], { binary: true })
  const text = new TextDecoder('utf-8', { fatal: true }).decode(listing)
  const entries = text.split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/.exec(line)
    if (!match) throw Error('Task worktree requires ordinary files and no submodules')
    const [, mode, object, path] = match
    if (Buffer.byteLength(path) > 4096 || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw Error('Unsafe task base path')
    return { mode, object, path }
  })
  if (entries.length > 10000) throw Error('Task worktree base file limit exceeded')
  if (!entries.length) return []
  const objects = await taskGit(root, ['cat-file', '--batch'], { input: entries.map(entry => entry.object).join('\n') + '\n', binary: true })
  let offset = 0, total = 0
  for (const entry of entries) {
    const newline = objects.indexOf(10, offset)
    const header = /^([a-f0-9]+) blob (0|[1-9][0-9]*)$/.exec(objects.subarray(offset, newline).toString('ascii'))
    const size = Number(header?.[2])
    if (newline < offset || !header || header[1] !== entry.object || !Number.isSafeInteger(size) || size < 0 || (total += size) > maximum) throw Error('Invalid task base blob')
    offset = newline + 1
    const content = objects.subarray(offset, offset + size)
    if (content.length !== size || objects[offset + size] !== 10) throw Error('Incomplete task base blob')
    offset += size + 1
    entry.content = content
  }
  if (offset !== objects.length) throw Error('Unexpected task base blob suffix')
  return entries
}
export async function taskBaseTreeHash(root, base) {
  const manifest = (await readTaskBase(root, base)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(entry => [entry.path, entry.mode === '120000' ? 'symlink' : entry.mode === '100755' ? 'executable' : 'file', createHash('sha256').update(entry.content).digest('hex')])
  return createHash('sha256').update(`kode.workspace.manifest.v1\n${JSON.stringify(manifest)}`).digest('hex')
}
export async function materializeTaskBase(root, base) {
  for (const entry of await readTaskBase(root, base)) {
    const content = entry.content
    await parent(root, entry.path.split('/').slice(0, -1))
    const target = join(root, entry.path)
    let stat
    try { stat = await lstat(target) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (entry.mode === '120000') {
      const link = new TextDecoder('utf-8', { fatal: true }).decode(content)
      if (stat ? !stat.isSymbolicLink() || await readlink(target) !== link : false) throw Error('Task base symlink changed before readiness')
      if (!stat) await symlink(link, target)
    } else {
      if (stat && (!stat.isFile() || stat.nlink !== 1 || !(await readFile(target)).equals(content)
          || !!(stat.mode & 0o111) !== (entry.mode === '100755'))) throw Error('Task base file changed before readiness')
      if (!stat) await writeFile(target, content, { mode: entry.mode === '100755' ? 0o755 : 0o644, flag: 'wx' })
    }
  }
  await taskGit(root, ['read-tree', base])
}
