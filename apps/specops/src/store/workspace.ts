import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { SpecOpsError } from '../core/errors.js'

const execFile = promisify(execFileCallback)

export async function resolveGitWorkspace(input: string): Promise<string> {
  const absolute = path.resolve(input)
  let canonical: string
  try {
    canonical = await realpath(absolute)
  } catch {
    throw new SpecOpsError('workspace_not_found', `workspace does not exist: ${absolute}`)
  }
  try {
    const { stdout } = await execFile('git', ['-C', canonical, 'rev-parse', '--show-toplevel'])
    const root = (await realpath(stdout.trim())).trim()
    if (root !== canonical) {
      throw new SpecOpsError('workspace_not_root', `workspace must be the Git root: ${root}`)
    }
    return canonical
  } catch (error) {
    if (error instanceof SpecOpsError) throw error
    throw new SpecOpsError('not_git_workspace', `not a Git workspace: ${canonical}`)
  }
}

export function pathInside(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SpecOpsError('path_escape', `path escapes workspace: ${target}`)
  }
  return target
}

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, filePath)
}

export async function readText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8')
}

export async function listMarkdownFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const files: string[] = []
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new SpecOpsError('symlink_rejected', `symlinks are not allowed in canonical specs: ${candidate}`)
      }
      if (entry.isDirectory()) files.push(...await listMarkdownFiles(candidate))
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(candidate)
    }
    return files.sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(directory, entry.name))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
