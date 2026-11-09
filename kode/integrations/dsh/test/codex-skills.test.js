import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deduplicateSkillCopies } from '../src/codex-skills.js'

test('identical skill copies and symlinks collapse without changing the original advertised path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-skill-copies-'))
  try {
    const first = { name: 'team:analyse', path: join(root, 'first.md') }, second = { ...first, path: join(root, 'second.md') }, alias = { ...first, path: join(root, 'alias.md') }
    await Promise.all([writeFile(first.path, 'instructions'), writeFile(second.path, 'instructions')])
    await symlink(first.path, alias.path)
    const otherName = { ...first, name: 'team:review' }
    assert.deepEqual(await deduplicateSkillCopies([first, second, alias, otherName]), [first, otherName])
    await writeFile(second.path, 'changed instructions')
    assert.deepEqual(await deduplicateSkillCopies([first, second, alias]), [first, second], 'a reload must re-read updated files')
    const missing = { ...first, path: join(root, 'missing.md') }, another = { ...first, path: join(root, 'another-missing.md') }
    assert.deepEqual(await deduplicateSkillCopies([missing, another, missing]), [missing, another], 'unreadable different paths must not be silently merged')
  } finally { await rm(root, { recursive: true, force: true }) }
})
