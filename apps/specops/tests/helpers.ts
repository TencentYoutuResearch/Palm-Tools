import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export async function gitWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'specops-test-'))
  await execFile('git', ['init', '-q', workspace])
  await execFile('git', ['-C', workspace, 'config', 'user.email', 'specops@example.test'])
  await execFile('git', ['-C', workspace, 'config', 'user.name', 'SpecOps Test'])
  return workspace
}

export async function gitCommit(workspace: string, message: string, file = 'change.txt'): Promise<string> {
  await writeFile(path.join(workspace, file), `${message}\n${Date.now()}\n`)
  await execFile('git', ['-C', workspace, 'add', '.'])
  await execFile('git', ['-C', workspace, 'commit', '-q', '-m', message])
  const { stdout } = await execFile('git', ['-C', workspace, 'rev-parse', 'HEAD'])
  return stdout.trim()
}

/** Run a git command in the given workspace and return trimmed stdout. */
export async function git(workspace: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', workspace, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return stdout.trim()
}
