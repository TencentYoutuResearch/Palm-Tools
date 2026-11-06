/** Known one-file baseline inside an owned temporary test directory only. */
import { mkdtemp, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export async function versionedProject(parent) {
  const root = await realpath(await mkdtemp(join(parent, 'project-')))
  await writeFile(join(root, 'README.md'), 'Isolated activation fixture\n', { flag: 'wx' })
  const git = args => promisify(execFile)('/usr/bin/git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' },
  })
  await git(['init', '-q']); await git(['add', '--', 'README.md']); await git(['commit', '-qm', 'fixture baseline'])
  return root
}
