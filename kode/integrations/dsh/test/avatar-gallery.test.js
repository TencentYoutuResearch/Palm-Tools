import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionAppearance } from '../src/session-appearance.js'

test('redrawn avatar frames get new URLs, so no view keeps a cached picture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kode-avatars-'))
  const idle = join(root, 'gallery', '01-kit', 'idle')
  await mkdir(idle, { recursive: true })
  await writeFile(join(idle, 'frame-01.png'), 'a')
  const appearance = new SessionAppearance({}, { list: () => [] }, { avatarDirectory: root })
  const [before] = await appearance.gallery()
  assert.match(before.url, /&state=idle&v=\d+-1$/)
  assert.match(before.animations.idle[0], /&frame=1&v=\d+-1$/)
  await writeFile(join(idle, 'frame-01.png'), 'redrawn')
  await utimes(join(idle, 'frame-01.png'), new Date(), new Date(Date.now() + 5000))
  const [after] = await appearance.gallery()
  assert.notEqual(after.url, before.url)
  assert.notEqual(after.animations.idle[0], before.animations.idle[0])
})
